import { describe, expect, it } from 'vitest';
import { describeBatchFailure, validateBatchInput } from './batch-input';
import { MAX_BATCH_CASES, MAX_BATCH_CASE_CHARS } from '$lib/types/batch';

const ok = (body: unknown) => validateBatchInput(body);
const failureOf = (body: unknown) => {
	const result = validateBatchInput(body);
	expect(result.ok).toBe(false);
	return result.ok ? '' : result.failure;
};

describe('validateBatchInput', () => {
	it('cases を省いたリクエストを拒む', () => {
		// この API は渡された文章を判定するだけで、同梱データを判定する経路を
		// 持たない。持たせると「貼った文章がたまたま例文と同じだったときだけ
		// 一致率が出る」という不可解な挙動になる。
		expect(failureOf({ theme: 'privacy' })).toBe('CASES_NOT_ARRAY');
	});

	it('cases を渡すと利用者の文章を判定する', () => {
		expect(ok({ theme: 'dx', cases: ['紙の台帳を探すのに時間がかかる'] })).toEqual({
			ok: true,
			value: { theme: 'dx', cases: ['紙の台帳を探すのに時間がかかる'] }
		});
	});

	it('知らないキーを拒む', () => {
		// 綴り違いを黙って捨てると「省略」と区別できない。
		expect(failureOf({ theme: 'privacy', case: ['x'] })).toBe('UNKNOWN_FIELD');
	});

	it('未知のテーマを拒む', () => {
		expect(failureOf({ theme: 'unknown' })).toBe('INVALID_THEME');
	});

	describe('cases', () => {
		it('空を拒む', () => {
			expect(failureOf({ theme: 'privacy', cases: [] })).toBe('CASES_EMPTY');
		});

		it('上限を超える件数を拒む', () => {
			const cases = Array.from({ length: MAX_BATCH_CASES + 1 }, (_, at) => `件 ${at}`);
			expect(failureOf({ theme: 'privacy', cases })).toBe('TOO_MANY_CASES');
		});

		it('上限ちょうどは通る', () => {
			const cases = Array.from({ length: MAX_BATCH_CASES }, (_, at) => `件 ${at}`);
			expect(ok({ theme: 'privacy', cases }).ok).toBe(true);
		});

		it('空白だけの行を拒む', () => {
			expect(failureOf({ theme: 'privacy', cases: ['   '] })).toBe('CASE_BLANK');
		});

		it('文字数を code point で数える', () => {
			// UTF-16 の length で数えると、サロゲートペアの漢字で正当な入力を
			// 半分の長さで弾く。
			const surrogate = '𠮷'.repeat(MAX_BATCH_CASE_CHARS);
			expect(surrogate.length).toBe(MAX_BATCH_CASE_CHARS * 2);
			expect(ok({ theme: 'privacy', cases: [surrogate] }).ok).toBe(true);
			expect(failureOf({ theme: 'privacy', cases: ['あ'.repeat(MAX_BATCH_CASE_CHARS + 1)] })).toBe(
				'CASE_TOO_LONG'
			);
		});

		it('改行を含む行を拒む', () => {
			// 1件が1行に対応する。改行が入っている時点で切り出しが壊れている。
			expect(failureOf({ theme: 'privacy', cases: ['前半\n後半'] })).toBe('CASE_CONTROL_CHARACTER');
		});

		it('制御文字を拒む', () => {
			expect(failureOf({ theme: 'privacy', cases: ['壊\u0000れた'] })).toBe(
				'CASE_CONTROL_CHARACTER'
			);
		});

		it('文字列でない要素を拒む', () => {
			expect(failureOf({ theme: 'privacy', cases: [123] })).toBe('CASE_NOT_STRING');
		});
	});
});

describe('describeBatchFailure', () => {
	it('入力本文を含めない', () => {
		// エラー文言から入力が漏れないようにする。
		for (const failure of ['CASES_EMPTY', 'TOO_MANY_CASES', 'CASE_TOO_LONG'] as const) {
			const message = describeBatchFailure(failure);
			expect(message.length).toBeGreaterThan(0);
			expect(message).not.toContain('\n');
		}
	});

	it('上限を文言へ入れる', () => {
		expect(describeBatchFailure('TOO_MANY_CASES')).toContain(String(MAX_BATCH_CASES));
		expect(describeBatchFailure('CASE_TOO_LONG')).toContain(String(MAX_BATCH_CASE_CHARS));
	});
});
