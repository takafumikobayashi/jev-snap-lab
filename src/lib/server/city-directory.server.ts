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

function loadDirectory(): CityDirectory {
	const name = env.CITY_DIRECTORY?.trim() || DEFAULT_DIRECTORY;
	const entry = Object.entries(files).find(([path]) => path.endsWith(`/${name}.json`));
	if (!entry) {
		const available = Object.keys(files)
			.map((path) => path.split('/').pop()?.replace('.json', ''))
			.join(', ');
		throw new Error(`CITY_DIRECTORY "${name}" が見つからない。利用可能: ${available}`);
	}
	return entry[1].default;
}

const directory = loadDirectory();

/** 架空データを使っているか。UI の注意表示に使う。 */
export function isFictional(): boolean {
	return directory.fictional === true;
}

/** 候補を絞り込めない場合のキー。route_to に必ず含める。 */
export const OTHER_OR_UNCLEAR = 'other_or_unclear';

export function getDirectory(): CityDirectory {
	return directory;
}

/** データのバージョン。`effectiveFrom` と `retrievedAt` を組にする。 */
export function directoryVersion(): string {
	return `${directory.jurisdiction}-${directory.effectiveFrom}`;
}

export function jurisdictionName(): string {
	return directory.displayName;
}

function activeUnits(): CityOrganizationUnit[] {
	return directory.organizations.filter((unit) => unit.active);
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
		return {
			id,
			label: head.section,
			description: `${head.section}。${summary}`,
			units
		};
	});
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
	return Object.fromEntries(directory.categories.map((c) => [c.id, c.label]));
}

export function categoryLabels(): Record<string, string> {
	return Object.fromEntries(directory.categories.map((c) => [c.id, c.label]));
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
	return directory.sourceIndex
		.filter((source) => ids.has(source.sourceId))
		.map((source) => ({
			sourceId: source.sourceId,
			title: source.title,
			url: source.url,
			locator: source.locator,
			retrievedAt: source.retrievedAt,
			effectiveFrom: source.effectiveFrom
		}));
}
