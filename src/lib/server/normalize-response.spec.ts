import { describe, expect, it } from 'vitest';
import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { choice, noul, score } from '@typesafe-ai/sdk';
import { JudgeError } from './errors.server';
import { dominantLevel, normalizeAnswers, scoreDisplayLabel } from './normalize-response.server';
import type { QuestionCatalog } from './question-catalog.server';

/** 3 種類をすべて含む最小のカタログ。 */
function catalog(): QuestionCatalog {
	return {
		questions: {
			frame: choice('Which frame?', { a: 'A です', b: 'B です', c: 'C です' }),
			level: score('How strong?', ['Low.', 'Middle.', 'High.']),
			flag: noul('Is it so?')
		},
		labels: { frame: 'フレーム', level: '強さ', flag: 'そう読める？' },
		optionLabels: { frame: { a: 'あ', b: 'い', c: 'う' } },
		scoreLabels: { level: ['低い', '中くらい', '高い'] }
	};
}

function result(answers: Record<string, unknown>): SystemOneResult<Questions> {
	return {
		model: 'jev-1.13.0',
		answers,
		usage: { input_tokens: 392, output_tokens: 65 }
	} as unknown as SystemOneResult<Questions>;
}

/**
 * 正常なレスポンス。
 *
 * 戻り値を緩い型にしてあるのは、上流が契約に反した形を返す状況を
 * テストで再現するため。実際の SDK の型は厳密である。
 */
const goodAnswers = (): Record<string, Record<string, unknown>> => ({
	frame: {
		type: 'choice',
		choice: 'b',
		probabilities: { a: 0.1, b: 0.7, c: 0.2 },
		confidence: 0.81
	},
	level: {
		type: 'score',
		score: 1.05,
		legend: { 0: 'Low.', 1: 'Middle.', 2: 'High.' },
		probabilities: { 0: 0.0, 1: 0.95, 2: 0.05 },
		confidence: 0.92
	},
	flag: { type: 'noul', noul: 0.88 }
});

const expectFailure = (answers: Record<string, unknown>, fragment: string) => {
	try {
		normalizeAnswers(catalog(), result(answers));
	} catch (error) {
		expect(error).toBeInstanceOf(JudgeError);
		expect((error as JudgeError).message).toContain(fragment);
		return error as JudgeError;
	}
	throw new Error('エラーが投げられなかった');
};

describe('normalizeAnswers', () => {
	it('3 種類の答えを正規化する', () => {
		const cards = normalizeAnswers(catalog(), result(goodAnswers()));
		expect(cards.map((card) => card.kind)).toEqual(['choice', 'score', 'noul']);
	});

	it('カードの順序は質問定義の順序に従う', () => {
		const cards = normalizeAnswers(catalog(), result(goodAnswers()));
		expect(cards.map((card) => card.id)).toEqual(['frame', 'level', 'flag']);
	});

	describe('Choice', () => {
		it('選択候補と日本語ラベルを載せ、確率の降順に並べる', () => {
			const [card] = normalizeAnswers(catalog(), result(goodAnswers()));
			if (card.kind !== 'choice') throw new Error('choice');
			expect(card.selected).toBe('b');
			expect(card.label).toBe('フレーム');
			expect(card.options.map((option) => option.key)).toEqual(['b', 'c', 'a']);
			expect(card.options[0].label).toBe('い');
			expect(card.confidence).toBe(0.81);
		});

		it('送っていない候補が choice に返ったら拒否する', () => {
			const answers = goodAnswers();
			answers.frame.choice = 'z';
			expectFailure(answers, 'criteria に存在しない');
		});

		it('候補が欠けていたら拒否する', () => {
			const answers = goodAnswers();
			answers.frame.probabilities = { a: 0.3, b: 0.7 };
			expectFailure(answers, 'キーが一致しない');
		});

		it('余分な候補が返ったら拒否する', () => {
			const answers = goodAnswers();
			answers.frame.probabilities = { a: 0.1, b: 0.6, c: 0.2, d: 0.1 };
			expectFailure(answers, 'キーが一致しない');
		});

		it('確率の合計が 1 から離れていたら拒否する', () => {
			const answers = goodAnswers();
			answers.frame.probabilities = { a: 0.1, b: 0.2, c: 0.2 };
			expectFailure(answers, '合計');
		});

		it('丸め誤差の範囲は許容する', () => {
			const answers = goodAnswers();
			answers.frame.probabilities = { a: 0.1, b: 0.7, c: 0.2000004 };
			expect(() => normalizeAnswers(catalog(), result(answers))).not.toThrow();
		});

		it('範囲外の確率を拒否する', () => {
			const answers = goodAnswers();
			answers.frame.probabilities = { a: -0.1, b: 0.9, c: 0.2 };
			expectFailure(answers, '0..1');
		});
	});

	describe('レスポンスの骨格', () => {
		const expectShapeFailure = (mutate: (r: Record<string, unknown>) => void, fragment: string) => {
			const raw = result(goodAnswers()) as unknown as Record<string, unknown>;
			mutate(raw);
			expect(() => normalizeAnswers(catalog(), raw as never)).toThrow(fragment);
		};

		it('answers が配列なら拒否する', () => {
			// 無条件に Record として扱うと内部例外へ流れてしまう。
			expectShapeFailure((r) => (r.answers = []), 'answers');
		});

		it('answers が null なら拒否する', () => {
			expectShapeFailure((r) => (r.answers = null), 'answers');
		});

		it('model が空文字なら拒否する', () => {
			expectShapeFailure((r) => (r.model = ''), 'model');
		});

		it('model が文字列でなければ拒否する', () => {
			expectShapeFailure((r) => (r.model = 42), 'model');
		});

		it('usage が欠けていたら拒否する', () => {
			expectShapeFailure((r) => delete r.usage, 'usage');
		});

		it('input_tokens が数値でなければ拒否する', () => {
			expectShapeFailure(
				(r) => (r.usage = { input_tokens: 'x', output_tokens: 1 }),
				'input_tokens'
			);
		});

		it('output_tokens が負なら拒否する', () => {
			expectShapeFailure(
				(r) => (r.usage = { input_tokens: 1, output_tokens: -1 }),
				'output_tokens'
			);
		});
	});

	describe('Score', () => {
		it('小数の score をそのまま保持する', () => {
			const [, card] = normalizeAnswers(catalog(), result(goodAnswers()));
			if (card.kind !== 'score') throw new Error('score');
			expect(card.score).toBe(1.05);
		});

		it('legend を日本語へ差し替える', () => {
			// 英語の criteria がそのまま画面へ出ないこと。
			const [, card] = normalizeAnswers(catalog(), result(goodAnswers()));
			if (card.kind !== 'score') throw new Error('score');
			expect(card.legend).toEqual({ 0: '低い', 1: '中くらい', 2: '高い' });
			expect(JSON.stringify(card.legend)).not.toContain('Middle');
		});

		it('legend のキーが欠けていたら拒否する', () => {
			const answers = goodAnswers();
			answers.level.legend = { 0: 'Low.', 1: 'High.' };
			expectFailure(answers, 'legend');
		});

		it('legend に余分なキーがあったら拒否する', () => {
			// 段数が合っていても、別の尺度で答えている可能性がある。
			const answers = goodAnswers();
			answers.level.legend = { 0: 'Low.', 1: 'Middle.', 3: 'Other.' };
			expectFailure(answers, '余分');
		});

		it('probabilities に余分なレベルがあったら拒否する', () => {
			const answers = goodAnswers();
			answers.level.probabilities = { 0: 0.0, 1: 0.95, 2: 0.05, 3: 0 };
			expectFailure(answers, '余分');
		});

		it('probabilities のレベルが飛んでいたら拒否する', () => {
			const answers = goodAnswers();
			answers.level.probabilities = { 0: 0.0, 1: 0.95, 5: 0.05 };
			expectFailure(answers, 'キーが一致しない');
		});

		it('score がレベル範囲外なら拒否する', () => {
			const answers = goodAnswers();
			answers.level.score = 2.4;
			expectFailure(answers, '範囲外');
		});

		it('scoreLabels が criteria と一致しないのはアプリ側のバグとして扱う', () => {
			const broken = catalog();
			broken.scoreLabels.level = ['低い', '高い'];
			try {
				normalizeAnswers(broken, result(goodAnswers()));
			} catch (error) {
				// 上流ではなくこちらの不整合なので QUESTION_DEFINITION_ERROR。
				expect((error as JudgeError).code).toBe('QUESTION_DEFINITION_ERROR');
				return;
			}
			throw new Error('エラーが投げられなかった');
		});
	});

	describe('Noul', () => {
		it('yes 確率だけを持ち confidence を持たない', () => {
			const [, , card] = normalizeAnswers(catalog(), result(goodAnswers()));
			if (card.kind !== 'noul') throw new Error('noul');
			expect(card.yesProbability).toBe(0.88);
			expect(card).not.toHaveProperty('confidence');
		});

		it('範囲外の値を拒否する', () => {
			const answers = goodAnswers();
			answers.flag.noul = 1.5;
			expectFailure(answers, '0..1');
		});
	});

	describe('答えの欠落と型不一致', () => {
		it('答えが無ければ拒否する', () => {
			const answers = goodAnswers();
			delete (answers as Record<string, unknown>).flag;
			expectFailure(answers, '答えが無い');
		});

		it('type が質問と違えば拒否する', () => {
			const answers = goodAnswers();
			answers.flag.type = 'score';
			expectFailure(answers, 'type');
		});
	});

	it('契約違反は再試行可能な上流障害として扱う', () => {
		const answers = goodAnswers();
		answers.frame.choice = 'z';
		const error = expectFailure(answers, '契約違反');
		expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
	});
});

describe('dominantLevel / scoreDisplayLabel', () => {
	it('最大確率のレベルを選ぶ', () => {
		expect(dominantLevel({ 0: 0.0, 1: 0.95, 2: 0.05 })).toBe('1');
	});

	it('score の丸めと最大確率がずれる二峰分布で、最大確率を優先する', () => {
		// score = 0*0.45 + 1*0.1 + 2*0.45 = 1.0 なので round(score) は 1。
		// しかし最も確からしいレベルは 0（同率なら小さい方）。
		const probabilities = { 0: 0.45, 1: 0.1, 2: 0.45 };
		expect(Math.round(1.0)).toBe(1);
		expect(dominantLevel(probabilities)).toBe('0');
	});

	it('同率なら小さいレベルを採る', () => {
		expect(dominantLevel({ 0: 0.5, 1: 0.5 })).toBe('0');
	});

	it('表示ラベルは日本語の legend から引く', () => {
		const [, card] = normalizeAnswers(catalog(), result(goodAnswers()));
		if (card.kind !== 'score') throw new Error('score');
		expect(scoreDisplayLabel(card)).toBe('中くらい');
	});
});
