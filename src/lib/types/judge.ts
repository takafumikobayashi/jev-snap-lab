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

/**
 * Unicode code points で文字数を数える。
 *
 * `String.prototype.length` は UTF-16 の code unit 数なので、絵文字や
 * 一部の漢字（サロゲートペア）で実際より大きい値を返す。280 の上限判定に
 * length を使うと、日本語話者の入力を不当に短く切ることになる。
 */
export function countCodePoints(value: string): number {
	return [...value].length;
}

/** 入力が 280 code points 以内かどうか。空文字は true。 */
export function isWithinLengthLimit(value: string): boolean {
	return countCodePoints(value) <= MAX_INPUT_CODE_POINTS;
}

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
	/** 架空データでは null。実在の自治体を特定できるため URL を持たせない。 */
	url: string | null;
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
		/** 候補生成に使った組織データのバージョン。観測ログと根拠表示に使う。 */
		directoryVersion: string;
		/**
		 * 候補に公式データが紐付いていない状態。
		 *
		 * `true` の間、候補は出典・施行日・取得日を持たない。UI は
		 * 「根拠データ未登録」を明示し、公式の担当決定として見せてはならない
		 * （docs/PRODUCT_SPEC.md §8）。Phase 4 で公式データへ差し替える。
		 */
		provisional: boolean;
		sources: CitySource[];
		/**
		 * ローカルの join で解決した組織単位。
		 *
		 * `matchedResponsibilities` が空なら、課までしか絞れていないことを
		 * 意味する。係を推測して名指ししない（docs/CITY_DATA.md §5）。
		 */
		resolvedUnit?: {
			officialName: string;
			section: string;
			unit: string | null;
			matchedResponsibilities: Array<{ officialText: string; responsibilityId: string }>;
		};
	};
};
