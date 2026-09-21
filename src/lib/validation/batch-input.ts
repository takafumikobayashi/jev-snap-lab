/**
 * `POST /api/batch` のリクエスト検証。
 *
 * 受け取るのは `theme` だけである。v0 は同梱した fixture を判定するだけで、
 * 利用者の文章を受け付けない（docs/BATCH_JUDGE_DESIGN.md §3.1、
 * [batch-judge.server.ts](../server/batch-judge.server.ts)）。
 *
 * **入力を受け付けるようにするときは、この検証も一緒に設計し直すこと。**
 * `text` を素通しで足すと、PRIVACY の注意文が無いまま個人情報がJevへ行く。
 */

import { BATCH_THEMES, type BatchTheme } from '$lib/types/batch';

export type BatchValidationFailure = 'NOT_OBJECT' | 'UNKNOWN_FIELD' | 'INVALID_THEME';

export type BatchValidationResult =
	{ ok: true; value: { theme: BatchTheme } } | { ok: false; failure: BatchValidationFailure };

/** リクエストボディで受け付ける唯一のキー集合。 */
const ALLOWED_FIELDS = new Set(['theme']);

export function validateBatchInput(body: unknown): BatchValidationResult {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, failure: 'NOT_OBJECT' };
	}
	// 知らないキーを黙って捨てない。`text` を足したつもりで通ってしまうのを防ぐ。
	for (const key of Object.keys(body)) {
		if (!ALLOWED_FIELDS.has(key)) return { ok: false, failure: 'UNKNOWN_FIELD' };
	}
	const theme = (body as { theme?: unknown }).theme;
	if (typeof theme !== 'string' || !BATCH_THEMES.includes(theme as BatchTheme)) {
		return { ok: false, failure: 'INVALID_THEME' };
	}
	return { ok: true, value: { theme: theme as BatchTheme } };
}
