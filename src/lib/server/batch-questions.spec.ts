import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateDataset } from './batch-dataset.server';
import {
	AXES_BY_THEME,
	CASES_KEY,
	buildBatchRequest,
	privacyVerdict,
	questionIdOf,
	readBatchAnswers,
	type BatchAnswer
} from './batch-questions.server';
import { JudgeError } from './errors.server';
import type { BatchDataset } from '$lib/types/batch';

const load = (theme: 'privacy' | 'deadline' | 'dx'): BatchDataset =>
	validateDataset(JSON.parse(readFileSync(`data/batch/${theme}.json`, 'utf8')) as unknown);

const privacy = load('privacy');
const deadline = load('deadline');
const dx = load('dx');

/** 契約どおりの answers。テストごとにここから1点だけ壊す。 */
function goodAnswers(request: ReturnType<typeof buildBatchRequest>): Record<string, BatchAnswer> {
	return Object.fromEntries(
		[...request.index.keys()].map((id) => [
			id,
			id.endsWith('__class')
				? { type: 'choice', choice: 'soon' }
				: id.endsWith('__first_move')
					? { type: 'choice', choice: 'bpr' }
					: { type: 'noul', noul: 0.3 }
		])
	);
}

describe('buildBatchRequest', () => {
	it('事例をオブジェクトのキーで置く', () => {
		// 配列インデックス参照は候補が20件を超えると確率が隣へ滲む。
		const request = buildBatchRequest(privacy, privacy.cases.slice(0, 3));
		const bag = request.state[CASES_KEY] as Record<string, { text: string }>;
		expect(Object.keys(bag)).toEqual(['privacy_001', 'privacy_002', 'privacy_003']);
		expect(bag.privacy_001.text).toBe(privacy.cases[0].text);
	});

	it('質問IDを事例IDへ戻せる', () => {
		const request = buildBatchRequest(dx, dx.cases.slice(0, 2));
		expect(request.index.get(questionIdOf('dx_001', 'first_move'))).toBe('dx_001');
		expect(request.questionCount).toBe(2);
		expect(request.caseCount).toBe(2);
	});

	it('参照パスが state のキーと一致する', () => {
		// instructions のパスと state の置き場所がずれると、Jev は参照できない。
		const request = buildBatchRequest(privacy, privacy.cases.slice(0, 1));
		const question = JSON.stringify(request.questions[questionIdOf('privacy_001', 'identifies')]);
		expect(question).toContain(`${CASES_KEY}.privacy_001.text`);
	});

	it('基準日を持つテーマだけ state へ入れる', () => {
		expect(buildBatchRequest(deadline, deadline.cases.slice(0, 1)).state.referenceDate).toBe(
			'2026-09-21'
		);
		// 判定に寄与しない値を state へ入れない。
		expect(buildBatchRequest(privacy, privacy.cases.slice(0, 1)).state).not.toHaveProperty(
			'referenceDate'
		);
	});

	it('事例が空なら組み立てない', () => {
		expect(() => buildBatchRequest(privacy, [])).toThrow(JudgeError);
	});

	it('1件あたりの質問数はテーマで決まる', () => {
		expect(AXES_BY_THEME.privacy).toHaveLength(3);
		expect(AXES_BY_THEME.deadline).toHaveLength(1);
		expect(AXES_BY_THEME.dx).toHaveLength(1);
	});
});

describe('Jevへ送るもの', () => {
	// dataset を丸ごと state へ渡す書き方に変えると、gold とヒントが静かに
	// 漏れる。**送信するオブジェクトそのものを見る。** 型だけでは守れない。
	const themes = [privacy, deadline, dx];

	it('state の事例が id と text だけでできている', () => {
		// 部分一致では検査にならない。note の文言が別の事例の本文に含まれる
		// ことが実際にあった（privacy_023 の note が privacy_043 の本文の一部）。
		// **期待する形を組み立てて完全一致で比べる。** 余分なものが1つでも
		// 入れば落ちる。
		for (const dataset of themes) {
			const request = buildBatchRequest(dataset);
			expect(request.state[CASES_KEY], dataset.theme).toEqual(
				Object.fromEntries(dataset.cases.map((item) => [item.id, { text: item.text }]))
			);
		}
	});

	it('リクエスト全体に gold / note / difficulty のキーが無い', () => {
		// state の外（questions や将来足す項目）へ漏れる経路も塞ぐ。
		for (const dataset of themes) {
			const sent = JSON.stringify(buildBatchRequest(dataset));
			for (const key of ['gold', 'note', 'difficulty']) {
				expect(sent, `${dataset.theme} に ${key} がある`).not.toContain(`"${key}"`);
			}
		}
	});

	it('fixture に note と difficulty が実在する', () => {
		// 元データに無ければ、漏れないことを確かめたことにならない。
		for (const dataset of themes) {
			expect(
				dataset.cases.some((item) => item.note !== undefined),
				dataset.theme
			).toBe(true);
			expect(
				dataset.cases.every((item) => item.difficulty !== undefined),
				dataset.theme
			).toBe(true);
		}
	});

	it('事例を展開してコピーすると落ちる', () => {
		// `{ ...item }` へ書き換えたときにこの検査が効くことを示す。検査自体が
		// 空振りしていないことの確認である。
		const leaked = Object.fromEntries(privacy.cases.map((item) => [item.id, { ...item }]));
		expect(JSON.stringify({ cases: leaked })).toContain('"gold"');
		expect(leaked).not.toEqual(
			Object.fromEntries(privacy.cases.map((item) => [item.id, { text: item.text }]))
		);
	});
});

describe('並び順', () => {
	it('入力順を変えても state が同じになる', () => {
		// 実測で、並び順を変えると同じ事例の確率が動いた（逆順で最大0.400）。
		// 利用者が貼った順で送ると、同じ50件でも並べ替えただけで結果が変わる。
		const forward = buildBatchRequest(privacy);
		const reversed = buildBatchRequest(privacy, [...privacy.cases].reverse());
		const shuffled = buildBatchRequest(
			privacy,
			[...privacy.cases].sort((a, b) => (a.id < b.id ? 1 : -1))
		);

		// キーの並びまで含めて同じであること。JSON文字列で比べる。
		expect(JSON.stringify(reversed.state)).toBe(JSON.stringify(forward.state));
		expect(JSON.stringify(shuffled.state)).toBe(JSON.stringify(forward.state));
	});

	it('並びは入力順でもID順でもない', () => {
		// 入力順に依らないことを示すには、入力順と違う並びになっている必要が
		// ある。同じならこの検査は空振りしている。
		const bag = buildBatchRequest(privacy).state[CASES_KEY] as Record<string, unknown>;
		const order = Object.keys(bag);
		expect(order).not.toEqual(privacy.cases.map((item) => item.id));
		expect(order).not.toEqual([...order].sort());
		expect([...order].sort()).toEqual([...privacy.cases.map((item) => item.id)].sort());
	});

	it('並べ替えても質問と事例の対応が崩れない', () => {
		const request = buildBatchRequest(privacy);
		for (const item of privacy.cases) {
			expect(request.index.get(questionIdOf(item.id, 'identifies'))).toBe(item.id);
		}
		expect(request.index.size).toBe(privacy.cases.length * 3);
	});

	it('混線を測るときは入力順のまま送れる', () => {
		// canonicalOrder を外せない作りにすると、素の並び順依存を測れなくなる。
		const raw = buildBatchRequest(privacy, privacy.cases, undefined, undefined, {
			canonicalOrder: false
		});
		expect(Object.keys(raw.state[CASES_KEY] as Record<string, unknown>)).toEqual(
			privacy.cases.map((item) => item.id)
		);
	});
});

describe('readBatchAnswers', () => {
	const request = buildBatchRequest(privacy, privacy.cases.slice(0, 2));

	it('契約どおりなら通る', () => {
		expect(readBatchAnswers(goodAnswers(request), request).size).toBe(request.questionCount);
	});

	it('欠落したらリクエスト全体を失敗させる', () => {
		// 一部だけ返すと、PRIVACY では見ていない事例が「要確認シグナルなし」と
		// 並んで表示される。**見ていないものを安全に見せない。**
		const answers = goodAnswers(request);
		delete answers[questionIdOf('privacy_001', 'sensitive')];
		expect(() => readBatchAnswers(answers, request)).toThrow(/answer が 1\/6 件欠けている/);
	});

	it('欠落の件数だけを出し、入力本文を出さない', () => {
		const answers = goodAnswers(request);
		delete answers[questionIdOf('privacy_001', 'identifies')];
		try {
			readBatchAnswers(answers, request);
			expect.unreachable();
		} catch (error) {
			expect(String((error as JudgeError).message)).not.toContain(privacy.cases[0].text);
		}
	});

	it('送っていない質問の answer を拒む', () => {
		const answers = { ...goodAnswers(request), privacy_999__identifies: { type: 'noul', noul: 1 } };
		expect(() => readBatchAnswers(answers, request)).toThrow(/送っていない質問/);
	});

	it('範囲外の noul を拒む', () => {
		const answers = goodAnswers(request);
		answers[questionIdOf('privacy_001', 'identifies')] = { type: 'noul', noul: 1.4 };
		expect(() => readBatchAnswers(answers, request)).toThrow(/0〜1 の数値でない/);
	});

	it('想定しない type を拒む', () => {
		const answers = goodAnswers(request);
		answers[questionIdOf('privacy_001', 'identifies')] = { type: 'score' };
		expect(() => readBatchAnswers(answers, request)).toThrow(/noul でも choice でもない/);
	});

	it('空の choice を拒む', () => {
		const dxRequest = buildBatchRequest(dx, dx.cases.slice(0, 1));
		const answers = goodAnswers(dxRequest);
		answers[questionIdOf('dx_001', 'first_move')] = { type: 'choice', choice: '' };
		expect(() => readBatchAnswers(answers, dxRequest)).toThrow(/空でない文字列でない/);
	});

	it('オブジェクトでない answers を拒む', () => {
		expect(() => readBatchAnswers([], request)).toThrow(/オブジェクトでない/);
		expect(() => readBatchAnswers(null, request)).toThrow(/オブジェクトでない/);
	});
});

describe('privacyVerdict', () => {
	const at = (identifies: number, personal: number, sensitive: number) =>
		new Map<string, BatchAnswer>([
			[questionIdOf('x', 'identifies'), { type: 'noul', noul: identifies }],
			[questionIdOf('x', 'personal'), { type: 'noul', noul: personal }],
			[questionIdOf('x', 'sensitive'), { type: 'noul', noul: sensitive }]
		]);

	it('identifies か personal が閾値以上なら要確認', () => {
		expect(privacyVerdict(at(0.9, 0.1, 0.1), 'x')).toBe('review');
		expect(privacyVerdict(at(0.1, 0.9, 0.1), 'x')).toBe('review');
	});

	it('sensitive だけが高くても要確認にしない', () => {
		// 「生活保護受給世帯の一覧をExcelから抽出しました」は誰も特定できない
		// のに sensitive=0.96 になる。話題の語に反応している。
		expect(privacyVerdict(at(0.06, 0.08, 0.96), 'x')).toBe('no_signal');
	});

	it('答えが無い軸を0として扱う', () => {
		// 欠落は readBatchAnswers が弾く。ここへ来る時点で揃っている前提だが、
		// 既定値が1側へ倒れると「全部要確認」になって役に立たなくなる。
		expect(privacyVerdict(new Map(), 'x')).toBe('no_signal');
	});
});
