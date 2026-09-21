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

function mockSuccess(theme: 'privacy' | 'deadline' | 'dx', cases?: string[]) {
	const dataset = loadDataset(theme);
	const texts = cases ?? dataset.cases.map((item) => item.text);
	const request = buildBatchRequest(
		dataset,
		texts.map((text, at) => ({
			id: `${theme}_input_${String(at + 1).padStart(3, '0')}`,
			text,
			difficulty: 'medium' as const
		})) as never
	);
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

/**
 * 送信元は毎回変える。
 *
 * レート制限はモジュールスコープで、既定は10件/分である。同じアドレスを
 * 使い回すとテストが増えたときに 429 になり、**検証したいものと無関係な
 * 理由で落ちる。** 実際に踏んだ。レート制限そのものの検証は別に書く。
 */
let caller = 0;
function post(body: unknown, contentType = 'application/json') {
	caller += 1;
	return POST({
		request: new Request('http://localhost/api/batch', {
			method: 'POST',
			headers: { 'Content-Type': contentType },
			body: typeof body === 'string' ? body : JSON.stringify(body)
		}),
		getClientAddress: () => `203.0.113.${caller % 200}`
	} as never);
}

beforeEach(() => {
	evaluate.mockReset();
	enabled.value = 'true';
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('POST /api/batch', () => {
	it('渡した文章の結果を返す', async () => {
		const texts = loadDataset('privacy').cases.map((item) => item.text);
		mockSuccess('privacy', texts);
		const response = await post({ theme: 'privacy', cases: texts });
		expect(response.status).toBe(200);

		const body = (await response.json()) as BatchJudgeResponse;
		expect(body.mode).toBe('batch');
		expect(body.theme).toBe('privacy');
		expect(body.results).toHaveLength(50);
		expect(body.questionCount).toBe(150);
		expect(body.model).toBe('jev-1.13.0');
		expect(body.usage.inputTokens).toBe(18_000);
		expect(body.usage.estimatedCostUsd).toBeCloseTo((18_000 / 1_000_000) * 0.042, 12);
		// **評価の概念を持たない。** 自由に貼った50件に正解は無い。
		expect(body).not.toHaveProperty('labelStatus');
		expect(body).not.toHaveProperty('datasetFingerprint');
		expect(body.results[0]).not.toHaveProperty('gold');
	});

	it('DEADLINE は基準日を返す', async () => {
		const texts = ['本日17時までに回答してください'];
		mockSuccess('deadline', texts);
		const body = (await (
			await post({ theme: 'deadline', cases: texts })
		).json()) as BatchJudgeResponse;
		expect(body.referenceDate).toBe('2026-09-21');
	});

	it('1リクエストで済ませる', async () => {
		mockSuccess('dx', ['紙の台帳を探すのに時間がかかる']);
		await post({ theme: 'dx', cases: ['紙の台帳を探すのに時間がかかる'] });
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	describe('受け付けないリクエスト', () => {
		it('feature flag が無効なら 404', async () => {
			enabled.value = 'false';
			const response = await post({ theme: 'privacy', cases: ['x'] });
			expect(response.status).toBe(404);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('true 以外の値では有効にならない', async () => {
			enabled.value = '1';
			expect((await post({ theme: 'privacy', cases: ['x'] })).status).toBe(404);
		});

		it('未知のテーマを拒む', async () => {
			const response = await post({ theme: 'unknown', cases: ['x'] });
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
			expect((await post({ theme: 'privacy', cases: ['x'] }, 'text/plain')).status).toBe(400);
		});

		it('cases が無いリクエストを拒む', async () => {
			// この API は渡された文章を判定するだけで、同梱データを判定する
			// 経路を持たない。
			const response = await post({ theme: 'privacy' });
			expect(response.status).toBe(400);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('壊れた JSON を拒む', async () => {
			expect((await post('{', 'application/json')).status).toBe(400);
		});
	});

	it('上流の失敗をエラー封筒へ変換する', async () => {
		evaluate.mockRejectedValue(new JudgeError('UPSTREAM_UNAVAILABLE', 'detail'));
		const response = await post({ theme: 'privacy', cases: ['x'] });
		expect(response.status).toBe(503);
		const body = (await response.json()) as JudgeErrorBody;
		expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
	});

	it('answer が欠けたら 200 を返さない', async () => {
		// 200 が返ることは、全部の質問に答えた証明にならない。
		const texts = loadDataset('privacy').cases.map((item) => item.text);
		mockSuccess('privacy', texts);
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
		expect((await post({ theme: 'privacy', cases: texts })).status).toBe(503);
	});

	it('利用者の文章を判定する', async () => {
		const cases = ['明日の会議室を予約したい', '来客用の駐車場を確保したい'];
		mockSuccess('privacy', cases);
		const body = (await (await post({ theme: 'privacy', cases })).json()) as BatchJudgeResponse;

		expect(body.caseCount).toBe(2);
		expect(body.questionCount).toBe(6);
		expect(body.results.map((result) => result.text)).toEqual(cases);
		// 処理の流れに出す値。
		expect(body.stateChars).toBe(25);
		expect(body.upstreamCalls).toBe(1);
	});

	it('利用者の文章をログへ出さない', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const cases = ['山田花子さんの相談記録'];
		mockSuccess('privacy', cases);
		await post({ theme: 'privacy', cases });
		const logged = info.mock.calls.map((call) => String(call[0])).join('\n');
		expect(logged).not.toContain('山田花子');
	});

	it('同じ送信元を連打すると 429 になる', async () => {
		// 上の post() は送信元を毎回変える。ここだけ固定して枠を使い切る。
		const fixed = (body: unknown) =>
			POST({
				request: new Request('http://localhost/api/batch', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				}),
				getClientAddress: () => '198.51.100.7'
			} as never);

		mockSuccess('privacy', ['あ']);
		const statuses: number[] = [];
		for (let at = 0; at < 12; at += 1) {
			statuses.push((await fixed({ theme: 'privacy', cases: ['あ'] })).status);
		}
		expect(statuses).toContain(429);
	});

	it('入力本文をログへ出さない', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const texts = loadDataset('privacy').cases.map((item) => item.text);
		mockSuccess('privacy', texts);
		await post({ theme: 'privacy', cases: texts });
		const logged = info.mock.calls.map((call) => String(call[0])).join('\n');
		expect(logged).not.toContain(texts[0]);
	});
});
