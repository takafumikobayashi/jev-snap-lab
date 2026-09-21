import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchJudgeResponse } from '$lib/types/batch';
import type { JudgeErrorBody } from '$lib/types/error';
import { JudgeError } from '$lib/server/errors.server';

// Jev への実通信を差し替える。ルート側の責務（feature flag、Content-Type、
// 入力検証、レスポンス組み立て、エラー変換）だけを検証する。
const evaluate = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/jev-client.server', () => ({ evaluate }));

const enabled = vi.hoisted(() => ({ value: 'true' }));
vi.mock('$env/dynamic/private', () => ({
	env: {
		get BATCH_JUDGE_ENABLED() {
			return enabled.value;
		}
	}
}));

const { POST } = await import('./+server');
const { buildBatchRequest } = await import('$lib/server/batch-questions.server');
const { loadDataset } = await import('$lib/server/batch-judge.server');

function mockSuccess(theme: 'privacy' | 'deadline' | 'dx') {
	const request = buildBatchRequest(loadDataset(theme));
	evaluate.mockResolvedValue({
		result: {
			model: 'jev-1.13.0',
			usage: { input_tokens: 18_000, output_tokens: 3_000 },
			answers: Object.fromEntries(
				Object.keys(request.questions).map((id) => [
					id,
					id.endsWith('__class')
						? { type: 'choice', choice: 'soon', confidence: 0.8 }
						: id.endsWith('__first_move')
							? { type: 'choice', choice: 'bpr', confidence: 0.8 }
							: { type: 'noul', noul: 0.2 }
				])
			)
		},
		latencyMs: 420,
		config: { inputPricePerMillionTokens: 0.042 }
	});
}

function post(body: unknown, contentType = 'application/json') {
	return POST({
		request: new Request('http://localhost/api/batch', {
			method: 'POST',
			headers: { 'Content-Type': contentType },
			body: typeof body === 'string' ? body : JSON.stringify(body)
		}),
		getClientAddress: () => '203.0.113.9'
	} as never);
}

beforeEach(() => {
	evaluate.mockReset();
	enabled.value = 'true';
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('POST /api/batch', () => {
	it('テーマを指定して全件の結果を返す', async () => {
		mockSuccess('privacy');
		const response = await post({ theme: 'privacy' });
		expect(response.status).toBe(200);

		const body = (await response.json()) as BatchJudgeResponse;
		expect(body.mode).toBe('batch');
		expect(body.theme).toBe('privacy');
		expect(body.results).toHaveLength(50);
		expect(body.questionCount).toBe(150);
		expect(body.model).toBe('jev-1.13.0');
		expect(body.usage.inputTokens).toBe(18_000);
		expect(body.usage.estimatedCostUsd).toBeCloseTo((18_000 / 1_000_000) * 0.042, 12);
		// 一致率を状態なしで表示できないようにする。
		expect(body.labelStatus).toBe('draft');
		expect(body.datasetFingerprint).toMatch(/^sha256-/);
	});

	it('DEADLINE は基準日を返す', async () => {
		mockSuccess('deadline');
		const body = (await (await post({ theme: 'deadline' })).json()) as BatchJudgeResponse;
		expect(body.referenceDate).toBe('2026-09-21');
	});

	it('1リクエストで済ませる', async () => {
		mockSuccess('dx');
		await post({ theme: 'dx' });
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	describe('受け付けないリクエスト', () => {
		it('feature flag が無効なら 404', async () => {
			enabled.value = 'false';
			const response = await post({ theme: 'privacy' });
			expect(response.status).toBe(404);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('true 以外の値では有効にならない', async () => {
			enabled.value = '1';
			expect((await post({ theme: 'privacy' })).status).toBe(404);
		});

		it('未知のテーマを拒む', async () => {
			const response = await post({ theme: 'unknown' });
			expect(response.status).toBe(400);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('知らないキーを拒む', async () => {
			// `text` を足したつもりで通ってしまうのを防ぐ。入力を受け付ける
			// ときは、PRIVACY の注意文と一緒に設計し直す。
			const response = await post({ theme: 'privacy', text: '山田花子さんの相談' });
			expect(response.status).toBe(400);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('JSON でない Content-Type を拒む', async () => {
			expect((await post({ theme: 'privacy' }, 'text/plain')).status).toBe(400);
		});

		it('壊れた JSON を拒む', async () => {
			expect((await post('{', 'application/json')).status).toBe(400);
		});
	});

	it('上流の失敗をエラー封筒へ変換する', async () => {
		evaluate.mockRejectedValue(new JudgeError('UPSTREAM_UNAVAILABLE', 'detail'));
		const response = await post({ theme: 'privacy' });
		expect(response.status).toBe(503);
		const body = (await response.json()) as JudgeErrorBody;
		expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
	});

	it('answer が欠けたら 200 を返さない', async () => {
		// 200 が返ることは、全部の質問に答えた証明にならない。
		const request = buildBatchRequest(loadDataset('privacy'));
		const ids = Object.keys(request.questions).slice(1);
		evaluate.mockResolvedValue({
			result: {
				model: 'jev-1.13.0',
				usage: { input_tokens: 1, output_tokens: 1 },
				answers: Object.fromEntries(ids.map((id) => [id, { type: 'noul', noul: 0.2 }]))
			},
			latencyMs: 1,
			config: { inputPricePerMillionTokens: 0.042 }
		});
		expect((await post({ theme: 'privacy' })).status).toBe(503);
	});

	it('入力本文をログへ出さない', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		mockSuccess('privacy');
		await post({ theme: 'privacy' });
		const logged = info.mock.calls.map((call) => String(call[0])).join('\n');
		expect(logged).not.toContain(loadDataset('privacy').cases[0].text);
	});
});
