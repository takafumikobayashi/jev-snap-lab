/**
 * `POST /api/batch` のリクエスト検証。
 *
 * `theme` と `cases` の両方が必須である。**この API は渡された文章を判定する
 * だけで、同梱データを判定する経路を持たない。** 持たせると「貼った文章が
 * たまたま例文と同じだったときだけ一致率が出る」という不可解な挙動になる。
 *
 * 利用者の文章を受け付ける以上、画面には送信する旨を入力欄の手前へ常時出し、
 * デモ用の例文をワンクリックで入れられるようにする
 * （docs/BATCH_JUDGE_DESIGN.md §3.1）。検証だけでは守れない。
 */

import { BATCH_THEMES, type BatchTheme } from '$lib/types/batch';
import { MAX_CASES, MAX_CASE_CHARS } from '$lib/server/batch-dataset.server';
import { countCodePoints } from '$lib/types/judge';
import { hasForbiddenControlCharacter } from './judge-input';

export type BatchValidationFailure =
	| 'NOT_OBJECT'
	| 'UNKNOWN_FIELD'
	| 'INVALID_THEME'
	| 'CASES_NOT_ARRAY'
	| 'CASES_EMPTY'
	| 'TOO_MANY_CASES'
	| 'CASE_NOT_STRING'
	| 'CASE_BLANK'
	| 'CASE_TOO_LONG'
	| 'CASE_CONTROL_CHARACTER';

export type BatchValidationResult =
	| { ok: true; value: { theme: BatchTheme; cases: string[] } }
	| { ok: false; failure: BatchValidationFailure };

/** リクエストボディで受け付ける唯一のキー集合。 */
const ALLOWED_FIELDS = new Set(['theme', 'cases']);

export function validateBatchInput(body: unknown): BatchValidationResult {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, failure: 'NOT_OBJECT' };
	}
	// 知らないキーを黙って捨てない。綴り違いが「省略」と区別できなくなる。
	for (const key of Object.keys(body)) {
		if (!ALLOWED_FIELDS.has(key)) return { ok: false, failure: 'UNKNOWN_FIELD' };
	}

	const { theme, cases } = body as { theme?: unknown; cases?: unknown };
	if (typeof theme !== 'string' || !BATCH_THEMES.includes(theme as BatchTheme)) {
		return { ok: false, failure: 'INVALID_THEME' };
	}
	if (!Array.isArray(cases)) return { ok: false, failure: 'CASES_NOT_ARRAY' };
	if (cases.length === 0) return { ok: false, failure: 'CASES_EMPTY' };
	if (cases.length > MAX_CASES) return { ok: false, failure: 'TOO_MANY_CASES' };

	for (const value of cases) {
		if (typeof value !== 'string') return { ok: false, failure: 'CASE_NOT_STRING' };
		if (value.trim().length === 0) return { ok: false, failure: 'CASE_BLANK' };
		// 数え方は画面の入力上限と同じ。UTF-16 の length では日本語を短く切る。
		if (countCodePoints(value) > MAX_CASE_CHARS) return { ok: false, failure: 'CASE_TOO_LONG' };
		// 1件が1行に対応する。改行を含む時点で行の切り出しが壊れている。
		if (/[\r\n]/.test(value)) return { ok: false, failure: 'CASE_CONTROL_CHARACTER' };
		if (hasForbiddenControlCharacter(value)) {
			return { ok: false, failure: 'CASE_CONTROL_CHARACTER' };
		}
	}

	return { ok: true, value: { theme: theme as BatchTheme, cases: cases as string[] } };
}

/**
 * 失敗の理由を画面へ出せる文にする。
 *
 * **入力本文は含めない。** 件数と上限だけを示す。
 */
export function describeBatchFailure(failure: BatchValidationFailure): string {
	switch (failure) {
		case 'CASES_EMPTY':
			return '判定する文章がありません。1行に1件ずつ入力してください。';
		case 'TOO_MANY_CASES':
			return `一度に判定できるのは ${MAX_CASES} 件までです。`;
		case 'CASE_TOO_LONG':
			return `1件あたり ${MAX_CASE_CHARS} 文字までです。`;
		case 'CASE_BLANK':
		case 'CASE_NOT_STRING':
		case 'CASE_CONTROL_CHARACTER':
		case 'CASES_NOT_ARRAY':
			return '入力の形式が正しくありません。';
		default:
			return 'リクエストの形式が正しくありません。';
	}
}
