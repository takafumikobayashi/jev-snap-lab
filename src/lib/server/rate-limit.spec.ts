import { describe, expect, it } from 'vitest';
import { createRateLimiter, DEFAULT_OPTIONS } from './rate-limit.server';

const MINUTE = 60_000;

describe('createRateLimiter', () => {
	it('既定は 10 requests / 分', () => {
		expect(DEFAULT_OPTIONS.limit).toBe(10);
		expect(DEFAULT_OPTIONS.windowMs).toBe(MINUTE);
	});

	it('上限までは通す', () => {
		const limiter = createRateLimiter({ limit: 3, windowMs: MINUTE });
		for (let i = 0; i < 3; i += 1) {
			expect(limiter.check('a', 0).allowed, `${i + 1}回目`).toBe(true);
		}
	});

	it('上限を超えたら拒否する', () => {
		const limiter = createRateLimiter({ limit: 3, windowMs: MINUTE });
		for (let i = 0; i < 3; i += 1) limiter.check('a', 0);
		expect(limiter.check('a', 0).allowed).toBe(false);
	});

	it('キーごとに独立して数える', () => {
		const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE });
		expect(limiter.check('a', 0).allowed).toBe(true);
		expect(limiter.check('b', 0).allowed).toBe(true);
		expect(limiter.check('a', 0).allowed).toBe(false);
	});

	it('時間経過で補充される', () => {
		const limiter = createRateLimiter({ limit: 6, windowMs: MINUTE });
		for (let i = 0; i < 6; i += 1) limiter.check('a', 0);
		expect(limiter.check('a', 0).allowed).toBe(false);

		// 6 req/分 なので 10 秒で 1 トークン。
		expect(limiter.check('a', 10_000).allowed).toBe(true);
		expect(limiter.check('a', 10_000).allowed).toBe(false);
	});

	it('補充は上限を超えない', () => {
		const limiter = createRateLimiter({ limit: 2, windowMs: MINUTE });
		limiter.check('a', 0);
		// 1時間放置しても貯まるのは上限まで。
		for (let i = 0; i < 2; i += 1) {
			expect(limiter.check('a', 3_600_000).allowed, `${i + 1}回目`).toBe(true);
		}
		expect(limiter.check('a', 3_600_000).allowed).toBe(false);
	});

	it('固定窓ではないので窓の境界で2倍流れない', () => {
		// 固定窓だと窓末尾と次の窓頭で limit×2 が通ってしまう。
		const limiter = createRateLimiter({ limit: 5, windowMs: MINUTE });
		for (let i = 0; i < 5; i += 1) expect(limiter.check('a', MINUTE - 1).allowed).toBe(true);
		let allowedInNextWindow = 0;
		for (let i = 0; i < 5; i += 1) {
			if (limiter.check('a', MINUTE).allowed) allowedInNextWindow += 1;
		}
		expect(allowedInNextWindow).toBeLessThan(5);
	});

	describe('retryAfterSeconds', () => {
		it('許可したときは 0', () => {
			const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE });
			expect(limiter.check('a', 0).retryAfterSeconds).toBe(0);
		});

		it('拒否したときは 1 秒以上', () => {
			const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE });
			limiter.check('a', 0);
			expect(limiter.check('a', 0).retryAfterSeconds).toBeGreaterThanOrEqual(1);
		});

		it('待てば実際に通る', () => {
			const limiter = createRateLimiter({ limit: 2, windowMs: MINUTE });
			limiter.check('a', 0);
			limiter.check('a', 0);
			const denied = limiter.check('a', 0);
			expect(denied.allowed).toBe(false);
			const waited = denied.retryAfterSeconds * 1000;
			expect(limiter.check('a', waited).allowed).toBe(true);
		});
	});

	describe('メモリの上限', () => {
		it('追跡するキー数が上限を超えない', () => {
			// 送信元アドレスは詐称できる。無制限に覚えると枯渇経路になる。
			const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE, maxKeys: 5 });
			for (let i = 0; i < 100; i += 1) limiter.check(`key-${i}`, 0);
			expect(limiter.size()).toBeLessThanOrEqual(5);
		});

		it('古いキーから捨てる', () => {
			const limiter = createRateLimiter({ limit: 1, windowMs: MINUTE, maxKeys: 2 });
			limiter.check('old', 0);
			limiter.check('b', 0);
			limiter.check('c', 0); // old が押し出される
			// 捨てられたので新規扱いになり、また 1 回通る。
			expect(limiter.check('old', 0).allowed).toBe(true);
		});

		it('使い続けているキーは押し出されにくい', () => {
			const limiter = createRateLimiter({ limit: 5, windowMs: MINUTE, maxKeys: 3 });
			limiter.check('active', 0);
			limiter.check('x', 0);
			limiter.check('active', 0); // 挿入順が更新される
			limiter.check('y', 0);
			limiter.check('z', 0);
			expect(limiter.size()).toBeLessThanOrEqual(3);
		});
	});
});
