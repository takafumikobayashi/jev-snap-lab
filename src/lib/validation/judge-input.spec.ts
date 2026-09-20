import { describe, expect, it } from 'vitest';
import { MAX_INPUT_CODE_POINTS } from '$lib/types/judge';
import { validateJudgeInput } from './judge-input';

const ok = (body: unknown) => validateJudgeInput(body);
const failureOf = (body: unknown) => {
	const result = validateJudgeInput(body);
	return result.ok ? null : result.failure;
};

describe('validateJudgeInput', () => {
	it('正しいボディを通す', () => {
		const result = ok({ mode: 'love', text: 'もう君のことは忘れたはずなのに' });
		expect(result).toEqual({
			ok: true,
			value: { mode: 'love', text: 'もう君のことは忘れたはずなのに' }
		});
	});

	it('3モードすべてを受け付ける', () => {
		for (const mode of ['love', 'social', 'city']) {
			expect(ok({ mode, text: 'テスト' }).ok).toBe(true);
		}
	});

	describe('ボディの形', () => {
		it('オブジェクト以外を拒否する', () => {
			for (const body of [null, undefined, 'text', 42, true]) {
				expect(failureOf(body)).toBe('NOT_OBJECT');
			}
		});

		it('配列を拒否する', () => {
			expect(failureOf([{ mode: 'love', text: 'a' }])).toBe('NOT_OBJECT');
		});

		it('余分なフィールドを拒否する', () => {
			// state を直接注入させない（docs/JEV_DESIGN.md §10）。
			expect(failureOf({ mode: 'love', text: 'a', state: { evil: true } })).toBe('UNKNOWN_FIELD');
			expect(failureOf({ mode: 'love', text: 'a', model: 'other' })).toBe('UNKNOWN_FIELD');
		});
	});

	describe('mode', () => {
		it('未知のモードを拒否する', () => {
			for (const mode of ['LOVE', 'other', '', null, undefined, 1]) {
				expect(failureOf({ mode, text: 'a' })).toBe('INVALID_MODE');
			}
		});

		it('mode 欠落を拒否する', () => {
			expect(failureOf({ text: 'a' })).toBe('INVALID_MODE');
		});
	});

	describe('text', () => {
		it('文字列以外を拒否する', () => {
			for (const text of [null, undefined, 42, {}, []]) {
				expect(failureOf({ mode: 'love', text })).toBe('TEXT_NOT_STRING');
			}
		});

		it('空文字と空白のみを拒否する', () => {
			for (const text of ['', ' ', '　', '\n', '\t', ' \n\t 　']) {
				expect(failureOf({ mode: 'love', text })).toBe('TEXT_BLANK');
			}
		});

		it('ちょうど 280 code points を通す', () => {
			expect(ok({ mode: 'love', text: 'あ'.repeat(MAX_INPUT_CODE_POINTS) }).ok).toBe(true);
		});

		it('281 code points を拒否する', () => {
			expect(failureOf({ mode: 'love', text: 'あ'.repeat(MAX_INPUT_CODE_POINTS + 1) })).toBe(
				'TEXT_TOO_LONG'
			);
		});

		it('絵文字 280 個を length 基準で誤って拒否しない', () => {
			// length では 560 になる。code point で数えているので通るべき。
			expect(ok({ mode: 'love', text: '👍'.repeat(MAX_INPUT_CODE_POINTS) }).ok).toBe(true);
		});

		it('改行・タブ・復帰は入力として許可する', () => {
			expect(ok({ mode: 'social', text: '1行目\n2行目\tタブ\r復帰' }).ok).toBe(true);
		});

		it('その他の制御文字を拒否する', () => {
			for (const ch of ['\u0000', '\u0007', '\u001b', '\u007f', '\u0085']) {
				expect(failureOf({ mode: 'love', text: `前${ch}後` })).toBe('TEXT_CONTROL_CHARACTER');
			}
		});

		it('長さ超過を制御文字より先に判定する', () => {
			// 巨大な入力へ正規表現を走らせないため、順序を固定しておく。
			const text = 'あ'.repeat(MAX_INPUT_CODE_POINTS + 1) + '\u0000';
			expect(failureOf({ mode: 'love', text })).toBe('TEXT_TOO_LONG');
		});

		it('XSS 文字列は検証を通す（エスケープは表示側の責務）', () => {
			const result = ok({ mode: 'social', text: '<script>alert(1)</script>' });
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.text).toBe('<script>alert(1)</script>');
		});
	});
});
