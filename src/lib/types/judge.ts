/**
 * `POST /api/judge` のアプリ内契約。
 *
 * TypeSafe の生レスポンスはブラウザへ渡さず、この形へ正規化する。
 * 契約の出所は docs/JEV_DESIGN.md の §8 と docs/ARCHITECTURE.md の §7。
 */

export const MODES = ['love', 'social', 'city'] as const;

export type Mode = (typeof MODES)[number];

/** 入力の上限。Unicode code points で数える（UTF-16 の length ではない）。 */
export const MAX_INPUT_CODE_POINTS = 280;

export function isMode(value: unknown): value is Mode {
	return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

export type JudgeRequest = {
	mode: Mode;
	text: string;
};

/**
 * Choice の結果。`options` は criteria の全候補で、probability の合計は 1 になる。
 * Noul の yes 確率とは意味が違うため、UI でも同じ見た目のバーで並べない。
 */
export type ChoiceCard = {
	id: string;
	label: string;
	kind: 'choice';
	selected: string;
	options: Array<{ key: string; label: string; probability: number }>;
	confidence: number;
};

/**
 * Score の結果。`score` はレベル間に着地し得る確率加重値で、`legend` は整数レベルのラベル。
 * 表示規則は docs/JEV_DESIGN.md の §8「Scoreの表示規則」に従う。
 */
export type ScoreCard = {
	id: string;
	label: string;
	kind: 'score';
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
};

/** Noul の結果。yes である確率のみを持ち、confidence は存在しない。 */
export type NoulCard = {
	id: string;
	label: string;
	kind: 'noul';
	yesProbability: number;
};

export type ResultCard = ChoiceCard | ScoreCard | NoulCard;

export type CitySource = {
	sourceId: string;
	title: string;
	url: string;
	locator: string;
	retrievedAt: string;
	effectiveFrom: string | null;
};

export type JudgeResponse = {
	requestId: string;
	mode: Mode;
	model: string;
	latencyMs: number;
	usage?: {
		inputTokens?: number;
		/** 課金対象外。output tokens は無料。 */
		outputTokens?: number;
		estimatedCostUsd?: number;
	};
	results: ResultCard[];
	city?: {
		directoryVersion: string;
		sources: CitySource[];
	};
};
