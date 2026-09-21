/**
 * ドメインごとのSemantic Fit設定。
 *
 * 共通化するのは意味評価エンジンであり、行政業務固有の判断ルールではない
 * （docs/IMPLEMENTATION_PLAN.md §8.0）。質問文、閾値、表示件数はここで分ける。
 *
 * 閾値は実験設定である。Needleなど他システムのサンプル値をそのまま移植しない。
 * TypeSafe/JevのNoul確率に、別の検索デモのしきい値を持ち込んでも同じ意味に
 * なる保証はない（docs/CITY_SEMANTIC_EXPERIMENT.md §6.3）。
 */

import type { RankingOptions } from '$lib/types/semantic';
import type { SemanticPolicy } from './semantic-match.server';

/**
 * CITY: 住民の短文が、その分掌事務に含まれるか。
 *
 * 「誰が担当すべきか」ではなく「文面がこの事務に当てはまるか」を聞く。
 * 公式な担当の確定はJevにさせない（docs/CITY_DATA.md §5）。
 */
export const CITY_POLICY: SemanticPolicy = {
	candidatesKey: 'responsibilities',
	instructions: ({ text, context }) =>
		`Is the resident's \`text\` directly or meaningfully covered by \`${text}\`, which is handled by \`${context}\`? Judge the wording of the request, not the official truth of who must handle it.`,
	criteria: {
		true: 'The resident text is directly or meaningfully covered by this responsibility.',
		false: 'The text is not covered, is only weakly related, or cannot be judged.'
	}
};

/**
 * SPEC FIND: その仕様記述が、読むべき箇所として役に立つか。
 *
 * 仕様適合や実装可否を判定させない。探すのは「読むべき箇所」までである
 * （docs/SPEC_FIND_DESIGN.md §3）。
 */
export const SPEC_POLICY: SemanticPolicy = {
	candidatesKey: 'passages',
	instructions: ({ text, context }) =>
		`Does \`${text}\`, under the heading \`${context}\`, help locate a relevant part of the specification for the user's \`text\`? Judge semantic usefulness for finding a passage, not compliance, legal meaning, or implementation feasibility.`,
	criteria: {
		true: 'The passage is directly or meaningfully useful for finding the requested topic or operation.',
		false:
			'The passage is not useful, is only broadly related, or the relevance cannot be determined.'
	}
};

/**
 * 初期の表示設定。実験設定であり、実機評価で校正する。
 *
 * `minProbability` の 0.5 は、Phase 6.5 の実測で「適合する候補は 0.9 台、
 * 対象外の入力では全件 0.1 未満」だったことに基づく暫定の中間値である
 * （docs/IMPLEMENTATION_PLAN.md §8.1）。gold caseで見直す。
 */
export const CITY_RANKING: RankingOptions = { topK: 3, minProbability: 0.5 };
export const SPEC_RANKING: RankingOptions = { topK: 3, minProbability: 0.5 };
