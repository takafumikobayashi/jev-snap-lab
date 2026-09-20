import { describe, expect, it } from 'vitest';
import type { ScoreCard } from './types/judge';
import {
	confidenceBand,
	confidenceNote,
	dominantLevel,
	formatCostUsd,
	scoreDisplayLabel,
	scoreEndLabels,
	scoreMeterPercent,
	toPercent
} from './display';

const scoreCard = (score: number, probabilities: Record<string, number>): ScoreCard => ({
	id: 'level',
	label: '強さ',
	kind: 'score',
	score,
	legend: { 0: '低い', 1: '中くらい', 2: '高い' },
	probabilities,
	confidence: 0.9
});

describe('toPercent', () => {
	it('整数パーセントへ丸める', () => {
		expect(toPercent(0.814)).toBe(81);
		expect(toPercent(0.5)).toBe(50);
	});

	it('ちょうど 0 と 1 はそのまま', () => {
		expect(toPercent(0)).toBe(0);
		expect(toPercent(1)).toBe(100);
	});

	it('微小な確率を 0% にしない', () => {
		// 実機の Choice は 0.003 のような値を返す。0% だと候補が無いように見える。
		expect(toPercent(0.003)).toBe(1);
	});

	it('1 未満を 100% にしない', () => {
		expect(toPercent(0.999)).toBe(99);
	});
});

describe('confidenceBand / confidenceNote', () => {
	it('閾値どおりに帯を返す', () => {
		expect(confidenceBand(0.59)).toBe('low');
		expect(confidenceBand(0.6)).toBe('medium');
		expect(confidenceBand(0.79)).toBe('medium');
		expect(confidenceBand(0.8)).toBe('high');
	});

	it('低確度にだけ注記を出す', () => {
		expect(confidenceNote(0.4)).toBe('判断が割れています');
		expect(confidenceNote(0.75)).toBeNull();
		expect(confidenceNote(0.95)).toBeNull();
	});
});

describe('dominantLevel / scoreDisplayLabel', () => {
	it('最大確率のレベルを選ぶ', () => {
		expect(dominantLevel({ 0: 0, 1: 0.95, 2: 0.05 })).toBe('1');
	});

	it('二峰分布で score の丸めより最大確率を優先する', () => {
		// score = 1.0 なので round は 1 だが、最も確からしいのは 0。
		expect(dominantLevel({ 0: 0.45, 1: 0.1, 2: 0.45 })).toBe('0');
	});

	it('日本語ラベルを返す', () => {
		expect(scoreDisplayLabel(scoreCard(1.05, { 0: 0, 1: 0.95, 2: 0.05 }))).toBe('中くらい');
	});
});

describe('scoreMeterPercent', () => {
	it('score をそのままスケールし、丸めない', () => {
		expect(scoreMeterPercent(scoreCard(1.05, { 0: 0, 1: 0.95, 2: 0.05 }))).toBeCloseTo(52.5);
	});

	it('両端は 0% と 100%', () => {
		expect(scoreMeterPercent(scoreCard(0, { 0: 1, 1: 0, 2: 0 }))).toBe(0);
		expect(scoreMeterPercent(scoreCard(2, { 0: 0, 1: 0, 2: 1 }))).toBe(100);
	});
});

describe('scoreEndLabels', () => {
	it('最小と最大のレベルのラベルを返す', () => {
		expect(scoreEndLabels(scoreCard(1, { 0: 0, 1: 1, 2: 0 }))).toEqual({
			low: '低い',
			high: '高い'
		});
	});
});

describe('formatCostUsd', () => {
	it('極小の値を 0 と表示しない', () => {
		expect(formatCostUsd(0.0000004)).toBe('< $0.000001');
	});

	it('実機の値を表示できる', () => {
		expect(formatCostUsd(0.00003965)).toBe('$0.000040');
	});

	it('0 は 0 と表示する', () => {
		expect(formatCostUsd(0)).toBe('$0');
	});
});
