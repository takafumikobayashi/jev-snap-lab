/**
 * データセットの実行時検証。
 *
 * JSON を型へ cast するだけでは、壊れたデータがそのまま UI と上流 API へ
 * 流れる。とくに `local-*.json` はバンドルへ含めず実行時に読むため、
 * ビルド時の検査を一切通らない。ここが唯一の砦になる。
 *
 * 出所は docs/ARCHITECTURE.md の §8 と docs/CITY_DATA.md の §4。
 */

import type { CityDirectory } from '$lib/types/city';

export type ValidationOptions = {
	/**
	 * 出典 URL に許可するホスト。
	 *
	 * 公開リポジトリに実在の自治体のホスト名を書くと匿名化が破れるため、
	 * 環境変数から渡す。既定は空で、その場合 URL を持つ出典は一切許さない。
	 * 架空データは URL を持たないので、公開時はこれで足りる。
	 */
	allowedHosts: string[];
};

/** `CitySourceRecord.sourceType` が取り得る値（src/lib/types/city.ts）。 */
const SOURCE_TYPES = ['organization_page', 'ordinance', 'rule', 'council_material'];

function fail(detail: string): never {
	throw new Error(`city-directory の検証に失敗: ${detail}`);
}

function requireString(value: unknown, where: string): string {
	if (typeof value !== 'string' || value.length === 0) fail(`${where} が空でない文字列でない`);
	return value;
}

/**
 * `YYYY-MM-DD` の実在する日付。
 *
 * 画面に「取得日」「有効日」として、データバージョンの一部としても出る。
 * 形まで見ないと `2026-13-45` のような値がそのまま利用者へ届く。
 */
function requireDate(value: unknown, where: string): string {
	const text = requireString(value, where);
	// Date は 2026-02-30 を 3/2 へ繰り上げてしまうため、往復させて確かめる。
	// 2026-13-45 のような月日は Invalid Date になり NaN で弾かれる。
	const parsed = new Date(`${text}T00:00:00Z`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
		Number.isNaN(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== text
	) {
		fail(`${where} が YYYY-MM-DD の日付でない`);
	}
	return text;
}

function requireDateOrNull(value: unknown, where: string): void {
	if (value === null || value === undefined) return;
	requireDate(value, where);
}

function requireStringOrNull(value: unknown, where: string): void {
	if (value === null || value === undefined) return;
	if (typeof value !== 'string') fail(`${where} が文字列でも null でもない`);
}

/**
 * 読み込んだデータセットを検証する。
 *
 * 問題があれば例外を投げる。呼び出し側は設定エラーとして扱い、利用者へ
 * 詳細を返さない。
 */
export function validateDirectory(value: unknown, options: ValidationOptions): CityDirectory {
	if (value === null || typeof value !== 'object') fail('オブジェクトでない');
	const directory = value as Record<string, unknown>;

	if (directory.schemaVersion !== '1') fail(`schemaVersion が "1" でない`);
	if (typeof directory.fictional !== 'boolean') fail('fictional が真偽値でない');
	requireString(directory.jurisdiction, 'jurisdiction');
	requireString(directory.displayName, 'displayName');
	// データバージョン（`jurisdiction-effectiveFrom`）は画面に出る。
	requireDate(directory.effectiveFrom, 'effectiveFrom');
	requireDate(directory.retrievedAt, 'retrievedAt');

	if (!Array.isArray(directory.sourceIndex)) fail('sourceIndex が配列でない');
	if (!Array.isArray(directory.organizations)) fail('organizations が配列でない');
	if (!Array.isArray(directory.categories)) fail('categories が配列でない');

	// 出典。ID の一意性と、URL のホスト制限。
	const sourceIds = new Set<string>();
	for (const entry of directory.sourceIndex as Record<string, unknown>[]) {
		const id = requireString(entry.sourceId, 'sourceIndex[].sourceId');
		if (sourceIds.has(id)) fail(`sourceId が重複している: ${id}`);
		sourceIds.add(id);
		// 出典は根拠表示へそのまま補間される。欠けると「（undefined / 取得日
		// …）」、型が違うと「[object Object]」が利用者の画面に出る。
		requireString(entry.title, `sourceIndex[${id}].title`);
		requireString(entry.locator, `sourceIndex[${id}].locator`);
		requireDate(entry.retrievedAt, `sourceIndex[${id}].retrievedAt`);
		requireDateOrNull(entry.effectiveFrom, `sourceIndex[${id}].effectiveFrom`);
		requireDateOrNull(entry.publishedOrUpdatedAt, `sourceIndex[${id}].publishedOrUpdatedAt`);
		requireStringOrNull(entry.notes, `sourceIndex[${id}].notes`);
		if (!SOURCE_TYPES.includes(entry.sourceType as string)) {
			fail(`sourceIndex[${id}].sourceType が既知の値でない`);
		}

		const url = entry.url;
		if (url === null || url === undefined) continue;
		if (typeof url !== 'string') fail(`sourceIndex[${id}].url が文字列でも null でもない`);
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return fail(`sourceIndex[${id}].url が URL として解釈できない`);
		}
		if (parsed.protocol !== 'https:') fail(`sourceIndex[${id}].url が https でない`);
		if (!options.allowedHosts.includes(parsed.hostname)) {
			// ホスト名は例外メッセージへ出さない。ログから自治体が判明するため。
			fail(`sourceIndex[${id}].url のホストが許可されていない`);
		}
	}

	// カテゴリ。ID の一意性。
	const categoryIds = new Set<string>();
	for (const category of directory.categories as Record<string, unknown>[]) {
		const id = requireString(category.id, 'categories[].id');
		if (categoryIds.has(id)) fail(`category id が重複している: ${id}`);
		categoryIds.add(id);
		requireString(category.label, `categories[${id}].label`);
	}

	// 組織単位。活きているレコードの必須項目と参照整合性。
	const unitIds = new Set<string>();
	const sectionByCandidate = new Map<string, string>();
	for (const unit of directory.organizations as Record<string, unknown>[]) {
		const unitId = requireString(unit.organizationUnitId, 'organizations[].organizationUnitId');
		if (unitIds.has(unitId)) fail(`organizationUnitId が重複している: ${unitId}`);
		unitIds.add(unitId);

		if (typeof unit.active !== 'boolean') fail(`${unitId}.active が真偽値でない`);
		if (!unit.active) continue;

		const candidate = requireString(unit.routingCandidateId, `${unitId}.routingCandidateId`);
		if (candidate.includes('.')) {
			// 候補は課レベル。係で割ると Choice の確率が分散する。
			fail(`${unitId}.routingCandidateId が課レベルでない: ${candidate}`);
		}
		const section = requireString(unit.section, `${unitId}.section`);
		const known = sectionByCandidate.get(candidate);
		if (known !== undefined && known !== section) {
			fail(`${candidate} に複数の section が紐づいている`);
		}
		sectionByCandidate.set(candidate, section);

		requireString(unit.officialName, `${unitId}.officialName`);
		// 候補の説明文。criteria の組み立てで無条件に slice するため、
		// ここで型を保証しないと後段が TypeError になる。設定エラーとして
		// 読み込み時に落とす。
		requireString(unit.publicSummary, `${unitId}.publicSummary`);
		if (unit.unit !== null && typeof unit.unit !== 'string') {
			// 未確認の係は null。空文字で埋めない。
			fail(`${unitId}.unit が文字列でも null でもない`);
		}
		if (unit.department !== null && typeof unit.department !== 'string') {
			// 表示名の組み立てに使う。null は許すが他の型は許さない。
			fail(`${unitId}.department が文字列でも null でもない`);
		}

		requireDate(unit.effectiveFrom, `${unitId}.effectiveFrom`);
		requireDateOrNull(unit.effectiveTo, `${unitId}.effectiveTo`);

		if (!Array.isArray(unit.sourceRefs)) fail(`${unitId}.sourceRefs が配列でない`);
		for (const ref of unit.sourceRefs as unknown[]) {
			if (typeof ref !== 'string' || !sourceIds.has(ref)) {
				fail(`${unitId}.sourceRefs に未知の出典がある`);
			}
		}

		if (!Array.isArray(unit.routingCategories)) fail(`${unitId}.routingCategories が配列でない`);
		for (const category of unit.routingCategories as unknown[]) {
			if (typeof category !== 'string' || !categoryIds.has(category)) {
				fail(`${unitId}.routingCategories に未知のカテゴリがある: ${String(category)}`);
			}
		}

		if (!Array.isArray(unit.responsibilities)) fail(`${unitId}.responsibilities が配列でない`);
		for (const responsibility of unit.responsibilities as Record<string, unknown>[]) {
			const rid = requireString(
				responsibility.responsibilityId,
				`${unitId}.responsibilities[].responsibilityId`
			);
			requireString(responsibility.officialText, `${rid}.officialText`);
			// 分掌事務の要約。ここも括弧除去で無条件に文字列として扱う。
			requireString(responsibility.publicSummary, `${rid}.publicSummary`);
			if (!Array.isArray(responsibility.keywords)) fail(`${rid}.keywords が配列でない`);
			for (const keyword of responsibility.keywords as unknown[]) {
				// 文字列でない要素は includes() が黙って false になり、
				// 係の特定が静かに外れる。落ちないぶん見つけにくい。
				if (typeof keyword !== 'string' || keyword.length === 0) {
					fail(`${rid}.keywords に空でない文字列でない要素がある`);
				}
			}
			if (!Array.isArray(responsibility.sourceRefs)) fail(`${rid}.sourceRefs が配列でない`);
			for (const ref of responsibility.sourceRefs as unknown[]) {
				if (typeof ref !== 'string' || !sourceIds.has(ref)) {
					fail(`${rid}.sourceRefs に未知の出典がある`);
				}
			}
		}
	}

	if (sectionByCandidate.size === 0) fail('活きている組織単位が1件も無い');

	return value as CityDirectory;
}

/** 環境変数から許可ホストを読む。未設定なら空（URL を持つ出典を許さない）。 */
export function parseAllowedHosts(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(',')
		.map((host) => host.trim())
		.filter(Boolean);
}
