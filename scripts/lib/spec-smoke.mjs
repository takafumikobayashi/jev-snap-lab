/**
 * SPEC FIND の判定レスポンスに対する受入確認。
 *
 * city-smoke.mjs と同じ方針で、空集合を合格にせず、対象の存在を先に確かめる。
 * 検査そのものをテストできるよう切り出してある。
 */

/**
 * @typedef {{ passageId?: string, sourceLocator?: string, attribution?: string, sourceUrl?: string, normalized?: unknown, fitProbability?: unknown }} SmokeHit
 * @typedef {{ version?: unknown, documentTitle?: unknown, abstained?: unknown, hits?: unknown, unresolved?: unknown }} SmokeSpec
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function asRecord(value) {
	return value !== null && typeof value === 'object'
		? /** @type {Record<string, unknown>} */ (value)
		: {};
}

/**
 * @param {unknown} body 判定レスポンス（JSON）
 * @returns {Array<{ name: string, ok: boolean, detail: string }>}
 */
export function specChecks(body) {
	const spec = /** @type {SmokeSpec | undefined} */ (asRecord(body).spec);
	const raw = spec?.hits;
	const hits = Array.isArray(raw) ? /** @type {SmokeHit[]} */ (raw) : null;
	const rows = hits ?? [];

	const missingLocator = rows.filter((hit) => !asRecord(hit).sourceLocator);
	const missingAttribution = rows.filter(
		(hit) => !String(asRecord(hit).attribution ?? '').includes('デジタル庁')
	);
	const unresolved = Array.isArray(spec?.unresolved) ? spec.unresolved : [];

	return [
		{
			name: 'SPEC の結果が返る',
			ok: hits !== null && typeof spec?.abstained === 'boolean',
			detail: hits === null ? 'spec.hits が配列でない' : `${hits.length} 件`
		},
		{
			// 対象外でない入力で候補が0件なら、コーパスか閾値の設定を疑う。
			name: '候補が見つかる',
			ok: rows.length > 0,
			detail: spec?.abstained === true ? 'abstain した' : `${rows.length} 件`
		},
		{
			name: '出典の位置が付く',
			ok: rows.length > 0 && missingLocator.length === 0,
			detail:
				missingLocator.length > 0 ? `${missingLocator.length} 件に locator が無い` : '全件にあり'
		},
		{
			// PDL 1.0 は出典表示を求める。欠けた状態で公開しない。
			name: 'PDL 1.0 の出典表示が付く',
			ok: rows.length > 0 && missingAttribution.length === 0,
			detail:
				missingAttribution.length > 0
					? `${missingAttribution.length} 件に出典表示が無い`
					: '全件にあり'
		},
		{
			// 出典を解決できない候補を公式根拠付きで見せない。
			name: '解決できない候補が無い',
			ok: unresolved.length === 0,
			detail: unresolved.length > 0 ? `${unresolved.length} 件` : '0 件'
		},
		{
			name: 'データセットの版が残る',
			ok: typeof spec?.version === 'string' && String(spec.version).length > 0,
			detail: `version=${String(spec?.version)}`
		}
	];
}
