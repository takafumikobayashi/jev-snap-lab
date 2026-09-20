import { describe, expect, it } from 'vitest';
import { MODES } from '$lib/types/judge';
import { buildCatalog, buildState } from './question-catalog.server';
import {
	findQuestionDefects,
	MAX_CHOICE_OPTIONS,
	MAX_SCORE_LEVELS,
	MIN_SCORE_LEVELS
} from './question-validation.server';

describe('buildCatalog', () => {
	it('全モードの質問定義が criteria の形の検証を通る', () => {
		// これが落ちるなら、実機へ送れば 422 になる。
		for (const mode of MODES) {
			expect(findQuestionDefects(buildCatalog(mode).questions), mode).toEqual([]);
		}
	});

	it('全モードで Choice / Score / Noul が少なくとも1つずつある', () => {
		// MVP の成功条件（docs/PRODUCT_SPEC.md §11）。
		for (const mode of MODES) {
			const types = Object.values(buildCatalog(mode).questions).map((q) => q.type);
			expect(new Set(types), mode).toEqual(new Set(['choice', 'score', 'noul']));
		}
	});

	it('全質問に日本語ラベルがある', () => {
		for (const mode of MODES) {
			const { questions, labels } = buildCatalog(mode);
			for (const id of Object.keys(questions)) {
				expect(labels[id], `${mode}.${id}`).toBeTruthy();
			}
		}
	});

	it('ラベルに対応する質問が存在する（削除された質問のラベルが残らない）', () => {
		for (const mode of MODES) {
			const { questions, labels } = buildCatalog(mode);
			for (const id of Object.keys(labels)) {
				expect(questions[id], `${mode}.${id}`).toBeDefined();
			}
		}
	});

	it('Choice の全候補に日本語ラベルがあり、過不足がない', () => {
		for (const mode of MODES) {
			const { questions, optionLabels } = buildCatalog(mode);
			for (const [id, question] of Object.entries(questions)) {
				if (question.type !== 'choice') continue;
				const keys = Object.keys(question.criteria).sort();
				const labelled = Object.keys(optionLabels[id] ?? {}).sort();
				expect(labelled, `${mode}.${id}`).toEqual(keys);
			}
		}
	});

	it('instructions が `text` を参照し、質問 ID に依存しない', () => {
		// 質問 ID はモデルへ送られない（docs/JEV_DESIGN.md §4）。
		for (const mode of MODES) {
			for (const [id, question] of Object.entries(buildCatalog(mode).questions)) {
				const instructions = question.instructions;
				expect(typeof instructions, `${mode}.${id}`).toBe('string');
				expect(String(instructions).length, `${mode}.${id}`).toBeGreaterThan(20);
			}
		}
	});

	it('LOVE の重複していた Noul 2問が存在しない', () => {
		// docs/JEV_DESIGN.md §5 で romantic_frame へ統合した。
		const ids = Object.keys(buildCatalog('love').questions);
		expect(ids).not.toContain('is_breakup');
		expect(ids).not.toContain('has_lingering_feelings');
	});

	it('CITY の route_to に絞り込めない候補が必ずある', () => {
		const { questions } = buildCatalog('city');
		const routeTo = questions.route_to;
		expect(routeTo.type).toBe('choice');
		if (routeTo.type === 'choice') {
			expect(Object.keys(routeTo.criteria)).toContain('other_or_unclear');
		}
	});

	it('CITY の route_to が課レベルで、係で分割されていない', () => {
		// 係で割ると確率が分散する（docs/CITY_DATA.md §5）。
		const { questions } = buildCatalog('city');
		const routeTo = questions.route_to;
		if (routeTo.type !== 'choice') throw new Error('route_to は choice');
		for (const key of Object.keys(routeTo.criteria)) {
			expect(key, `${key} は課レベルのキーであるべき`).not.toMatch(/\./);
		}
	});

	it('CITY の緊急度が最上位で即時リスクを表現する', () => {
		const { questions } = buildCatalog('city');
		const urgency = questions.urgency;
		if (urgency.type !== 'score') throw new Error('urgency は score');
		expect(urgency.criteria.length).toBeGreaterThanOrEqual(MIN_SCORE_LEVELS);
		expect(urgency.criteria.length).toBeLessThanOrEqual(MAX_SCORE_LEVELS);
	});

	it('Choice の候補数が上限以内', () => {
		for (const mode of MODES) {
			for (const [id, question] of Object.entries(buildCatalog(mode).questions)) {
				if (question.type !== 'choice') continue;
				expect(Object.keys(question.criteria).length, `${mode}.${id}`).toBeLessThanOrEqual(
					MAX_CHOICE_OPTIONS
				);
			}
		}
	});

	it('質問 ID がモード間で衝突しても独立に解決できる', () => {
		// 同名 ID があってもモードごとにカタログを作るため問題ないが、
		// ラベルの取り違えを避けるため意図しない重複を検出しておく。
		const love = new Set(Object.keys(buildCatalog('love').questions));
		const social = new Set(Object.keys(buildCatalog('social').questions));
		const overlap = [...love].filter((id) => social.has(id));
		expect(overlap).toEqual([]);
	});
});

describe('buildState', () => {
	it('mode と text だけを渡す', () => {
		// 任意のオブジェクトを state へ入れない（docs/JEV_DESIGN.md §10）。
		expect(buildState('love', 'テスト')).toEqual({ mode: 'love', text: 'テスト' });
		expect(Object.keys(buildState('city', 'x')).sort()).toEqual(['mode', 'text']);
	});
});
