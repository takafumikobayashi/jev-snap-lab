/**
 * 判定結果を画面へ適用してよいかの判断。
 *
 * abort とレスポンス解決は競合する。`AbortController.abort()` を呼んでも、
 * fetch が既に解決していれば例外は飛ばず、そのまま結果が返ってくる。
 * abort だけに頼らず、適用直前に「今の画面の状態に対する答えか」を
 * 確認する（docs/ARCHITECTURE.md §3）。
 */

import type { Mode } from '$lib/types/judge';

export type Submission = {
	/** 送信ごとの通し番号。追い越しを検出する。 */
	id: number;
	/** 送信時点のモード。 */
	mode: Mode;
	/** 送信時点の入力文。 */
	text: string;
};

/**
 * 結果を適用してよいか。
 *
 * 通し番号が最新であることに加えて、モードと入力文が送信時から
 * 変わっていないことを要求する。判定中も textarea を編集できるため、
 * 番号だけでは「入力文と一致しない結果」を止められない。
 */
export function shouldApplyResult(submission: Submission, current: Submission): boolean {
	return (
		submission.id === current.id &&
		submission.mode === current.mode &&
		submission.text === current.text
	);
}
