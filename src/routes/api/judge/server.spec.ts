import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeResponse } from '$lib/types/judge';
import type { JudgeErrorBody } from '$lib/types/error';
import { MODES } from '$lib/types/judge';
import { JudgeError } from '$lib/server/errors.server';
import { buildCatalog, type QuestionCatalog } from '$lib/server/question-catalog.server';

// Jev への実通信を差し替える。ルート側の責務（Content-Type、JSON parse、
// 入力検証、レスポンス組み立て、エラー変換）だけを検証する。
const evaluate = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/jev-client.server', () => ({ evaluate }));

const { POST } = await import('./+server');

/** 実カタログの質問すべてに、契約を満たす答えを機械的に作る。 */
function synthesizeAnswers(catalog: QuestionCatalog): Record<string, unknown> {
	const answers: Record<string, unknown> = {};
	for (const [id, question] of Object.entries(catalog.questions)) {
		if (question.type === 'choice') {
			const keys = Object.keys(question.criteria);
			const probabilities = Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 : 0]));
			answers[id] = { type: 'choice', choice: keys[0], probabilities, confidence: 0.8 };
		} else if (question.type === 'score') {
			const levels = question.criteria.length;
			const indices = Array.from({ length: levels }, (_, i) => i);
			answers[id] = {
				type: 'score',
				score: 0,
				legend: Object.fromEntries(indices.map((i) => [i, String(question.criteria[i])])),
				probabilities: Object.fromEntries(indices.map((i) => [i, i === 0 ? 1 : 0])),
				confidence: 0.9
			};
		} else {
			answers[id] = { type: 'noul', noul: 0.42 };
		}
	}
	return answers;
}

function mockSuccess(mode: 'love' | 'social' | 'city') {
	evaluate.mockResolvedValue({
		result: {
			model: 'jev-1.13.0',
			answers: synthesizeAnswers(buildCatalog(mode)),
			usage: { input_tokens: 392, output_tokens: 65 }
		},
		latencyMs: 148,
		config: { inputPricePerMillionTokens: 0.042 }
	});
}

function post(body: unknown, contentType: string | null = 'application/json'): Promise<Response> {
	const headers = new Headers();
	if (contentType !== null) headers.set('content-type', contentType);
	const request = new Request('http://localhost/api/judge', {
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
	// ハンドラは request しか使わない。RequestEvent の全体を組み立てず、
	// 必要な部分だけを渡す。
	return POST({ request } as Parameters<typeof POST>[0]) as Promise<Response>;
}

beforeEach(() => {
	evaluate.mockReset();
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('POST /api/judge', () => {
	it('正常系で 200 と結果を返す', async () => {
		mockSuccess('love');
		const response = await post({ mode: 'love', text: 'もう君のことは忘れたはずなのに' });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

		const body = (await response.json()) as JudgeResponse;
		expect(body.mode).toBe('love');
		expect(body.model).toBe('jev-1.13.0');
		expect(body.requestId).toMatch(/^req_/);
		expect(body.results).toHaveLength(7);
		expect(typeof body.latencyMs).toBe('number');
	});

	it('3モードすべて実カタログで正規化できる', async () => {
		for (const mode of MODES) {
			mockSuccess(mode);
			const response = await post({ mode, text: 'テスト入力' });
			expect(response.status, mode).toBe(200);
			const body = (await response.json()) as JudgeResponse;
			const kinds = new Set(body.results.map((card) => card.kind));
			expect(kinds, mode).toEqual(new Set(['choice', 'score', 'noul']));
		}
	});

	it('usage とコスト推計を載せる', async () => {
		mockSuccess('love');
		const body = (await (await post({ mode: 'love', text: 'x' })).json()) as JudgeResponse;
		expect(body.usage?.inputTokens).toBe(392);
		expect(body.usage?.outputTokens).toBe(65);
		expect(body.usage?.estimatedCostUsd).toBeCloseTo(0.000016464, 12);
	});

	it('requestId が入力本文から導出されていない', async () => {
		mockSuccess('love');
		const a = (await (await post({ mode: 'love', text: '同じ入力' })).json()) as JudgeResponse;
		mockSuccess('love');
		const b = (await (await post({ mode: 'love', text: '同じ入力' })).json()) as JudgeResponse;
		expect(a.requestId).not.toBe(b.requestId);
	});

	describe('CITY の暫定データ', () => {
		it('公式データのバージョンと出典を返す', async () => {
			mockSuccess('city');
			const body = (await (
				await post({ mode: 'city', text: '家の前の防犯灯が切れてます' })
			).json()) as JudgeResponse;
			expect(body.city?.provisional).toBe(false);
			expect(body.city?.directoryVersion).toBe('akitakata-2026-04-01');
			expect(body.city?.sources.length).toBeGreaterThan(0);
			for (const source of body.city?.sources ?? []) {
				expect(source.url).toMatch(/^https:\/\//);
				expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			}
		});

		it('入力文から係と分掌事務を join する', async () => {
			// synthesizeAnswers は criteria の先頭候補を選ぶ。先頭が
			// 危機管理課である前提に依存しないよう、解決結果の有無だけ見る。
			mockSuccess('city');
			const body = (await (
				await post({ mode: 'city', text: '家の前の防犯灯が切れてます' })
			).json()) as JudgeResponse;
			expect(body.city?.resolvedUnit).toBeDefined();
			expect(body.city?.resolvedUnit?.officialName).toContain('安芸高田市');
		});

		it('LOVE / SOCIAL には city ブロックを付けない', async () => {
			for (const mode of ['love', 'social'] as const) {
				mockSuccess(mode);
				const body = (await (await post({ mode, text: 'x' })).json()) as JudgeResponse;
				expect(body.city, mode).toBeUndefined();
			}
		});
	});

	describe('リクエストの形', () => {
		it('Content-Type が JSON でなければ 400', async () => {
			const response = await post({ mode: 'love', text: 'x' }, 'text/plain');
			expect(response.status).toBe(400);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('Content-Type が無ければ 400', async () => {
			expect((await post({ mode: 'love', text: 'x' }, null)).status).toBe(400);
		});

		it('charset 付きの Content-Type を受け付ける', async () => {
			mockSuccess('love');
			const response = await post({ mode: 'love', text: 'x' }, 'application/json; charset=utf-8');
			expect(response.status).toBe(200);
		});

		it('JSON として壊れていれば 400', async () => {
			const response = await post('{ broken', 'application/json');
			expect(response.status).toBe(400);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('入力検証に落ちれば 400 で、Jev を呼ばない', async () => {
			for (const body of [
				{ mode: 'unknown', text: 'x' },
				{ mode: 'love', text: '   ' },
				{ mode: 'love', text: 'あ'.repeat(281) },
				{ mode: 'love', text: 'x', state: { injected: true } }
			]) {
				const response = await post(body);
				expect(response.status, JSON.stringify(body)).toBe(400);
			}
			expect(evaluate).not.toHaveBeenCalled();
		});
	});

	describe('エラー変換', () => {
		const cases = [
			['UPSTREAM_TIMEOUT', 504, true],
			['RATE_LIMITED', 429, true],
			['UPSTREAM_UNAVAILABLE', 503, true],
			['CONFIGURATION_ERROR', 500, false],
			['QUESTION_DEFINITION_ERROR', 500, false]
		] as const;

		it.each(cases)('%s を %i で返す', async (code, status, retryable) => {
			evaluate.mockRejectedValue(new JudgeError(code, '内部の詳細'));
			const response = await post({ mode: 'love', text: 'x' });
			expect(response.status).toBe(status);
			const body = (await response.json()) as JudgeErrorBody;
			expect(body.error.code).toBe(code);
			expect(body.error.retryable).toBe(retryable);
		});

		it('想定外の例外を INTERNAL_ERROR にする', async () => {
			evaluate.mockRejectedValue(new Error('boom'));
			const response = await post({ mode: 'love', text: 'x' });
			expect(response.status).toBe(500);
			expect(((await response.json()) as JudgeErrorBody).error.code).toBe('INTERNAL_ERROR');
		});

		it('エラー応答に内部情報を含めない', async () => {
			evaluate.mockRejectedValue(
				new JudgeError('CONFIGURATION_ERROR', 'TYPESAFE_API_KEY が未設定')
			);
			const raw = await (await post({ mode: 'love', text: '秘密の入力文' })).text();
			expect(raw).not.toContain('TYPESAFE_API_KEY');
			expect(raw).not.toContain('秘密の入力文');
			expect(raw).not.toContain('stack');
		});
	});

	it('ログに入力本文を出さない', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		mockSuccess('love');
		await post({ mode: 'love', text: 'ログに出てはいけない文' });
		const logged = info.mock.calls.map((call) => String(call[0])).join('\n');
		expect(logged).not.toContain('ログに出てはいけない文');
		expect(logged).toContain('req_');
	});
});
