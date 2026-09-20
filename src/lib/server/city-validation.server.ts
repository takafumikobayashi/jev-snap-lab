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

function fail(detail: string): never {
	throw new Error(`city-directory の検証に失敗: ${detail}`);
}

function requireString(value: unknown, where: string): string {
	if (typeof value !== 'string' || value.length === 0) fail(`${where} が空でない文字列でない`);
	return value;
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
	requireString(directory.effectiveFrom, 'effectiveFrom');
	requireString(directory.retrievedAt, 'retrievedAt');

	if (!Array.isArray(directory.sourceIndex)) fail('sourceIndex が配列でない');
	if (!Array.isArray(directory.organizations)) fail('organizations が配列でない');
	if (!Array.isArray(directory.categories)) fail('categories が配列でない');

	// 出典。ID の一意性と、URL のホスト制限。
	const sourceIds = new Set<string>();
	for (const entry of directory.sourceIndex as Record<string, unknown>[]) {
		const id = requireString(entry.sourceId, 'sourceIndex[].sourceId');
		if (sourceIds.has(id)) fail(`sourceId が重複している: ${id}`);
		sourceIds.add(id);
		requireString(entry.title, `sourceIndex[${id}].title`);
		requireString(entry.retrievedAt, `sourceIndex[${id}].retrievedAt`);

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
		if (unit.unit !== null && typeof unit.unit !== 'string') {
			// 未確認の係は null。空文字で埋めない。
			fail(`${unitId}.unit が文字列でも null でもない`);
		}

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
			if (!Array.isArray(responsibility.keywords)) fail(`${rid}.keywords が配列でない`);
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
