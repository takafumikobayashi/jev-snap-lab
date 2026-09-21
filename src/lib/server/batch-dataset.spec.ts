import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BATCH_THEMES, DX_CLASSES, PRIVACY_VERDICTS } from '$lib/types/batch';
import { countCodePoints, MAX_INPUT_CODE_POINTS } from '$lib/types/judge';
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
		labelStatus: 'draft',
		cases: [
			{
				id: 'privacy_001',
				text: '来月の会議の日程を決めたい',
				difficulty: 'easy',
				gold: 'no_signal'
			},
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

describe('PRIVACY の結論の呼び方', () => {
	it('「安全」と読める語を結論に使わない', () => {
		// `safe` は安全の保証と読まれる。このモードが出せる結論ではない
		// （docs/BATCH_JUDGE_DESIGN.md §3.1）。注釈で守ると必ず漏れるので、
		// 値そのものを禁じる。
		expect(PRIVACY_VERDICTS).not.toContain('safe');
		expect(PRIVACY_VERDICTS).toEqual(['no_signal', 'review']);
	});
});

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
					d.referenceDate = '2026-09-21';
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

		it('サロゲートペアを1文字として数える', () => {
			// `String.prototype.length` は UTF-16 の code unit 数なので、𠮷 のような
			// 漢字や絵文字を2文字と数える。入力検証（countCodePoints）と数え方が
			// ずれると、画面で入る文章が fixture に入らなくなる。
			const surrogate = '𠮷'.repeat(MAX_CASE_CHARS);
			expect(surrogate.length).toBe(MAX_CASE_CHARS * 2);
			expect(countCodePoints(surrogate)).toBe(MAX_CASE_CHARS);

			const dataset = valid();
			(dataset.cases as Record<string, unknown>[])[0].text = surrogate;
			expect(() => validateDataset(dataset)).not.toThrow();
		});

		it('1件あたりの上限を超える本文を拒む', () => {
			expect(
				broken((d) => {
					(d.cases as Record<string, unknown>[])[1].text = 'あ'.repeat(MAX_CASE_CHARS + 1);
				})
			).toThrow(/上限 280 を超える/);
			// code point で数えるので、サロゲートペアでも281文字目で落ちる。
			expect(
				broken((d) => {
					(d.cases as Record<string, unknown>[])[1].text = '𠮷'.repeat(MAX_CASE_CHARS + 1);
				})
			).toThrow(/が 281 文字で上限 280 を超える/);
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
				gold: 'no_signal'
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
					gold: 'no_signal'
				}));
			})
		).toThrow(/上限 50 を超える/);
	});

	describe('referenceDate', () => {
		/** theme だけ deadline へ変えた、それ以外は正しいデータセット。 */
		const asDeadline = (mutate: (dataset: Record<string, unknown>) => void) =>
			broken((d) => {
				d.theme = 'deadline';
				d.referenceDate = '2026-09-21';
				for (const [index, item] of (d.cases as Record<string, unknown>[]).entries()) {
					item.id = `deadline_${index + 1}`;
					item.gold = 'now';
				}
				mutate(d);
			});

		it('deadline では必須である', () => {
			// 「9月25日17時まで」のような絶対日付は、基準日が無ければ gold が
			// どの区分にも決まらない。無いまま通すと、Jevの誤判定とgoldの
			// 不整合を区別できなくなる。
			expect(
				asDeadline((d) => {
					delete d.referenceDate;
				})
			).toThrow(/referenceDate/);
		});

		it('日付として実在しない値を拒む', () => {
			expect(asDeadline((d) => (d.referenceDate = '2026-02-30'))).toThrow(
				/referenceDate が YYYY-MM-DD/
			);
			expect(asDeadline((d) => (d.referenceDate = '2026/09/21'))).toThrow(
				/referenceDate が YYYY-MM-DD/
			);
		});

		it('正しい値なら通る', () => {
			expect(asDeadline(() => {})).not.toThrow();
		});

		it('他のテーマでは省いてよいが、あるなら検証する', () => {
			expect(broken(() => {})).not.toThrow();
			expect(broken((d) => (d.referenceDate = '2026-13-01'))).toThrow(/referenceDate/);
		});
	});

	it('1事例の上限が画面の入力上限と同じである', () => {
		// 別々に持つと必ず片方が古くなる。画面で入る文章は fixture にも入る。
		expect(MAX_CASE_CHARS).toBe(MAX_INPUT_CODE_POINTS);
	});

	describe('labelStatus', () => {
		it('省けない', () => {
			// 省けるようにすると、書き忘れが「確認済み」と区別できなくなる。
			expect(
				broken((d) => {
					delete d.labelStatus;
				})
			).toThrow(/labelStatus/);
		});

		it('未知の値を拒む', () => {
			expect(broken((d) => (d.labelStatus = 'ok'))).toThrow(/labelStatus/);
		});

		it('reviewed も通る', () => {
			expect(broken((d) => (d.labelStatus = 'reviewed'))).not.toThrow();
		});
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

	it('配布しているgoldはまだ人手の確認を経ていない', () => {
		// 確認済みへ変えるのは人が全件を見たときだけである。この検査が落ちたら、
		// docs の「暫定ラベル」という記述と §4.6 の読み方を見直すこと。
		for (const theme of BATCH_THEMES) {
			const dataset = validateDataset(
				JSON.parse(readFileSync(`data/batch/${theme}.json`, 'utf8')) as unknown
			);
			expect(dataset.labelStatus, `${theme} の labelStatus`).toBe('draft');
		}
	});

	it('deadline は基準日を持ち、絶対日付の事例がそれに依存する', () => {
		const dataset = validateDataset(
			JSON.parse(readFileSync('data/batch/deadline.json', 'utf8')) as unknown
		);
		expect(dataset.referenceDate).toBe('2026-09-21');
		// 基準日があっても、それに依る事例が無ければ検査にならない。
		const absolute = dataset.cases.filter((item) => /\d+月\d+日/.test(item.text));
		expect(absolute.length).toBeGreaterThanOrEqual(2);
		for (const item of absolute) {
			expect(item.note, `${item.id} に基準日との関係を書く`).toMatch(/基準日/);
		}
	});

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
