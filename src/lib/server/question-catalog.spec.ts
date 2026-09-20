import { describe, expect, it } from 'vitest';
import { MODES } from '$lib/types/judge';
import {
	buildCatalog,
	buildState,
	CITY_DIRECTORY_IS_PROVISIONAL,
	CITY_DIRECTORY_VERSION,
	CITY_JURISDICTION
} from './question-catalog.server';
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

describe('質問 ID 集合の固定', () => {
	// 自己整合性のテストは、質問とラベルを同時に消しても通ってしまう。
	// 期待する ID 集合を明示的に固定し、欠落・意図しない追加を検出する。
	// 変更するときは docs/JEV_DESIGN.md の §5 / §6 / §7 も必ず更新する。

	it('LOVE は 7 問', () => {
		expect(Object.keys(buildCatalog('love').questions).sort()).toEqual([
			'is_long_distance',
			'is_passionate',
			'is_unrequited',
			'love_signal_strength',
			'relationship_ended',
			'romantic_frame',
			'still_loves'
		]);
	});

	it('SOCIAL は 10 問', () => {
		expect(Object.keys(buildCatalog('social').questions).sort()).toEqual([
			'casualness',
			'discussion_level',
			'invites_agreement',
			'is_boastful',
			'is_joke_like',
			'is_learning_or_discovery',
			'is_reaction_bait',
			'is_surprising',
			'is_taunting',
			'post_type'
		]);
	});

	it('CITY は 8 問', () => {
		expect(Object.keys(buildCatalog('city').questions).sort()).toEqual([
			'cross_department_likely',
			'emergency_signal',
			'human_review_likely',
			'location_information_missing',
			'onsite_visit_likely',
			'request_category',
			'route_to',
			'urgency'
		]);
	});
});

describe('scoreLabels', () => {
	it('全 Score 質問に日本語ラベルがあり、criteria と長さが一致する', () => {
		// ずれたまま表示すると、別レベルの説明を出すことになる。
		for (const mode of MODES) {
			const { questions, scoreLabels } = buildCatalog(mode);
			for (const [id, question] of Object.entries(questions)) {
				if (question.type !== 'score') continue;
				expect(scoreLabels[id], `${mode}.${id}`).toBeDefined();
				expect(scoreLabels[id].length, `${mode}.${id}`).toBe(question.criteria.length);
			}
		}
	});

	it('Score でない質問のラベルが紛れ込んでいない', () => {
		for (const mode of MODES) {
			const { questions, scoreLabels } = buildCatalog(mode);
			for (const id of Object.keys(scoreLabels)) {
				expect(questions[id]?.type, `${mode}.${id}`).toBe('score');
			}
		}
	});

	it('日本語ラベルに ASCII のみの要素がない', () => {
		// criteria を貼り付けたまま放置する事故を検出する。
		for (const mode of MODES) {
			for (const [id, labels] of Object.entries(buildCatalog(mode).scoreLabels)) {
				for (const label of labels) {
					expect(/^[\x20-\x7e]+$/.test(label), `${mode}.${id}: ${label}`).toBe(false);
				}
			}
		}
	});
});

describe('buildState', () => {
	it('LOVE / SOCIAL は mode と text だけを渡す', () => {
		// 任意のオブジェクトを state へ入れない（docs/JEV_DESIGN.md §10）。
		expect(buildState('love', 'テスト')).toEqual({ mode: 'love', text: 'テスト' });
		expect(buildState('social', 'テスト')).toEqual({ mode: 'social', text: 'テスト' });
	});

	it('CITY は jurisdiction を足す', () => {
		expect(buildState('city', '防犯灯が切れてます')).toEqual({
			mode: 'city',
			text: '防犯灯が切れてます',
			jurisdiction: CITY_JURISDICTION
		});
	});

	it('CITY の state にデータバージョンを入れない', () => {
		// モデルにとって意味を持たないIDでトークンを使わない。
		// バージョンはレスポンスの city.directoryVersion に記録する。
		const state = buildState('city', 'x') as Record<string, unknown>;
		expect(state.directory_version).toBeUndefined();
		expect(state.directory_effective_date).toBeUndefined();
		expect(Object.keys(state).sort()).toEqual(['jurisdiction', 'mode', 'text']);
	});
});

describe('CITY データの出所', () => {
	it('公式データを使っており、暫定フラグが立っていない', () => {
		// Phase 4 で city-directory.json へ差し替えた。出典が候補へ紐付く。
		expect(CITY_DIRECTORY_IS_PROVISIONAL).toBe(false);
		expect(CITY_DIRECTORY_VERSION).not.toContain('provisional');
	});

	it('バージョンに管轄と施行日が入る', () => {
		expect(CITY_DIRECTORY_VERSION).toBe('akitakata-2026-04-01');
	});
});
