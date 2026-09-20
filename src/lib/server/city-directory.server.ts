/**
 * CITY の静的データの読み込みと、Jev 候補・根拠表示への変換。
 *
 * 実行時にスクレイピングしない。公式ページの一時障害で判定結果が変わらず、
 * 回答と根拠データのバージョンを再現できるようにするため（docs/CITY_DATA.md §7）。
 */

import { env } from '$env/dynamic/private';
import type { CityDirectory, CityOrganizationUnit, CityResponsibility } from '$lib/types/city';
import type { CitySource } from '$lib/types/judge';

/**
 * 公開用の既定データセット。架空の自治体で、出典 URL を持たない。
 *
 * 既定値を架空版にしてあるのは fail-safe のため。`CITY_DIRECTORY` の
 * 設定漏れで実在の自治体データが公開されることがない。
 */
const DEFAULT_DIRECTORY = 'fictional-m-city';

/**
 * `data/city/` 配下の JSON を全て取り込み、名前で選ぶ。
 *
 * 実在の自治体データ（`local-*.json`）はリポジトリに含めないため、
 * 手元にファイルが無い環境でもビルドが通るよう glob で解決する。
 */
const files = import.meta.glob('../../../data/city/*.json', { eager: true }) as Record<
	string,
	{ default: CityDirectory }
>;

let cached: CityDirectory | null = null;

/**
 * データセットを読み込む。
 *
 * `$env/dynamic/private` はリクエスト処理が始まってから値が入るため、
 * モジュール読み込み時に評価すると常に既定値になる。最初の利用時まで
 * 遅延させ、以後はキャッシュする。
 */
function loadDirectory(): CityDirectory {
	if (cached) return cached;

	const name = env.CITY_DIRECTORY?.trim() || DEFAULT_DIRECTORY;
	const entry = Object.entries(files).find(([path]) => path.endsWith(`/${name}.json`));
	if (!entry) {
		const available = Object.keys(files)
			.map((path) => path.split('/').pop()?.replace('.json', ''))
			.join(', ');
		throw new Error(`CITY_DIRECTORY "${name}" が見つからない。利用可能: ${available}`);
	}

	cached = entry[1].default;
	return cached;
}

/** テスト用。読み込み済みのデータセットを捨てる。 */
export function resetDirectoryCache(): void {
	cached = null;
}

/** 架空データを使っているか。UI の注意表示に使う。 */
export function isFictional(): boolean {
	return loadDirectory().fictional === true;
}

/** 候補を絞り込めない場合のキー。route_to に必ず含める。 */
export const OTHER_OR_UNCLEAR = 'other_or_unclear';

export function getDirectory(): CityDirectory {
	return loadDirectory();
}

/** データのバージョン。`effectiveFrom` と `retrievedAt` を組にする。 */
export function directoryVersion(): string {
	const directory = loadDirectory();
	return `${directory.jurisdiction}-${directory.effectiveFrom}`;
}

export function jurisdictionName(): string {
	return loadDirectory().displayName;
}

function activeUnits(): CityOrganizationUnit[] {
	return loadDirectory().organizations.filter((unit) => unit.active);
}

export type RouteCandidate = {
	id: string;
	/** 画面に出す課・組織の名称。 */
	label: string;
	/** Jev へ渡す説明。 */
	description: string;
	units: CityOrganizationUnit[];
};

/**
 * `route_to` の候補を課レベルで組み立てる。
 *
 * 係で分割すると Choice の確率が係の数だけ割れ、課としての確度が下がる
 * （docs/CITY_DATA.md §5）。係の特定は Jev ではなくローカルの join で行う。
 */
export function routeCandidates(): RouteCandidate[] {
	const byCandidate = new Map<string, CityOrganizationUnit[]>();
	for (const unit of activeUnits()) {
		const list = byCandidate.get(unit.routingCandidateId) ?? [];
		list.push(unit);
		byCandidate.set(unit.routingCandidateId, list);
	}

	return [...byCandidate.entries()].map(([id, units]) => {
		const head = units[0];
		// 候補説明は publicSummary を主にし、長くなりすぎないよう切る。
		// state と最長の質問で 32k tokens の制限がある（docs/JEV_DESIGN.md §2）。
		const summary = head.publicSummary.slice(0, 220);
		const duties = representativeDuties(units);
		return {
			id,
			label: head.section,
			description:
				duties.length > 0
					? `${head.section}。${summary} 主な分掌: ${duties.join('、')}。`
					: `${head.section}。${summary}`,
			units
		};
	});
}

/**
 * どの課にも現れる定型の分掌。候補の区別に寄与しないため説明へ入れない。
 *
 * 実データでは「課の事務の調整及び課の庶務に関すること。」が20課、
 * 「部内の他課の所掌に属しない事務に関すること。」が5課に現れる。
 */
const BOILERPLATE = ['課の事務の調整', '部内の他課の所掌に属しない'];

/** 1候補あたりに含める分掌の上限。トークン量と精度の折り合い。 */
const MAX_DUTIES_PER_CANDIDATE = 12;

/**
 * 候補の区別に寄与しにくい語。これらだけで構成される分掌は後回しにする。
 *
 * 「企画及び調整」「計画」「総括」といった行政共通の抽象語は、どの課の
 * 説明にも現れるため、住民の問い合わせ文と結び付かない。一方で固有名詞や
 * 具体的な事物を含む分掌は、それ1件で候補を決められることがある。
 */
const GENERIC_DUTY =
	/^(市行政に関する)?[^、]{0,6}(企画及び調整|総合的な調整|計画|総括|統計|庶務|連絡調整|事務の調整)$/;

/**
 * 候補説明に載せる代表的な分掌事務。
 *
 * 組織ページの `publicSummary` だけでは、条文に明記された事務が Jev へ
 * 届かない。例えば政策企画課の市民向け説明には「サンフレッチェ広島応援
 * 事業」が現れず、実際にこの入力で政策企画課が上位に来なかった。
 * 保持している分掌事務を候補の手がかりとして渡す。
 *
 * 全件は入れない。件数の多い課（最大69件）に引きずられて説明の長さが
 * 偏り、トークンも増えるため。キーワード登録済みのものを優先する。
 */
function representativeDuties(units: CityOrganizationUnit[]): string[] {
	const all = units.flatMap((unit) => unit.responsibilities);
	const usable = all.filter(
		(responsibility) =>
			!BOILERPLATE.some((pattern) => responsibility.officialText.includes(pattern))
	);

	// 法令名の括弧書きは長いだけで区別に効かないため落とす。
	const cleaned = usable.map((responsibility) => ({
		text: responsibility.publicSummary.replace(/\([^)]*\)/g, '').trim(),
		hasKeyword: responsibility.keywords.length > 0
	}));

	// 上限で切る以上、条文順の先頭から詰めると後ろの具体的な分掌が落ちる。
	// 実際、政策企画課では「サンフレッチェ広島応援事業」が14番目にあり、
	// 抽象的な計画・調整の分掌に押し出されて説明へ入らなかった。
	// 住民の言葉と結び付けたもの、次に具体性のあるものを優先する。
	const rank = (duty: { text: string; hasKeyword: boolean }) => {
		if (duty.hasKeyword) return 0;
		return GENERIC_DUTY.test(duty.text) ? 2 : 1;
	};

	const seen = new Set<string>();
	const picked: string[] = [];
	for (const duty of [...cleaned].sort((a, b) => rank(a) - rank(b))) {
		if (!duty.text || seen.has(duty.text)) continue;
		seen.add(duty.text);
		picked.push(duty.text);
		if (picked.length >= MAX_DUTIES_PER_CANDIDATE) break;
	}
	return picked;
}

/** `route_to` の criteria。`other_or_unclear` を必ず含める。 */
export function routeCriteria(): Record<string, string> {
	const criteria: Record<string, string> = {};
	for (const candidate of routeCandidates()) {
		criteria[candidate.id] = candidate.description;
	}
	criteria[OTHER_OR_UNCLEAR] = '上のいずれにも当てはまらない、または文面から担当を絞り込めない。';
	return criteria;
}

/** `route_to` の表示ラベル。 */
export function routeLabels(): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const candidate of routeCandidates()) {
		labels[candidate.id] = candidate.label;
	}
	labels[OTHER_OR_UNCLEAR] = '絞り込めない';
	return labels;
}

export function categoryCriteria(): Record<string, string> {
	return Object.fromEntries(loadDirectory().categories.map((c) => [c.id, c.label]));
}

export function categoryLabels(): Record<string, string> {
	return Object.fromEntries(loadDirectory().categories.map((c) => [c.id, c.label]));
}

export type ResolvedUnit = {
	unit: CityOrganizationUnit;
	/** 一致した分掌事務。空なら課レベルまでしか絞れていない。 */
	matched: CityResponsibility[];
};

/**
 * 選ばれた課の配下から、入力文に一致する係を探す。
 *
 * 一致は登録済みキーワードの単純な包含で判定する。決められない場合は
 * 課までの表示に留める（docs/CITY_DATA.md §5）。Jev には係を判定させない。
 */
export function resolveUnit(candidateId: string, text: string): ResolvedUnit | null {
	const units = activeUnits().filter((unit) => unit.routingCandidateId === candidateId);
	if (units.length === 0) return null;

	let best: ResolvedUnit | null = null;
	let bestScore = 0;

	for (const unit of units) {
		const matched = unit.responsibilities.filter((responsibility) =>
			responsibility.keywords.some((keyword) => text.includes(keyword))
		);
		if (matched.length > bestScore) {
			bestScore = matched.length;
			best = { unit, matched };
		}
	}

	// 手がかりが無ければ係を選ばない。推測で担当を名指ししない。
	if (!best) return { unit: units[0], matched: [] };
	return best;
}

/** 候補に紐づく出典。レスポンスの `city.sources` に載せる。 */
export function sourcesFor(candidateId: string): CitySource[] {
	const units = activeUnits().filter((unit) => unit.routingCandidateId === candidateId);
	const ids = new Set(units.flatMap((unit) => unit.sourceRefs));
	return loadDirectory()
		.sourceIndex.filter((source) => ids.has(source.sourceId))
		.map((source) => ({
			sourceId: source.sourceId,
			title: source.title,
			url: source.url,
			locator: source.locator,
			retrievedAt: source.retrievedAt,
			effectiveFrom: source.effectiveFrom
		}));
}
