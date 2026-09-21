import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BATCH_THEMES, DX_CLASSES } from '$lib/types/batch';
import {
	MAX_CASES,
	MAX_CASE_CHARS,
	MAX_STATE_CHARS_CEILING,
	summarizeDataset,
	validateDataset
} from './batch-dataset.server';

function valid(): Record<string, unknown> {
	return {
		schemaVersion: '1',
		theme: 'privacy',
		label: 'AIにそのまま入れてよい？',
		cases: [
			{ id: 'privacy_001', text: '来月の会議の日程を決めたい', difficulty: 'easy', gold: 'safe' },
			{
				id: 'privacy_002',
				text: '住民Aさんの病歴をまとめたい',
				difficulty: 'easy',
				gold: 'review',
				note: '要配慮情報'
			}
		]
	};
}

/** 壊し方を1箇所だけ変えて、その1箇所で落ちることを見る。 */
function broken(mutate: (dataset: Record<string, unknown>) => void): () => void {
	const dataset = valid();
	mutate(dataset);
	return () => validateDataset(dataset);
}

describe('validateDataset', () => {
	it('正しいデータセットは通る', () => {
		expect(() => validateDataset(valid())).not.toThrow();
	});

	describe('gold', () => {
		it('privacy の未知のラベルを拒む', () => {
			// 綴り違いを通すと「不一致」として集計され、benchmark が壊れ方を測る。
			expect(
				broken((d) => {
					(d.cases as Record<string, unknown>[])[0].gold = 'SAFE';
				})
			).toThrow(/privacy のラベルでない/);
		});

		it('deadline の未知のラベルを拒む', () => {
			expect(
				broken((d) => {
					d.theme = 'deadline';
					for (const [index, item] of (d.cases as Record<string, unknown>[]).entries()) {
						item.id = `deadline_${index + 1}`;
						item.gold = 'now';
					}
					(d.cases as Record<string, unknown>[])[1].gold = 'urgent';
				})
			).toThrow(/deadline のラベルでない/);
		});

		it('dx の未知のラベルを拒む', () => {
			expect(
				broken((d) => {
					d.theme = 'dx';
					for (const [index, item] of (d.cases as Record<string, unknown>[]).entries()) {
						item.id = `dx_${index + 1}`;
						item.gold = 'bpr';
					}
					(d.cases as Record<string, unknown>[])[1].gold = 'automation';
				})
			).toThrow(/dx のラベルでない/);
		});
	});

	describe('ID', () => {
		it('重複を拒む', () => {
			expect(
				broken((d) => {
					(d.cases as Record<string, unknown>[])[1].id = 'privacy_001';
				})
			).toThrow(/id が重複している/);
		});

		it('theme と接頭辞が合わないIDを拒む', () => {
			// 質問IDの対応表がずれると、別の事例の答えを読む。
			expect(
				broken((d) => {
					(d.cases as Record<string, unknown>[])[1].id = 'dx_002';
				})
			).toThrow(/接頭辞で始まっていない/);
		});
	});

	describe('本文', () => {
		it('同一の本文を拒む', () => {
			expect(
				broken((d) => {
					(d.cases as Record<string, unknown>[])[1].text = (
						d.cases as Record<string, unknown>[]
					)[0].text;
				})
			).toThrow(/他の事例と同一である/);
		});

		it('1件あたりの上限を超える本文を拒む', () => {
			expect(
				broken((d) => {
					(d.cases as Record<string, unknown>[])[1].text = 'あ'.repeat(MAX_CASE_CHARS + 1);
				})
			).toThrow(/上限 280 を超える/);
		});

		it('本文の合計が state の予算に収まる形でしか作れない', () => {
			// 件数と1件あたりの上限で天井が決まるため、総量の検査は置いていない。
			// 天井が動いたらここで気づく（docs/BATCH_JUDGE_DESIGN.md §4.1）。
			expect(MAX_STATE_CHARS_CEILING).toBe(14_000);
			// SPEC FIND 実測の 1.087 state token/字。32k の半分以下に収まる。
			expect(MAX_STATE_CHARS_CEILING * 1.087).toBeLessThan(32_000 / 2);

			const dataset = valid();
			dataset.cases = Array.from({ length: MAX_CASES }, (_, index) => ({
				id: `privacy_${index + 1}`,
				text: `${index}`.padStart(MAX_CASE_CHARS, 'あ'),
				difficulty: 'easy',
				gold: 'safe'
			}));
			expect(() => validateDataset(dataset)).not.toThrow();
		});
	});

	it('件数の上限を超えるデータセットを拒む', () => {
		expect(
			broken((d) => {
				d.cases = Array.from({ length: MAX_CASES + 1 }, (_, index) => ({
					id: `privacy_${index + 1}`,
					text: `事例 ${index}`,
					difficulty: 'easy',
					gold: 'safe'
				}));
			})
		).toThrow(/上限 50 を超える/);
	});

	it('未知の difficulty を拒む', () => {
		expect(
			broken((d) => {
				(d.cases as Record<string, unknown>[])[0].difficulty = 'trivial';
			})
		).toThrow(/difficulty が/);
	});
});

describe('配布する fixture', () => {
	for (const theme of BATCH_THEMES) {
		// benchmark が読むのはこのファイルである。テスト用の見本ではない。
		const dataset = validateDataset(
			JSON.parse(readFileSync(`data/batch/${theme}.json`, 'utf8')) as unknown
		);

		it(`${theme} は50件で、難易度が偏っていない`, () => {
			const summary = summarizeDataset(dataset);
			expect(summary.cases).toBe(50);
			// 曖昧なケースを意図的に入れる（docs/BATCH_JUDGE_DESIGN.md §5）。
			expect(summary.difficulty.medium + summary.difficulty.hard).toBeGreaterThanOrEqual(10);
		});
	}

	it('privacy と deadline はどのラベルにも事例がある', () => {
		for (const theme of ['privacy', 'deadline'] as const) {
			const summary = summarizeDataset(
				validateDataset(JSON.parse(readFileSync(`data/batch/${theme}.json`, 'utf8')) as unknown)
			);
			for (const count of Object.values(summary.gold)) expect(count).toBeGreaterThan(0);
		}
		// deadline は5クラスすべてを含む。片寄ると混同行列が読めない。
		const deadline = summarizeDataset(
			validateDataset(JSON.parse(readFileSync('data/batch/deadline.json', 'utf8')) as unknown)
		);
		expect(Object.keys(deadline.gold).sort()).toEqual(['later', 'none', 'now', 'soon', 'today']);
	});

	it('dx はどの区分にも事例がある', () => {
		// 事例の無い区分があると、その区分へ寄せた混同が見えない。
		const summary = summarizeDataset(
			validateDataset(JSON.parse(readFileSync('data/batch/dx.json', 'utf8')) as unknown)
		);
		for (const value of DX_CLASSES) expect(summary.gold[value] ?? 0).toBeGreaterThan(0);
	});
});
