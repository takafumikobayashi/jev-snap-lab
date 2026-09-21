/**
 * CITY Semantic Fit を有効にしたときの `/api/judge` の振る舞い。
 *
 * 実験が失敗しても既定の CITY 結果が返ることを成功条件にする
 * （docs/CITY_SEMANTIC_EXPERIMENT.md §4.4）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeResponse } from '$lib/types/judge';
import { buildCatalog, type QuestionCatalog } from '$lib/server/question-catalog.server';
import { JudgeError } from '$lib/server/errors.server';

const evaluate = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/jev-client.server', () => ({ evaluate }));
vi.mock('$env/dynamic/private', () => ({ env: { CITY_SEMANTIC_EXPERIMENT: 'true' } }));

const { POST } = await import('./+server');

/** 実カタログの質問すべてに、契約を満たす答えを作る。 */
function synthesize(catalog: QuestionCatalog): Record<string, unknown> {
	const answers: Record<string, unknown> = {};
	for (const [id, question] of Object.entries(catalog.questions)) {
		if (question.type === 'choice') {
			const keys = Object.keys(question.criteria);
			answers[id] = {
				type: 'choice',
				choice: keys[0],
				probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 : 0])),
				confidence: 0.8
			};
		} else if (question.type === 'score') {
			const levels = question.criteria.length;
			answers[id] = {
				type: 'score',
				score: 0,
				legend: Object.fromEntries(question.criteria.map((c, i) => [i, c])),
				probabilities: Object.fromEntries(
					Array.from({ length: levels }, (_, i) => [i, i === 0 ? 1 : 0])
				),
				confidence: 0.8
			};
		} else {
			answers[id] = { type: 'noul', noul: 0.5 };
		}
	}
	return answers;
}

const stage1 = () => ({
	result: {
		model: 'jev-1',
		usage: { input_tokens: 2000, output_tokens: 80 },
		answers: synthesize(buildCatalog('city'))
	},
	latencyMs: 300,
	config: { inputPricePerMillionTokens: 0.042 }
});

/** Stage 2 は fit_N の Noul を返す。 */
const stage2 = (questions: Record<string, unknown>) => ({
	result: {
		model: 'jev-1',
		usage: { input_tokens: 900, output_tokens: 40 },
		answers: Object.fromEntries(
			Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.4 }])
		)
	},
	latencyMs: 200,
	config: { inputPricePerMillionTokens: 0.042 }
});

const post = (body: unknown) =>
	POST({
		request: new Request('http://localhost/api/judge', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		getClientAddress: () => '127.0.0.1'
	} as Parameters<typeof POST>[0]);

const judge = () => post({ mode: 'city', text: '家の前の防犯灯が切れてます' });

beforeEach(() => {
	evaluate.mockReset();
	vi.restoreAllMocks();
});

describe('CITY Semantic Fit の shadow 実験', () => {
	it('Stage 1 の後に追加で1回だけ呼ぶ', async () => {
		evaluate
			.mockImplementationOnce(stage1)
			.mockImplementationOnce((_s, questions) => stage2(questions as Record<string, unknown>));
		const response = await judge();

		expect(response.status).toBe(200);
		expect(evaluate).toHaveBeenCalledTimes(2);
	});

	it('既定の CITY レスポンスを書き換えない', async () => {
		// 実験の結果を画面へ出さない。
		evaluate
			.mockImplementationOnce(stage1)
			.mockImplementationOnce((_s, questions) => stage2(questions as Record<string, unknown>));
		const body = (await (await judge()).json()) as JudgeResponse;

		expect(body.city?.candidates.length).toBeGreaterThan(0);
		expect(JSON.stringify(body)).not.toContain('fitProbability');
		expect(JSON.stringify(body)).not.toContain('experiment');
	});

	it('Stage 2 が失敗しても既定の結果を返す', async () => {
		// 実験のために動いている機能を壊さない。
		evaluate
			.mockImplementationOnce(stage1)
			.mockImplementationOnce(() => Promise.reject(new JudgeError('UPSTREAM_TIMEOUT', 'timeout')));
		const response = await judge();
		const body = (await response.json()) as JudgeResponse;

		expect(response.status).toBe(200);
		expect(body.city?.candidates.length).toBeGreaterThan(0);
	});

	it('Stage 2 が契約違反でも既定の結果を返す', async () => {
		evaluate.mockImplementationOnce(stage1).mockImplementationOnce(() => ({
			result: { model: 'jev-1', usage: { input_tokens: 10, output_tokens: 1 }, answers: {} },
			latencyMs: 10,
			config: { inputPricePerMillionTokens: 0.042 }
		}));
		const response = await judge();

		expect(response.status).toBe(200);
		expect(((await response.json()) as JudgeResponse).city?.candidates.length).toBeGreaterThan(0);
	});

	it('観測ログに入力本文を出さない', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		evaluate
			.mockImplementationOnce(stage1)
			.mockImplementationOnce((_s, questions) => stage2(questions as Record<string, unknown>));
		await judge();

		const logs = info.mock.calls.map(([line]) => String(line)).join('\n');
		expect(logs).toContain('city_semantic');
		expect(logs).not.toContain('防犯灯が切れてます');
	});

	it('Stage 2 の予算が Stage 1 の残りに収まる', async () => {
		// 12,000ms × 2 は maxDuration 20,000ms を超える。残りを渡す。
		evaluate
			.mockImplementationOnce(stage1)
			.mockImplementationOnce((_s, questions) => stage2(questions as Record<string, unknown>));
		await judge();

		const [, , budgetMs] = evaluate.mock.calls[1];
		expect(typeof budgetMs).toBe('number');
		expect(budgetMs).toBeLessThanOrEqual(16_000);
		expect(budgetMs).toBeGreaterThan(0);
	});

	it('LOVE / SOCIAL では追加呼び出しをしない', async () => {
		for (const mode of ['love', 'social'] as const) {
			evaluate.mockReset();
			evaluate.mockImplementation(() => ({
				result: {
					model: 'jev-1',
					usage: { input_tokens: 100, output_tokens: 10 },
					answers: synthesize(buildCatalog(mode))
				},
				latencyMs: 100,
				config: { inputPricePerMillionTokens: 0.042 }
			}));
			await post({ mode, text: 'テスト' });
			expect(evaluate, mode).toHaveBeenCalledTimes(1);
		}
	});
});
