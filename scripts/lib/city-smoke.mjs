/**
 * CITY の判定レスポンスに対する受入確認。
 *
 * check-deployment.mjs から使う。ここだけ切り出してあるのは、確認そのものを
 * テストできるようにするため。以前 `body.city.sources` を見ていたが、
 * レスポンスが `city.candidates[].sources` へ変わったあとも気付かなかった。
 * `?? []` の既定値によって `.every()` が常に true を返し、**URL が漏れていても
 * 合格する**空振りの検査になっていた。公開デプロイを誤って承認しうる。
 *
 * この種の取りこぼしを防ぐため、各検査は「対象が存在すること」を先に確かめ、
 * 空集合を合格にしない。
 */

/**
 * @typedef {{ sourceId?: string, url?: string | null }} SmokeSource
 * @typedef {{ kind?: string, sources?: unknown }} SmokeCandidate
 * @typedef {{ fictional?: unknown, candidates?: unknown }} SmokeCity
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
export function cityChecks(body) {
	const city = /** @type {SmokeCity | undefined} */ (asRecord(body).city);
	const raw = city?.candidates;
	const candidates = Array.isArray(raw) ? /** @type {SmokeCandidate[]} */ (raw) : null;

	/** 組織に紐づく候補だけが出典を持つ。unroutable は持たない。 */
	const units = (candidates ?? []).filter((candidate) => asRecord(candidate).kind === 'unit');
	const sources = units.flatMap((candidate) =>
		Array.isArray(candidate.sources) ? /** @type {SmokeSource[]} */ (candidate.sources) : []
	);
	const leaking = sources.filter((source) => asRecord(source).url !== null);

	return [
		{
			// 公開デプロイは架空データでなければならない。
			name: 'CITY が架空データ',
			ok: city?.fictional === true,
			detail: `fictional=${city?.fictional}`
		},
		{
			name: 'CITY の候補が返る',
			ok: candidates !== null && candidates.length > 0,
			detail: candidates === null ? 'candidates が配列でない' : `${candidates.length} 件`
		},
		{
			// 空集合を合格にしない。出典が1件も無いなら次の検査は無意味になる。
			name: '候補に出典が付く',
			ok: sources.length > 0,
			detail: `${units.length} 件の課 / ${sources.length} 件の出典`
		},
		{
			name: '出典に URL を持たない',
			ok: sources.length > 0 && leaking.length === 0,
			detail:
				leaking.length > 0
					? `${leaking.length} 件が URL を持つ`
					: `${sources.length} 件すべて url=null`
		}
	];
}
