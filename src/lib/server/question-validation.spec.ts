import { describe, expect, it } from 'vitest';
import type { Questions } from '@typesafe-ai/sdk';
import {
	findQuestionDefects,
	MAX_CHOICE_OPTIONS,
	MAX_SCORE_LEVELS
} from './question-validation.server';

/** 型検査を迂回して不正な定義を作る。実行時の取り違えを再現するため。 */
const bad = (question: unknown): Questions => ({ q: question }) as Questions;

describe('findQuestionDefects', () => {
	it('正しい定義には欠陥を報告しない', () => {
		const questions = bad({ type: 'choice', instructions: 'x', criteria: { a: null, b: null } });
		expect(findQuestionDefects(questions)).toEqual([]);
	});

	it('質問が空なら報告する', () => {
		expect(findQuestionDefects({})).toHaveLength(1);
	});

	describe('Score', () => {
		it('criteria を map で書いた取り違えを検出する', () => {
			// 最も起こしやすい間違い。実機では 422 になる。
			const defects = findQuestionDefects(
				bad({ type: 'score', instructions: 'x', criteria: { 0: 'low', 1: 'high' } })
			);
			expect(defects).toHaveLength(1);
			expect(defects[0].reason).toContain('配列');
		});

		it('レベルが1段だけなら検出する', () => {
			const defects = findQuestionDefects(bad({ type: 'score', criteria: ['only'] }));
			expect(defects[0].reason).toContain('最低');
		});

		it('レベルが上限を超えたら検出する', () => {
			const criteria = Array.from({ length: MAX_SCORE_LEVELS + 1 }, (_, i) => `L${i}`);
			const defects = findQuestionDefects(bad({ type: 'score', criteria }));
			expect(defects[0].reason).toContain(String(MAX_SCORE_LEVELS));
		});

		it('ちょうど上限は通す', () => {
			const criteria = Array.from({ length: MAX_SCORE_LEVELS }, (_, i) => `L${i}`);
			expect(findQuestionDefects(bad({ type: 'score', criteria }))).toEqual([]);
		});
	});

	describe('Choice', () => {
		it('criteria を配列で書いた取り違えを検出する', () => {
			const defects = findQuestionDefects(bad({ type: 'choice', criteria: ['a', 'b'] }));
			expect(defects[0].reason).toContain('map');
		});

		it('候補が1件だけなら検出する', () => {
			const defects = findQuestionDefects(bad({ type: 'choice', criteria: { only: null } }));
			expect(defects[0].reason).toContain('1 件');
		});

		it('候補が上限を超えたら検出する', () => {
			const criteria = Object.fromEntries(
				Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [`k${i}`, null])
			);
			const defects = findQuestionDefects(bad({ type: 'choice', criteria }));
			expect(defects[0].reason).toContain(String(MAX_CHOICE_OPTIONS));
		});
	});

	describe('Noul', () => {
		it('criteria 省略を許す', () => {
			expect(findQuestionDefects(bad({ type: 'noul', instructions: 'x' }))).toEqual([]);
			expect(findQuestionDefects(bad({ type: 'noul', criteria: null }))).toEqual([]);
		});

		it('true / false 以外のキーを検出する', () => {
			const defects = findQuestionDefects(bad({ type: 'noul', criteria: { true: 'y', no: 'n' } }));
			expect(defects[0].reason).toContain('no');
		});

		it('配列で書いた取り違えを検出する', () => {
			const defects = findQuestionDefects(bad({ type: 'noul', criteria: ['y', 'n'] }));
			expect(defects[0].reason).toContain('true / false');
		});
	});

	it('未知の type を検出する', () => {
		const defects = findQuestionDefects(bad({ type: 'ranking', criteria: {} }));
		expect(defects[0].reason).toContain('未知');
	});

	it('複数の欠陥をまとめて報告する', () => {
		const questions = {
			a: { type: 'score', criteria: { 0: 'x' } },
			b: { type: 'choice', criteria: ['x'] }
		} as unknown as Questions;
		expect(findQuestionDefects(questions)).toHaveLength(2);
	});
});
