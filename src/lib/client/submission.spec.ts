import { describe, expect, it } from 'vitest';
import { shouldApplyResult, type Submission } from './submission';

const base: Submission = { id: 1, mode: 'love', text: 'もう君のことは忘れたはずなのに' };

describe('shouldApplyResult', () => {
	it('同じ送信の結果は適用する', () => {
		expect(shouldApplyResult(base, { ...base })).toBe(true);
	});

	it('追い越された古い結果は捨てる', () => {
		expect(shouldApplyResult(base, { ...base, id: 2 })).toBe(false);
	});

	it('モードが切り替わっていたら捨てる', () => {
		// abort が間に合わずレスポンスが先に解決した場合、通し番号だけでは
		// 止まらないことがある。モードの一致を独立に要求する。
		expect(shouldApplyResult(base, { ...base, mode: 'city' })).toBe(false);
	});

	it('入力文が変わっていたら捨てる', () => {
		// 判定中も textarea は編集できる。表示中の入力文と一致しない結果を
		// 出すと、どの文への判定か分からなくなる。
		expect(shouldApplyResult(base, { ...base, text: '別の文' })).toBe(false);
	});

	it('入力文の末尾1文字の違いも検出する', () => {
		expect(shouldApplyResult(base, { ...base, text: base.text + '。' })).toBe(false);
	});

	it('複数の条件が同時に変わっていても捨てる', () => {
		expect(shouldApplyResult(base, { id: 3, mode: 'social', text: 'x' })).toBe(false);
	});
});
