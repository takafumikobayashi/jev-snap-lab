import { describe, expect, it } from 'vitest';
import {
	countCodePoints,
	isMode,
	isWithinLengthLimit,
	MAX_INPUT_CODE_POINTS,
	MODES
} from './judge';

describe('isMode', () => {
	it('既知のモードだけを受け付ける', () => {
		// spec は実験機能。型としては既知だが、サーバーが
		// SPEC_FIND_ENABLED を見て受理を決める（spec-find-flag.spec.ts）。
		expect(MODES).toEqual(['love', 'social', 'city', 'spec']);
		for (const mode of MODES) expect(isMode(mode)).toBe(true);
	});

	it('未知の値を拒否する', () => {
		for (const value of ['LOVE', 'other', '', null, undefined, 1, {}]) {
			expect(isMode(value)).toBe(false);
		}
	});
});

describe('countCodePoints', () => {
	it('ASCII と日本語は見た目どおり数える', () => {
		expect(countCodePoints('')).toBe(0);
		expect(countCodePoints('abc')).toBe(3);
		expect(countCodePoints('もう君のことは')).toBe(7);
	});

	it('サロゲートペアを1文字として数える', () => {
		// UTF-16 の length では 2 になるが、利用者にとっては 1 文字。
		expect('👍'.length).toBe(2);
		expect(countCodePoints('👍')).toBe(1);
	});

	it('サロゲートペアの漢字も1文字として数える', () => {
		// U+20BB7（𠮷）。日本語の人名・地名で実際に現れる。
		expect('𠮷'.length).toBe(2);
		expect(countCodePoints('𠮷野家')).toBe(3);
	});

	it('改行とタブも1文字として数える', () => {
		expect(countCodePoints('a\nb\tc')).toBe(5);
	});

	it('ZWJ 連結の絵文字は構成 code point の数になる', () => {
		// 家族絵文字は見た目1文字でも複数 code point。
		// grapheme cluster ではなく code point で数える仕様を明示しておく。
		const family = '👨‍👩‍👧';
		expect(countCodePoints(family)).toBe(5);
	});
});

describe('isWithinLengthLimit', () => {
	it('ちょうど 280 code points は通す', () => {
		expect(isWithinLengthLimit('あ'.repeat(MAX_INPUT_CODE_POINTS))).toBe(true);
	});

	it('281 code points は拒否する', () => {
		expect(isWithinLengthLimit('あ'.repeat(MAX_INPUT_CODE_POINTS + 1))).toBe(false);
	});

	it('絵文字 280 個を length 基準で誤って拒否しない', () => {
		// length では 560 になるが code point では 280 なので通すべき。
		const input = '👍'.repeat(MAX_INPUT_CODE_POINTS);
		expect(input.length).toBe(MAX_INPUT_CODE_POINTS * 2);
		expect(isWithinLengthLimit(input)).toBe(true);
	});

	it('絵文字 281 個は拒否する', () => {
		expect(isWithinLengthLimit('👍'.repeat(MAX_INPUT_CODE_POINTS + 1))).toBe(false);
	});

	it('空文字は長さ制約には違反しない（空白のみの拒否は別の検証）', () => {
		expect(isWithinLengthLimit('')).toBe(true);
	});
});
