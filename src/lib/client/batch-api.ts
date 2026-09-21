/**
 * `/api/batch` のクライアント側ラッパー。
 *
 * `requestJudge` と同じ形にする。送信中のリクエストは AbortController で
 * 中断でき、失敗はサーバーのエラー形式へそろえる。
 */

import type { JudgeErrorBody } from '$lib/types/error';
import type { BatchJudgeResponse, BatchTheme } from '$lib/types/batch';

export type BatchOutcome =
	{ ok: true; response: BatchJudgeResponse } | { ok: false; message: string; retryable: boolean };

const NETWORK_FAILURE: Omit<Extract<BatchOutcome, { ok: false }>, 'ok'> = {
	message: '通信に失敗しました。接続を確認して再試行してください。',
	retryable: true
};

export async function requestBatch(theme: BatchTheme, signal: AbortSignal): Promise<BatchOutcome> {
	let response: Response;
	try {
		response = await fetch('/api/batch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ theme }),
			signal
		});
	} catch (error) {
		// 呼び出し側が中断した場合は、呼び出し側が結果を捨てる。
		if (error instanceof DOMException && error.name === 'AbortError') throw error;
		return { ok: false, ...NETWORK_FAILURE };
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, ...NETWORK_FAILURE };
	}

	if (response.ok) return { ok: true, response: body as BatchJudgeResponse };

	const failure = (body as JudgeErrorBody)?.error;
	if (!failure?.message) return { ok: false, ...NETWORK_FAILURE };
	return { ok: false, message: failure.message, retryable: failure.retryable };
}
