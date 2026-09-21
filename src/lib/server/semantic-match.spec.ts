import { describe, expect, it, vi } from 'vitest';
import {
	buildSemanticRequest,
	evaluateSemanticFit,
	MAX_CANDIDATES_PER_REQUEST,
	rankCandidates,
	readSemanticScores,
	type SemanticPolicy
} from './semantic-match.server';
import { JudgeError } from './errors.server';
import type { SemanticCandidate } from '$lib/types/semantic';

const policy: SemanticPolicy = {
	candidatesKey: 'candidates',
	instructions: ({ text, context }) =>
		`Is the request covered by \`${text}\`, handled by \`${context}\`?`,
	criteria: { true: 'covered', false: 'not covered' }
};

const candidate = (n: number, context: string | null = `課${n}`): SemanticCandidate => ({
	candidateId: `unit_${n}.u1.r${n}`,
	text: `事務${n}に関すること。`,
	context
});

const many = (n: number) => Array.from({ length: n }, (_, i) => candidate(i));

/** Noul の answer 形。実機は { type: 'noul', noul: 0.85 } を返す。 */
const answers = (values: number[]) =>
	Object.fromEntries(values.map((noul, i) => [`fit_${i}`, { type: 'noul', noul }]));

describe('buildSemanticRequest', () => {
	it('候補をオブジェクトとして state へ置く', () => {
		// 配列インデックス参照は候補20件超で確率が隣接へ滲む
		// （docs/IMPLEMENTATION_PLAN.md §8.1）。
		const built = buildSemanticRequest(many(3), policy, { text: '入力' });
		expect(built.state.candidates).toEqual({
			c0: { text: '事務0に関すること。', context: '課0' },
			c1: { text: '事務1に関すること。', context: '課1' },
			c2: { text: '事務2に関すること。', context: '課2' }
		});
		expect(built.state.text).toBe('入力');
	});

	it('instructions がキーのパスで候補を指す', () => {
		const built = buildSemanticRequest(many(2), policy, {});
		const first = built.questions.fit_0 as { instructions: string };
		expect(first.instructions).toContain('`candidates.c0.text`');
		expect(first.instructions).toContain('`candidates.c0.context`');
		// 配列インデックスの記法を出さない。
		expect(JSON.stringify(built.questions)).not.toContain('candidates[');
	});

	it('質問IDは連番で、候補IDを埋め込まない', () => {
		// 実データのIDは unit_0.u1.r0 のようにセグメント自体が
		// アンダースコアを含むため、文字列変換で往復できない。
		const built = buildSemanticRequest(many(2), policy, {});
		expect(Object.keys(built.questions)).toEqual(['fit_0', 'fit_1']);
		expect(built.index).toEqual(['unit_0.u1.r0', 'unit_1.u1.r1']);
		expect(JSON.stringify(built.questions)).not.toContain('unit_0.u1.r0');
	});

	it('context が無い候補は context を送らない', () => {
		const built = buildSemanticRequest([candidate(0, null)], policy, {});
		expect(built.state.candidates).toEqual({ c0: { text: '事務0に関すること。' } });
	});

	it('候補が空なら質問定義エラー', () => {
		expect(() => buildSemanticRequest([], policy, {})).toThrow(JudgeError);
	});

	it('上限を超える候補を1回のリクエストへ入れない', () => {
		expect(() => buildSemanticRequest(many(MAX_CANDIDATES_PER_REQUEST + 1), policy, {})).toThrow(
			/上限/
		);
	});

	it('上限ちょうどは通す', () => {
		expect(() => buildSemanticRequest(many(MAX_CANDIDATES_PER_REQUEST), policy, {})).not.toThrow();
	});
});

describe('readSemanticScores', () => {
	const index = ['a', 'b', 'c'];

	it('質問の連番を候補IDへ戻す', () => {
		const scores = readSemanticScores(answers([0.9, 0.2, 0.5]), index);
		expect([...scores]).toEqual([
			['a', 0.9],
			['b', 0.2],
			['c', 0.5]
		]);
	});

	it('answer が欠けていれば契約違反', () => {
		const partial = answers([0.9, 0.2, 0.5]);
		delete partial.fit_1;
		expect(() => readSemanticScores(partial, index)).toThrow(/fit_1 の answer が無い/);
	});

	it('送っていない質問が返れば契約違反', () => {
		const extra = { ...answers([0.9, 0.2, 0.5]), fit_9: { type: 'noul', noul: 0.1 } };
		expect(() => readSemanticScores(extra, index)).toThrow(/送っていない質問/);
	});

	it('確率が範囲外なら契約違反', () => {
		for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => readSemanticScores(answers([bad, 0.2, 0.5]), index)).toThrow(/0\.\.1/);
		}
	});

	it('確率が数値でなければ契約違反', () => {
		const wrong = { ...answers([0.9, 0.2, 0.5]), fit_0: { type: 'noul', noul: '0.9' } };
		expect(() => readSemanticScores(wrong, index)).toThrow(/0\.\.1/);
	});

	it('answers がオブジェクトでなければ契約違反', () => {
		for (const bad of [null, 'x', 42, []]) {
			expect(() => readSemanticScores(bad, index)).toThrow(/オブジェクトでない/);
		}
	});

	it('候補IDの重複を拒否する', () => {
		expect(() => readSemanticScores(answers([0.9, 0.2]), ['a', 'a'])).toThrow(/重複/);
	});

	it('0 と 1 は有効な確率として通す', () => {
		const scores = readSemanticScores(answers([0, 1, 0.5]), index);
		expect(scores.get('a')).toBe(0);
		expect(scores.get('b')).toBe(1);
	});
});

describe('evaluateSemanticFit', () => {
	it('上限以内なら上流を1回だけ呼ぶ', async () => {
		const send = vi.fn(async ({ questions }) =>
			answers(Object.keys(questions).map((_, i) => 0.5 + i / 100))
		);
		const scores = await evaluateSemanticFit(many(12), policy, { text: 'x' }, send);

		expect(send).toHaveBeenCalledTimes(1);
		expect(scores.size).toBe(12);
	});

	it('上限を超えたら分割し、呼び出し回数を隠す', async () => {
		// 呼び出し回数は engine の実装詳細。順位付け以降の層は知らない。
		const send = vi.fn(async ({ questions }) => answers(Object.keys(questions).map(() => 0.5)));
		const scores = await evaluateSemanticFit(many(41), policy, { text: 'x' }, send);

		expect(send).toHaveBeenCalledTimes(2);
		expect(scores.size).toBe(41);
		// 分割しても候補IDは重複せず、全件そろう。
		expect(scores.has('unit_40.u1.r40')).toBe(true);
	});

	it('分割した2回目が壊れていれば全体を失敗させる', async () => {
		// 部分的な結果を正しい判定として通さない。
		let call = 0;
		const send = vi.fn(async ({ questions }) => {
			call += 1;
			if (call === 1) return answers(Object.keys(questions).map(() => 0.5));
			return {};
		});
		await expect(evaluateSemanticFit(many(41), policy, { text: 'x' }, send)).rejects.toThrow(
			JudgeError
		);
	});

	it('baseState を毎回のリクエストへ含める', async () => {
		const send = vi.fn(async ({ questions }) => answers(Object.keys(questions).map(() => 0.5)));
		await evaluateSemanticFit(many(41), policy, { text: 'x', mode: 'city' }, send);
		for (const [request] of send.mock.calls) {
			expect(request.state.text).toBe('x');
			expect(request.state.mode).toBe('city');
		}
	});
});

describe('rankCandidates', () => {
	const order = ['a', 'b', 'c', 'd'];
	const scores = (entries: [string, number][]) => new Map(entries);

	it('確率の降順に並べ、順位を振る', () => {
		const result = rankCandidates(
			scores([
				['a', 0.4],
				['b', 0.9],
				['c', 0.6]
			]),
			order,
			{ topK: 3, minProbability: 0 }
		);
		expect(result.ranked).toEqual([
			{ candidateId: 'b', probability: 0.9, rank: 1 },
			{ candidateId: 'c', probability: 0.6, rank: 2 },
			{ candidateId: 'a', probability: 0.4, rank: 3 }
		]);
		expect(result.abstained).toBe(false);
	});

	it('同率は候補の並び順で決める（再現性）', () => {
		// 同じ入力・同じデータで順序が変わると、比較実験の結果が読めない。
		const result = rankCandidates(
			scores([
				['c', 0.8],
				['a', 0.8],
				['b', 0.8]
			]),
			order,
			{ topK: 3, minProbability: 0 }
		);
		expect(result.ranked.map((r) => r.candidateId)).toEqual(['a', 'b', 'c']);
	});

	it('topK で打ち切る', () => {
		const result = rankCandidates(
			scores([
				['a', 0.9],
				['b', 0.8],
				['c', 0.7]
			]),
			order,
			{ topK: 2, minProbability: 0 }
		);
		expect(result.ranked).toHaveLength(2);
	});

	it('閾値未満を落とす', () => {
		const result = rankCandidates(
			scores([
				['a', 0.9],
				['b', 0.3]
			]),
			order,
			{ topK: 3, minProbability: 0.5 }
		);
		expect(result.ranked.map((r) => r.candidateId)).toEqual(['a']);
	});

	it('全部が閾値未満なら abstain する', () => {
		// 無理に最上位を出して、関係の薄い候補を回答のように見せない。
		const result = rankCandidates(
			scores([
				['a', 0.07],
				['b', 0.03]
			]),
			order,
			{ topK: 3, minProbability: 0.5 }
		);
		expect(result.ranked).toEqual([]);
		expect(result.abstained).toBe(true);
	});

	it('閾値ちょうどは残す', () => {
		const result = rankCandidates(scores([['a', 0.5]]), order, {
			topK: 3,
			minProbability: 0.5
		});
		expect(result.ranked).toHaveLength(1);
	});
});
