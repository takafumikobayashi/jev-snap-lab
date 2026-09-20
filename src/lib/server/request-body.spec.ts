import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, readJsonBody } from './request-body.server';
import { MAX_INPUT_CODE_POINTS } from '$lib/types/judge';

const jsonRequest = (body: string) =>
	new Request('http://localhost/api/judge', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body
	});

/** Content-Length を宣言せずに送る（chunked 相当）。 */
function streamedRequest(body: string): Request {
	const bytes = new TextEncoder().encode(body);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			// 小分けにして、途中で打ち切れることを確かめる。
			for (let i = 0; i < bytes.length; i += 1024) {
				controller.enqueue(bytes.slice(i, i + 1024));
			}
			controller.close();
		}
	});
	return new Request('http://localhost/api/judge', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: stream,
		duplex: 'half'
	} as RequestInit & { duplex: 'half' });
}

describe('readJsonBody', () => {
	it('正しい JSON を読む', async () => {
		const result = await readJsonBody(jsonRequest('{"mode":"love","text":"テスト"}'));
		expect(result).toEqual({ ok: true, value: { mode: 'love', text: 'テスト' } });
	});

	it('壊れた JSON を拒否する', async () => {
		const result = await readJsonBody(jsonRequest('{ broken'));
		expect(result).toEqual({ ok: false, reason: 'NOT_JSON' });
	});

	it('上限を超えたボディを拒否する', async () => {
		const body = JSON.stringify({ mode: 'love', text: 'あ'.repeat(MAX_BODY_BYTES) });
		expect(new TextEncoder().encode(body).length).toBeGreaterThan(MAX_BODY_BYTES);
		expect(await readJsonBody(jsonRequest(body))).toEqual({ ok: false, reason: 'TOO_LARGE' });
	});

	it('Content-Length を宣言しない場合も打ち切る', async () => {
		// 宣言値は詐称できるので、実際に読んだバイト数でも見る。
		const body = JSON.stringify({ mode: 'love', text: 'あ'.repeat(MAX_BODY_BYTES) });
		const request = streamedRequest(body);
		expect(request.headers.get('content-length')).toBeNull();
		expect(await readJsonBody(request)).toEqual({ ok: false, reason: 'TOO_LARGE' });
	});

	it('上限ちょうどは通す', async () => {
		const filler = 'a'.repeat(MAX_BODY_BYTES - '{"mode":"love","text":""}'.length);
		const body = JSON.stringify({ mode: 'love', text: filler });
		expect(new TextEncoder().encode(body).length).toBe(MAX_BODY_BYTES);
		expect((await readJsonBody(jsonRequest(body))).ok).toBe(true);
	});

	it('正当な最大入力を拒まない', async () => {
		// 280 code points の絵文字は UTF-8 で最も重くなる部類。
		const body = JSON.stringify({ mode: 'love', text: '👍'.repeat(MAX_INPUT_CODE_POINTS) });
		const bytes = new TextEncoder().encode(body).length;
		expect(bytes).toBeLessThan(MAX_BODY_BYTES);
		expect((await readJsonBody(jsonRequest(body))).ok).toBe(true);
	});

	it('上限は呼び出し側で狭められる', async () => {
		expect(await readJsonBody(jsonRequest('{"a":1}'), 3)).toEqual({
			ok: false,
			reason: 'TOO_LARGE'
		});
	});
});
