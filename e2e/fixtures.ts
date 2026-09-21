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

/**
 * BATCH JUDGE のレスポンスの見本。
 *
 * 形は docs/BATCH_JUDGE_DESIGN.md §5.5.5 の契約に合わせている。
 * `labelStatus` を落とさない。一致率を状態なしで表示させないため。
 */
export function batchResponse(overrides: Record<string, unknown> = {}) {
	return {
		requestId: 'req_e2e_batch',
		mode: 'batch',
		theme: 'privacy',
		model: 'jev-1.13.0',
		datasetFingerprint: 'sha256-0123456789abcdef',
		caseCount: 4,
		questionCount: 12,
		stateChars: 92,
		upstreamCalls: 1,
		userProvided: true,
		stages: { buildMs: 0.4, upstreamMs: 1018.2, readMs: 0.3, decideMs: 0.2 },
		labelStatus: 'draft',
		latencyMs: 1024,
		usage: { inputTokens: 18_125, outputTokens: 3_404, estimatedCostUsd: 0.00076125 },
		results: [
			{
				caseId: 'privacy_001',
				text: '令和8年度の粗大ごみ収集は、毎月第2・第4水曜日に実施します。',
				verdict: 'no_signal',
				signals: [
					{ key: 'identifies', probability: 0.02 },
					{ key: 'personal', probability: 0.02 },
					{ key: 'sensitive', probability: 0.02 }
				],
				gold: 'no_signal',
				agrees: true
			},
			{
				caseId: 'privacy_022',
				text: '山田花子さん（甲市桜町2-14-3）から、上下水道の名義変更の相談がありました。',
				verdict: 'review',
				signals: [
					{ key: 'identifies', probability: 0.99 },
					{ key: 'personal', probability: 0.96 },
					{ key: 'sensitive', probability: 0.45 }
				],
				gold: 'review',
				agrees: true
			},
			{
				// 判定に使わない sensitive だけが高い。全軸の最大値を出すと
				// 「要確認シグナルなし 97%」になり、シグナルが無いことの
				// 確信度に見える。
				caseId: 'privacy_033',
				text: '生活保護受給世帯の一覧をExcelから抽出しました。',
				verdict: 'no_signal',
				signals: [
					{ key: 'identifies', probability: 0.06 },
					{ key: 'personal', probability: 0.08 },
					{ key: 'sensitive', probability: 0.97 }
				],
				gold: 'no_signal',
				agrees: true
			},
			{
				caseId: 'privacy_043',
				text: '甲市青葉町の空き家について、所有者の氏名と連絡先を調べたい。',
				verdict: 'review',
				signals: [
					{ key: 'identifies', probability: 0.53 },
					{ key: 'personal', probability: 0.28 },
					{ key: 'sensitive', probability: 0.37 }
				],
				gold: 'no_signal',
				agrees: false
			}
		],
		...overrides
	};
}

/** `/api/batch` を差し替える。 */
export async function stubBatch(
	page: Page,
	handler: (call: number) => { status: number; body: unknown; delayMs?: number }
) {
	let calls = 0;
	await page.route('**/api/batch', async (route) => {
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
