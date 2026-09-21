/**
 * Semantic Fit（意味的適合度）の共通型。
 *
 * CITYの分掌事務とSPEC FINDの仕様passageは、どちらも「ユーザーの短文と、
 * 構造化された候補テキストの意味的な近さ」を測る。評価そのものは共通化し、
 * 質問文・閾値・出典の持ち方はドメインごとのpolicyへ分ける
 * （docs/JEV_DESIGN.md §7）。
 */

/** 意味評価にかける候補1件。 */
export type SemanticCandidate = {
	/**
	 * データセット側の安定ID（`responsibilityId` / `passageId`）。
	 *
	 * 質問IDには埋め込まない。実データのIDはセグメント自体がアンダースコアを
	 * 含むため、文字列変換で往復できない（docs/JEV_DESIGN.md §7）。
	 */
	candidateId: string;
	/** 判定対象の本文。 */
	text: string;
	/** 見出しや課名など、本文だけでは文脈を失う場合に添える。 */
	context: string | null;
};

/** 候補ID -> Noulの `yesProbability`。Choiceと違い合計1にならない。 */
export type SemanticScores = ReadonlyMap<string, number>;

/** 順位付け後の1件。 */
export type RankedCandidate = {
	candidateId: string;
	probability: number;
	/** 1始まり。同率は候補の並び順で決める。 */
	rank: number;
};

export type RankingOptions = {
	/** 表示件数の上限。 */
	topK: number;
	/** これ未満は候補として扱わない。 */
	minProbability: number;
};

export type RankingResult = {
	ranked: RankedCandidate[];
	/**
	 * 閾値を超える候補が無かったか。
	 *
	 * 無理に最上位を出して、関係の薄い候補を回答のように見せない
	 * （docs/SPEC_FIND_DESIGN.md §6.3）。
	 */
	abstained: boolean;
};
