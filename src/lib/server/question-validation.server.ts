/**
 * Jev へ送る前の質問定義の検証。
 *
 * 3つの type で `criteria` のJSON型が異なり、間違えると 422 が返る。
 * 送信前に弾いて、上流のトークンとレイテンシを無駄にしない。
 * 制約の出所は docs/JEV_DESIGN.md の §4。
 */

import type { Question, Questions } from '@typesafe-ai/sdk';

/** Choice の候補数上限（公式 API reference）。 */
export const MAX_CHOICE_OPTIONS = 255;

/** Score のレベル数の下限と上限（公式 API reference）。 */
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

export type QuestionDefect = {
	questionId: string;
	reason: string;
};

/**
 * 質問群を検証し、問題があれば列挙して返す。
 *
 * 空配列なら送信してよい。返す文字列は開発者向けのログ用で、
 * クライアントへは渡さない。
 */
export function findQuestionDefects(questions: Questions): QuestionDefect[] {
	const defects: QuestionDefect[] = [];

	const ids = Object.keys(questions);
	if (ids.length === 0) {
		return [{ questionId: '(none)', reason: '質問が空である' }];
	}

	for (const id of ids) {
		const reason = defectOf(questions[id]);
		if (reason) defects.push({ questionId: id, reason });
	}

	return defects;
}

function defectOf(question: Question): string | null {
	if (question.type === 'choice') {
		const criteria = question.criteria;
		if (criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) {
			return 'Choice の criteria は map である必要がある';
		}
		const options = Object.keys(criteria);
		if (options.length < 2) {
			return `Choice の候補が ${options.length} 件しかない`;
		}
		if (options.length > MAX_CHOICE_OPTIONS) {
			return `Choice の候補が ${options.length} 件で上限 ${MAX_CHOICE_OPTIONS} を超える`;
		}
		return null;
	}

	if (question.type === 'score') {
		const criteria = question.criteria;
		if (!Array.isArray(criteria)) {
			// map で組み立てると 422 になる。最も起こしやすい取り違え。
			return 'Score の criteria は配列である必要がある';
		}
		if (criteria.length < MIN_SCORE_LEVELS) {
			return `Score のレベルが ${criteria.length} 段しかない（最低 ${MIN_SCORE_LEVELS}）`;
		}
		if (criteria.length > MAX_SCORE_LEVELS) {
			return `Score のレベルが ${criteria.length} 段で上限 ${MAX_SCORE_LEVELS} を超える`;
		}
		return null;
	}

	if (question.type === 'noul') {
		const criteria = question.criteria;
		if (criteria === undefined || criteria === null) return null; // criteria は省略可
		if (typeof criteria !== 'object' || Array.isArray(criteria)) {
			return 'Noul の criteria は true / false を持つオブジェクトである必要がある';
		}
		const keys = Object.keys(criteria);
		const unexpected = keys.filter((key) => key !== 'true' && key !== 'false');
		if (unexpected.length > 0) {
			return `Noul の criteria に想定外のキーがある: ${unexpected.join(', ')}`;
		}
		return null;
	}

	return `未知の question type: ${String((question as { type?: unknown }).type)}`;
}
