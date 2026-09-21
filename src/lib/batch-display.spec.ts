import { describe, expect, it } from 'vitest';
import { decidingProbability, verdictLabel } from './batch-display';

describe('verdictLabel', () => {
	it('「安全」と訳さない', () => {
		// このモードが出せる結論ではない（docs/BATCH_JUDGE_DESIGN.md §3.1）。
		expect(verdictLabel('no_signal')).toBe('要確認シグナルなし');
		expect(verdictLabel('no_signal')).not.toContain('安全');
	});

	it('知らない値はそのまま返す', () => {
		expect(verdictLabel('unknown')).toBe('unknown');
	});
});

describe('decidingProbability', () => {
	it('PRIVACY は判定に使わない sensitive を混ぜない', () => {
		// 「生活保護受給世帯の一覧をExcelから抽出しました」は sensitive=0.97、
		// 判定は `要確認シグナルなし` になる。最大値を出すと「要確認シグナル
		// なし 97%」となり、シグナルが無いことの確信度に見える。実際に画面へ
		// 出てしまった。
		const signals = [
			{ key: 'identifies', probability: 0.06 },
			{ key: 'personal', probability: 0.08 },
			{ key: 'sensitive', probability: 0.97 }
		];
		expect(decidingProbability('privacy', signals)).toBeCloseTo(0.08);
	});

	it('PRIVACY は identifies と personal の高い方を使う', () => {
		const signals = [
			{ key: 'identifies', probability: 0.99 },
			{ key: 'personal', probability: 0.5 },
			{ key: 'sensitive', probability: 0.2 }
		];
		expect(decidingProbability('privacy', signals)).toBeCloseTo(0.99);
	});

	it('Choice のテーマは返ってきた確率をそのまま使う', () => {
		expect(decidingProbability('deadline', [{ key: 'soon', probability: 0.82 }])).toBeCloseTo(0.82);
		expect(decidingProbability('dx', [{ key: 'bpr', probability: 0.71 }])).toBeCloseTo(0.71);
	});

	it('軸が無ければ0にする', () => {
		expect(decidingProbability('privacy', [])).toBe(0);
	});
});
