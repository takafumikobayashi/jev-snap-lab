/**
 * 表示のための変換。クライアントとサーバーの両方から使う。
 *
 * 出所は docs/PRODUCT_SPEC.md の §5 表示ルール。
 */

import type { ResultCard, ScoreCard } from './types/judge';

/**
 * 確率を整数パーセントにする。内部 JSON は元の小数を保持したままにする。
 *
 * 0 でも 1 でもない値が 0% / 100% に丸められると「候補が無い」ように
 * 見えるため、極端な丸めだけ 1% 刻みの下限・上限へ寄せる。
 */
export function toPercent(probability: number): number {
	const percent = Math.round(probability * 100);
	if (percent === 0 && probability > 0) return 1;
	if (percent === 100 && probability < 1) return 99;
	return percent;
}

/** confidence の帯。正答率ではなく分布のまとまりを表す。 */
export type ConfidenceBand = 'low' | 'medium' | 'high';

/**
 * 初期の視覚閾値。`< 0.60` を注意、`>= 0.80` を高いまとまりとする。
 * 実データで評価して調整する前提の暫定値（docs/PRODUCT_SPEC.md §5）。
 */
export function confidenceBand(confidence: number): ConfidenceBand {
	if (confidence < 0.6) return 'low';
	if (confidence < 0.8) return 'medium';
	return 'high';
}

/** 低確度のとき画面に出す注記。結果は隠さない。 */
export function confidenceNote(confidence: number): string | null {
	return confidenceBand(confidence) === 'low' ? '判断が割れています' : null;
}

/**
 * Score カードの表示ラベル。
 *
 * `Math.round(score)` ではなく `probabilities` の最大レベルを使う。
 * 分布が二峰性のとき、丸めた値が最も確からしいレベルと一致しないため
 * （docs/JEV_DESIGN.md §8）。同率なら小さいレベルを採る。
 */
export function dominantLevel(probabilities: Record<string, number>): string {
	let best = '0';
	let bestValue = -1;
	for (const level of Object.keys(probabilities).sort((a, b) => Number(a) - Number(b))) {
		if (probabilities[level] > bestValue) {
			best = level;
			bestValue = probabilities[level];
		}
	}
	return best;
}

export function scoreDisplayLabel(card: ScoreCard): string {
	return card.legend[dominantLevel(card.probabilities)] ?? '';
}

/** メーターの位置（0〜100%）。`score` をそのまま使い、丸めない。 */
export function scoreMeterPercent(card: ScoreCard): number {
	const levels = Object.keys(card.legend).length;
	if (levels < 2) return 0;
	return (card.score / (levels - 1)) * 100;
}

/** メーター両端に添える最小・最大レベルのラベル。尺度の意味を常に示す。 */
export function scoreEndLabels(card: ScoreCard): { low: string; high: string } {
	const levels = Object.keys(card.legend)
		.map(Number)
		.sort((a, b) => a - b);
	return {
		low: card.legend[String(levels[0])] ?? '',
		high: card.legend[String(levels[levels.length - 1])] ?? ''
	};
}

/** カードが confidence を持つか。Noul は持たない。 */
export function hasConfidence(
	card: ResultCard
): card is Extract<ResultCard, { confidence: number }> {
	return card.kind === 'choice' || card.kind === 'score';
}

/** コスト推計の表示。極小の値でも 0 と表示しない。 */
export function formatCostUsd(cost: number): string {
	if (cost === 0) return '$0';
	if (cost < 0.000001) return '< $0.000001';
	return `$${cost.toFixed(6)}`;
}
