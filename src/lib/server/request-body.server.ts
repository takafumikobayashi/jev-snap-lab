/**
 * リクエストボディの読み取り。
 *
 * `request.json()` は本文全体をメモリへ展開してから返す。入力の文字数を
 * 検証しても、その前に巨大なボディを読み込んでしまう。上限を超えた時点で
 * 読み取りを打ち切る。
 */

/**
 * 受け付けるボディの上限（バイト）。
 *
 * 280 code points の日本語は UTF-8 で 840 バイト程度、絵文字だけでも
 * 1,120 バイト程度である。JSON のエスケープとキー名を足しても数 KB に
 * 収まるため、8 KB あれば正当な入力を拒まない。
 */
export const MAX_BODY_BYTES = 8 * 1024;

export type BodyResult =
	{ ok: true; value: unknown } | { ok: false; reason: 'TOO_LARGE' | 'NOT_JSON' };

function concat(chunks: Uint8Array[], size: number): Uint8Array {
	const merged = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

/**
 * 上限つきでボディを読み、JSON として解釈する。
 *
 * `Content-Length` は詐称できるため、宣言値で早期に弾いたうえで、実際に
 * 読んだバイト数でも打ち切る。
 */
export async function readJsonBody(request: Request, limit = MAX_BODY_BYTES): Promise<BodyResult> {
	const declared = Number(request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > limit) {
		return { ok: false, reason: 'TOO_LARGE' };
	}

	const body = request.body;
	if (!body) return { ok: false, reason: 'NOT_JSON' };

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				return { ok: false, reason: 'TOO_LARGE' };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, reason: 'NOT_JSON' };
	}

	try {
		return { ok: true, value: JSON.parse(new TextDecoder().decode(concat(chunks, size))) };
	} catch {
		return { ok: false, reason: 'NOT_JSON' };
	}
}
