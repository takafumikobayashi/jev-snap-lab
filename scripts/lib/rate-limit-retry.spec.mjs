import { describe, expect, it } from 'vitest';
import { MAX_WAIT_SECONDS, statusDetail, withRateLimitRetry } from './rate-limit-retry.mjs';

/** 指定した status を順に返す送信関数。呼ばれた回数を数える。 */
function sender(statuses, retryAfter = '30') {
	const calls = [];
	const send = async () => {
		const status = statuses[calls.length] ?? statuses[statuses.length - 1];
		calls.push(status);
		return new Response(null, {
			status,
			headers: status === 429 ? { 'retry-after': retryAfter } : {}
		});
	};
	return { send, calls };
}

/** 実際には待たず、要求された待ち時間だけ記録する。 */
function fakeSleep() {
	const waited = [];
	return { sleep: async (ms) => void waited.push(ms), waited };
}

describe('withRateLimitRetry', () => {
	it('429 でなければそのまま返す', async () => {
		const { send, calls } = sender([400]);
		const { sleep, waited } = fakeSleep();
		const response = await withRateLimitRetry(send, { sleep });

		expect(response.status).toBe(400);
		expect(calls).toHaveLength(1);
		expect(waited).toEqual([]);
	});

	it('429 なら Retry-After を待って一度だけやり直す', async () => {
		const { send, calls } = sender([429, 400], '30');
		const { sleep, waited } = fakeSleep();
		const response = await withRateLimitRetry(send, { sleep });

		expect(response.status).toBe(400);
		expect(calls).toEqual([429, 400]);
		expect(waited).toEqual([30_000]);
	});

	it('やり直しても 429 なら 429 を返す（合格にしない）', async () => {
		// 無条件に通すと検査が空振りになる。呼び出し側に失敗させる。
		const { send, calls } = sender([429, 429]);
		const { sleep } = fakeSleep();
		const response = await withRateLimitRetry(send, { sleep });

		expect(response.status).toBe(429);
		expect(calls).toHaveLength(2);
	});

	it('やり直しは一度だけ（無限に待たない）', async () => {
		const { send, calls } = sender([429, 429, 400]);
		const { sleep, waited } = fakeSleep();
		await withRateLimitRetry(send, { sleep });

		expect(calls).toHaveLength(2);
		expect(waited).toHaveLength(1);
	});

	it('Retry-After が HTTP-date なら既定の60秒を待つ', async () => {
		// RFC 9110 は秒数でも日時でもよいとしている。秒数として読めない値は
		// 待ち時間が 0 になるより、既定の窓ぶん待つほうが安全。
		const { send } = sender([429, 400], 'Wed, 21 Oct 2026 07:28:00 GMT');
		const { sleep, waited } = fakeSleep();
		await withRateLimitRetry(send, { sleep });

		expect(waited).toEqual([60_000]);
	});

	it('Retry-After が無ければ既定の60秒を待つ', async () => {
		const send = async () =>
			new Response(null, { status: send.called ? 400 : ((send.called = true), 429) });
		const { sleep, waited } = fakeSleep();
		await withRateLimitRetry(send, { sleep });

		expect(waited).toEqual([60_000]);
	});

	it('待ち時間が長すぎるなら待たずに返す', async () => {
		const { send, calls } = sender([429, 400], String(MAX_WAIT_SECONDS + 1));
		const { sleep, waited } = fakeSleep();
		const response = await withRateLimitRetry(send, { sleep });

		expect(response.status).toBe(429);
		expect(calls).toHaveLength(1);
		expect(waited).toEqual([]);
	});

	it('待つときは理由をログに出す', async () => {
		const { send } = sender([429, 400], '30');
		const { sleep } = fakeSleep();
		const messages = [];
		await withRateLimitRetry(send, { sleep, log: (m) => messages.push(m) });

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('30 秒');
	});
});

describe('statusDetail', () => {
	it('429 は原因と対処を書く', () => {
		const detail = statusDetail(new Response(null, { status: 429 }));
		expect(detail).toContain('APP_RATE_LIMIT_PER_MINUTE');
	});

	it('それ以外は status だけ', () => {
		expect(statusDetail(new Response(null, { status: 400 }))).toBe('status=400');
	});
});
