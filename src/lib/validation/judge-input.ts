/**
 * `POST /api/judge` のリクエスト検証。
 *
 * 出所は docs/JEV_DESIGN.md の §10 と docs/ARCHITECTURE.md の §3。
 * クライアント側の `maxlength` に依存せず、サーバーで必ず検証する。
 */

import {
	countCodePoints,
	isMode,
	isWithinLengthLimit,
	MAX_INPUT_CODE_POINTS,
	type JudgeRequest
} from '$lib/types/judge';

export type ValidationFailure =
	| 'NOT_JSON'
	| 'NOT_OBJECT'
	| 'UNKNOWN_FIELD'
	| 'INVALID_MODE'
	| 'TEXT_NOT_STRING'
	| 'TEXT_BLANK'
	| 'TEXT_CONTROL_CHARACTER'
	| 'TEXT_TOO_LONG';

export type ValidationResult =
	{ ok: true; value: JudgeRequest } | { ok: false; failure: ValidationFailure };

/** リクエストボディで受け付ける唯一のキー集合。 */
const ALLOWED_FIELDS = new Set(['mode', 'text']);

/** 入力として許可する制御文字。改行はPRODUCT_SPEC §5 で明示的に許可されている。 */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]); // TAB / LF / CR

/**
 * 許可済み以外の C0 / C1 制御文字を含むか。
 *
 * 人間の文章に現れず、ログや表示を壊す用途にしか使われないため拒否する。
 * 正規表現ではなくコードポイントで判定するのは、意図が読み取れる形にして
 * `no-control-regex` の抑制コメントを避けるため。
 */
export function hasForbiddenControlCharacter(text: string): boolean {
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (ALLOWED_CONTROL.has(code)) continue;
		if (code <= 0x1f) return true; // C0
		if (code >= 0x7f && code <= 0x9f) return true; // DEL と C1
	}
	return false;
}

/**
 * リクエストボディを検証して `JudgeRequest` へ絞り込む。
 *
 * 入力本文はエラー情報へ含めない。呼び出し側が失敗理由をログへ出す場合も、
 * `ValidationFailure` の列挙値だけを使う。
 */
export function validateJudgeInput(body: unknown): ValidationResult {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, failure: 'NOT_OBJECT' };
	}

	const record = body as Record<string, unknown>;

	for (const key of Object.keys(record)) {
		if (!ALLOWED_FIELDS.has(key)) return { ok: false, failure: 'UNKNOWN_FIELD' };
	}

	if (!isMode(record.mode)) return { ok: false, failure: 'INVALID_MODE' };
	if (typeof record.text !== 'string') return { ok: false, failure: 'TEXT_NOT_STRING' };

	const text = record.text;

	// 長さを先に見る。巨大な入力へ正規表現を走らせない。
	if (!isWithinLengthLimit(text)) return { ok: false, failure: 'TEXT_TOO_LONG' };
	if (hasForbiddenControlCharacter(text)) return { ok: false, failure: 'TEXT_CONTROL_CHARACTER' };
	if (text.trim().length === 0) return { ok: false, failure: 'TEXT_BLANK' };

	return { ok: true, value: { mode: record.mode, text } };
}

/** 入力本文を含まない、ログ用の短い説明。 */
export function describeFailure(failure: ValidationFailure, text?: unknown): string {
	if (failure === 'TEXT_TOO_LONG' && typeof text === 'string') {
		return `TEXT_TOO_LONG (${countCodePoints(text)} > ${MAX_INPUT_CODE_POINTS})`;
	}
	return failure;
}
