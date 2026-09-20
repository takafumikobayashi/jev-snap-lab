import { describe, expect, it } from 'vitest';
import { isMode, MAX_INPUT_CODE_POINTS, MODES } from './judge';

describe('isMode', () => {
	it('3つのモードだけを受け付ける', () => {
		expect(MODES).toEqual(['love', 'social', 'city']);
		for (const mode of MODES) expect(isMode(mode)).toBe(true);
	});

	it('未知の値を拒否する', () => {
		for (const value of ['LOVE', 'other', '', null, undefined, 1, {}]) {
			expect(isMode(value)).toBe(false);
		}
	});
});

describe('MAX_INPUT_CODE_POINTS', () => {
	it('280 である', () => {
		expect(MAX_INPUT_CODE_POINTS).toBe(280);
	});

	it('サロゲートペアは code point で1文字と数える', () => {
		// 絵文字1つは UTF-16 の length では 2、code point では 1。
		const emoji = '👍';
		expect(emoji.length).toBe(2);
		expect([...emoji].length).toBe(1);
	});
});
