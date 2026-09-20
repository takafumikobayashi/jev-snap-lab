import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JudgeError } from './errors.server';

/**
 * 総時間上限の検証。
 *
 * SDK に総 retry 予算は無いため、AbortSignal で強制している
 * （docs/JEV_DESIGN.md §9）。ここが効かないと、上流が遅いときに
 * プラットフォーム側の制限まで待たされる。
 */
const systemOne = vi.hoisted(() => vi.fn());
vi.mock('@typesafe-ai/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@typesafe-ai/sdk')>();
	return {
		...actual,
		TypeSafeClient: class {
			systemOne = systemOne;
		}
	};
});
vi.mock('$env/dynamic/private', () => ({
	env: { TYPESAFE_API_KEY: 'sk-test', CITY_DIRECTORY: 'fictional-m-city' }
}));

const { evaluate, resetJevClient } = await import('./jev-client.server');
const { DEFAULTS } = await import('./jev-config.server');
const { noul } = await import('@typesafe-ai/sdk');

const questions = { flag: noul('Is it so?') };
const state = { mode: 'love' as const, text: 'テスト' };

beforeEach(() => {
	systemOne.mockReset();
	resetJevClient();
});

describe('evaluate の総時間上限', () => {
	it('予算内に終われば結果を返す', async () => {
		systemOne.mockResolvedValue({
			model: 'jev-1.13.0',
			answers: { flag: { type: 'noul', noul: 0.5 } },
			usage: { input_tokens: 10, output_tokens: 2 }
		});
		const result = await evaluate(state, questions);
		expect(result.result.model).toBe('jev-1.13.0');
		expect(typeof result.latencyMs).toBe('number');
	});

	it('signal を SDK へ渡す', async () => {
		systemOne.mockResolvedValue({
			model: 'jev-1.13.0',
			answers: { flag: { type: 'noul', noul: 0.5 } },
			usage: { input_tokens: 10, output_tokens: 2 }
		});
		await evaluate(state, questions);
		const options = systemOne.mock.calls[0][1];
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(options.signal.aborted).toBe(false);
	});

	it('総予算を超えたら signal が abort される', async () => {
		// 実時間に依存させない。短い予算を渡して待つ方式だと、並列実行や
		// 負荷でテストタイムアウトに化ける。偽タイマーで時間を進める。
		vi.useFakeTimers();
		try {
			let captured: AbortSignal | undefined;
			systemOne.mockImplementation((_request: unknown, options: { signal: AbortSignal }) => {
				captured = options.signal;
				// SDK が応答しない状況。signal の発火だけを見る。
				return new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(new Error('aborted')));
				});
			});

			const pending = evaluate(state, questions);
			const assertion = expect(pending).rejects.toBeInstanceOf(JudgeError);

			// 既定の総予算は 12,000ms（docs/JEV_DESIGN.md §9）。
			await vi.advanceTimersByTimeAsync(DEFAULTS.totalTimeoutMs);

			await assertion;
			expect(captured?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('予算に達する前は abort しない', async () => {
		vi.useFakeTimers();
		try {
			let captured: AbortSignal | undefined;
			systemOne.mockImplementation((_request: unknown, options: { signal: AbortSignal }) => {
				captured = options.signal;
				return new Promise(() => {});
			});

			void evaluate(state, questions);
			await vi.advanceTimersByTimeAsync(DEFAULTS.totalTimeoutMs - 1);
			expect(captured?.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('中断は timeout として扱う', async () => {
		const { APIUserAbortError } = await import('@typesafe-ai/sdk');
		systemOne.mockRejectedValue(new APIUserAbortError());
		try {
			await evaluate(state, questions);
		} catch (error) {
			expect((error as JudgeError).code).toBe('UPSTREAM_TIMEOUT');
			return;
		}
		throw new Error('エラーが投げられなかった');
	});

	it('送信前に criteria の形を検証し、不正なら上流を呼ばない', async () => {
		const broken = { bad: { type: 'score', criteria: { 0: 'x' } } } as never;
		try {
			await evaluate(state, broken);
		} catch (error) {
			expect((error as JudgeError).code).toBe('QUESTION_DEFINITION_ERROR');
			expect(systemOne).not.toHaveBeenCalled();
			return;
		}
		throw new Error('エラーが投げられなかった');
	});

	it('例外の詳細に入力本文を含めない', async () => {
		systemOne.mockRejectedValue(new Error('boom'));
		try {
			await evaluate({ mode: 'love', text: '秘密の入力文' }, questions);
		} catch (error) {
			expect((error as JudgeError).message).not.toContain('秘密の入力文');
			return;
		}
		throw new Error('エラーが投げられなかった');
	});
});
