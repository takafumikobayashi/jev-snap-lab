/**
 * レート制限に当たったら `Retry-After` を待って一度だけやり直す。
 *
 * 受入確認は同じ送信元から `/api/judge` を複数回叩く。API はレート制限を
 * 入力検証より先に評価するため、不正リクエストの確認も枠を消費する
 * （src/routes/api/judge/+server.ts）。`APP_RATE_LIMIT_PER_MINUTE=1` の
 * ような正当な設定だと、2本目が 400 ではなく 429 になり、健全なデプロイを
 * 不合格にしてしまう。実際に再現した。
 *
 * 429 を無条件に合格扱いにはしない。それでは検査が空振りになる。待っても
 * 429 のままならそのまま返し、呼び出し側が失敗として報告する。
 */

/** これ以上の待ちは要求されても待たない。手が止まりすぎる。 */
export const MAX_WAIT_SECONDS = 90;

/** Retry-After が読めないときの待ち時間。既定の窓は60秒。 */
const FALLBACK_WAIT_SECONDS = 60;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => Promise<Response>} send リクエストを1回送る
 * @param {{ sleep?: (ms: number) => Promise<void>, log?: (message: string) => void }} [options]
 * @returns {Promise<Response>}
 */
export async function withRateLimitRetry(send, options = {}) {
	const sleep = options.sleep ?? realSleep;
	const log = options.log ?? (() => {});

	const first = await send();
	if (first.status !== 429) return first;

	const header = Number(first.headers.get('retry-after'));
	const wait = Number.isFinite(header) && header > 0 ? header : FALLBACK_WAIT_SECONDS;
	if (wait > MAX_WAIT_SECONDS) {
		log(`レート制限に当たった。${wait} 秒の待機は長すぎるため再試行しない`);
		return first;
	}

	log(`レート制限に当たった。${wait} 秒待って再試行する`);
	await sleep(wait * 1000);
	return send();
}

/** 検査結果の detail。429 は原因が分かるようにする。 */
export function statusDetail(response) {
	if (response.status !== 429) return `status=${response.status}`;
	return 'status=429（受入確認自身がレート制限に当たった。APP_RATE_LIMIT_PER_MINUTE を一時的に上げるか、時間をおくこと）';
}
