/**
 * アプリ内エラーと、クライアントへ返す HTTP レスポンスの対応。
 *
 * docs/ARCHITECTURE.md の §7 HTTP status mapping を実装したもの。
 * 上流の 529 はそのまま返さない（IANA 未登録で CDN・プロキシの扱いが不定なため、
 * アプリは 503 を返す）。
 */

import {
	APIConnectionError,
	APIError,
	APITimeoutError,
	APIUserAbortError,
	TypeSafeError
} from '@typesafe-ai/sdk';
import type { ErrorCode, JudgeErrorBody } from '$lib/types/error';

type ErrorSpec = {
	status: number;
	retryable: boolean;
	message: string;
};

const ERROR_SPECS: Record<ErrorCode, ErrorSpec> = {
	INVALID_INPUT: {
		status: 400,
		retryable: false,
		message: '入力を確認してください。'
	},
	CONFIGURATION_ERROR: {
		// 上流の 401 もここへ寄せる。設定不備を利用者へ露出させない。
		status: 500,
		retryable: false,
		message: '現在ご利用いただけません。しばらくしてからお試しください。'
	},
	QUESTION_DEFINITION_ERROR: {
		// 上流 422。アプリ側のバグなので再試行を促さない。
		status: 500,
		retryable: false,
		message: '判定の準備に失敗しました。'
	},
	RATE_LIMITED: {
		status: 429,
		retryable: true,
		message: 'アクセスが集中しています。少し待って再試行してください。'
	},
	UPSTREAM_UNAVAILABLE: {
		status: 503,
		retryable: true,
		message: '現在 Jev へ接続できません。時間をおいて再試行してください。'
	},
	UPSTREAM_TIMEOUT: {
		status: 504,
		retryable: true,
		message: '判定に時間がかかっています。入力を保持したまま再試行してください。'
	},
	INTERNAL_ERROR: {
		status: 500,
		retryable: false,
		message: '予期しないエラーが発生しました。'
	}
};

export class JudgeError extends Error {
	readonly code: ErrorCode;

	/** サーバーログ専用。クライアントへは返さない。 */
	readonly logDetail?: string;

	constructor(code: ErrorCode, logDetail?: string) {
		super(`${code}${logDetail ? `: ${logDetail}` : ''}`);
		this.name = 'JudgeError';
		this.code = code;
		this.logDetail = logDetail;
	}
}

export function errorStatus(code: ErrorCode): number {
	return ERROR_SPECS[code].status;
}

export function errorBody(code: ErrorCode, requestId: string): JudgeErrorBody {
	const spec = ERROR_SPECS[code];
	return {
		error: {
			code,
			message: spec.message,
			requestId,
			retryable: spec.retryable
		}
	};
}

/**
 * 上流 TypeSafe API の HTTP status をアプリのエラーコードへ写す。
 *
 * ここへ来るのは SDK が retry を使い切った後の最終 status である。
 * SDK の既定 retry 対象は 408 / 429 / 500-599 なので、これらが残って
 * いる場合は「retry しても回復しなかった」ことを意味する。
 */
export function mapUpstreamStatus(status: number): ErrorCode {
	if (status === 401 || status === 403) return 'CONFIGURATION_ERROR';
	if (status === 422) return 'QUESTION_DEFINITION_ERROR';
	if (status === 429) return 'RATE_LIMITED';
	// 408 Request Timeout。SDK の retry 対象なので、残っていれば時間切れ。
	// 利用者には再試行可能な timeout として見せる。
	if (status === 408) return 'UPSTREAM_TIMEOUT';
	// 上流 504 も時間切れとして扱う。529 Overloaded を含むその他の 5xx は障害。
	if (status === 504) return 'UPSTREAM_TIMEOUT';
	if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
	return 'INTERNAL_ERROR';
}

/**
 * SDK の例外をアプリのエラーコードへ写す。
 *
 * SDK は retry を使い切ってから投げるため、ここへ来た時点で「retry しても
 * 回復しなかった」ことが確定している。アプリ側で再送はしない。
 * 例外クラスの一覧は `@typesafe-ai/sdk` の型定義を参照。
 */
export function mapSdkError(error: unknown): ErrorCode {
	// APIUserAbortError: total budget の AbortController が発火した。
	if (error instanceof APIUserAbortError) return 'UPSTREAM_TIMEOUT';

	// APITimeoutError は APIConnectionError のサブクラスなので先に見る。
	if (error instanceof APITimeoutError) return 'UPSTREAM_TIMEOUT';
	if (error instanceof APIConnectionError) return 'UPSTREAM_UNAVAILABLE';

	if (error instanceof APIError) return mapUpstreamStatus(error.status);

	// 設定不備、質問が空、score criteria が 2 件未満などは SDK が
	// リクエスト前に TypeSafeError を投げる。アプリ側のバグである。
	if (error instanceof TypeSafeError) return 'QUESTION_DEFINITION_ERROR';

	return 'INTERNAL_ERROR';
}
