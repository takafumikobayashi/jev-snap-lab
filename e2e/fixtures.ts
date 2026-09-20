import type { Page } from '@playwright/test';

/**
 * 判定レスポンスの見本。
 *
 * 上流を呼ばずに UI を検証するため、ブラウザ側で `/api/judge` を差し替える。
 * 形は docs/JEV_DESIGN.md の §8 の契約に合わせている。
 */
export function judgeResponse(overrides: Record<string, unknown> = {}) {
	return {
		requestId: 'req_e2e',
		mode: 'love',
		model: 'jev-1.13.0',
		latencyMs: 148,
		usage: { inputTokens: 944, outputTokens: 65, estimatedCostUsd: 0.00003965 },
		results: [
			{
				id: 'romantic_frame',
				label: '恋愛的な読み',
				kind: 'choice',
				selected: 'lingering',
				options: [
					{ key: 'lingering', label: '未練', probability: 0.72 },
					{ key: 'breakup', label: '失恋・別れ', probability: 0.21 },
					{ key: 'passionate', label: '熱愛', probability: 0.05 },
					{ key: 'unrequited', label: '片思い', probability: 0.02 }
				],
				confidence: 0.81
			},
			{
				id: 'love_signal_strength',
				label: '恋愛シグナルの強さ',
				kind: 'score',
				score: 2.4,
				legend: { 0: '含意なし', 1: '弱い', 2: '明確', 3: '非常に強い' },
				probabilities: { 0: 0.0, 1: 0.05, 2: 0.5, 3: 0.45 },
				confidence: 0.55
			},
			{
				id: 'still_loves',
				label: 'まだ気持ちがある？',
				kind: 'noul',
				yesProbability: 0.84
			}
		],
		...overrides
	};
}

export function errorBody(code: string, message: string, retryable: boolean) {
	return { error: { code, message, requestId: 'req_e2e', retryable } };
}

/** `/api/judge` を差し替える。`handler` は呼ばれた回数を受け取る。 */
export async function stubJudge(
	page: Page,
	handler: (call: number) => { status: number; body: unknown; delayMs?: number }
) {
	let calls = 0;
	await page.route('**/api/judge', async (route) => {
		calls += 1;
		const { status, body, delayMs } = handler(calls);
		if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
		await route.fulfill({
			status,
			contentType: 'application/json; charset=utf-8',
			body: JSON.stringify(body)
		});
	});
}
