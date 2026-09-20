/**
 * `/api/judge` のクライアント側ラッパー。
 *
 * 送信中のリクエストは AbortController で中断でき、古いレスポンスを
 * 表示しないための照合キーを呼び出し側へ返す（docs/ARCHITECTURE.md §3）。
 */

import type { JudgeErrorBody } from '$lib/types/error';
import type { JudgeResponse, Mode } from '$lib/types/judge';

export type JudgeOutcome =
	{ ok: true; response: JudgeResponse } | { ok: false; message: string; retryable: boolean };

/** 通信そのものが失敗したときの文言。サーバーのエラー形式とそろえる。 */
const NETWORK_FAILURE: Omit<Extract<JudgeOutcome, { ok: false }>, 'ok'> = {
	message: '通信に失敗しました。接続を確認して再試行してください。',
	retryable: true
};

export async function requestJudge(
	mode: Mode,
	text: string,
	signal: AbortSignal
): Promise<JudgeOutcome> {
	let response: Response;
	try {
		response = await fetch('/api/judge', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode, text }),
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

	if (response.ok) {
		return { ok: true, response: body as JudgeResponse };
	}

	const error = (body as JudgeErrorBody)?.error;
	if (!error?.message) {
		return { ok: false, ...NETWORK_FAILURE };
	}
	return { ok: false, message: error.message, retryable: error.retryable };
}
