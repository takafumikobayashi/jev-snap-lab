/**
 * クライアントへ返すエラー形式。
 *
 * 内部の stack trace、TypeSafe の生レスポンス、API キー、入力本文、
 * criteria 全文は決して含めない。出所は docs/ARCHITECTURE.md の §7。
 */

export const ERROR_CODES = [
	'INVALID_INPUT',
	'CONFIGURATION_ERROR',
	'QUESTION_DEFINITION_ERROR',
	'RATE_LIMITED',
	'UPSTREAM_UNAVAILABLE',
	'UPSTREAM_TIMEOUT',
	'INTERNAL_ERROR'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type JudgeErrorBody = {
	error: {
		code: ErrorCode;
		/** 利用者向けの日本語文言。入力本文を埋め込まない。 */
		message: string;
		requestId: string;
		/** そのまま再送して回復し得るか。UI の再試行ボタンの出し分けに使う。 */
		retryable: boolean;
	};
};
