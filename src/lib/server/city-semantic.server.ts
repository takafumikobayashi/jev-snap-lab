/**
 * CITY Stage 2（Semantic Fit）の shadow 実験。
 *
 * 現行の `route_to` Choice を既定経路として残し、その結果を上書きしない。
 * 上位候補の分掌事務と入力文の意味的な近さを追加で測り、**画面へは出さず**
 * metrics だけ記録する（docs/CITY_SEMANTIC_EXPERIMENT.md §7）。
 *
 * 失敗しても既定の CITY 結果が返ることを成功条件にする。実験のために
 * 動いている機能を壊さない。
 */

import { env } from '$env/dynamic/private';
import type { JudgeResponse } from '$lib/types/judge';
import type { Questions } from '@typesafe-ai/sdk';
import type { JsonValue } from '$lib/types/semantic';
import { evaluateSemanticFit, rankCandidates } from './semantic-match.server';
import { CITY_POLICY, CITY_RANKING } from './semantic-policies.server';
import { responsibilityCandidates, jurisdictionName } from './city-directory.server';

/** 1課あたりに送る分掌の上限。候補説明と同じ12件。 */
const MAX_RESPONSIBILITIES = 12;

/**
 * 実験として動かす課の数。
 *
 * v0 は上位1課に限る。2課へ広げる条件は評価データで決める
 * （docs/CITY_SEMANTIC_EXPERIMENT.md §4.1）。
 */
const MAX_SECTIONS = 1;

/**
 * 上流へ1回送る関数。トークン数も一緒に返す。
 *
 * answers へ観測値を混ぜてはならない。`readSemanticScores` は送っていない
 * キーを契約違反として弾くため、混ぜると正常な応答が落ちる。
 */
export type CitySemanticSender = (request: {
	state: Record<string, JsonValue>;
	questions: Questions;
}) => Promise<{ answers: Record<string, unknown>; inputTokens: number }>;

/** 実験機能。既定では無効にし、明示的な `true` だけを有効とする。 */
export function isCitySemanticEnabled(): boolean {
	return env.CITY_SEMANTIC_EXPERIMENT?.trim() === 'true';
}

/** 記録する観測値。入力本文は含めない。 */
export type CitySemanticMetrics = {
	/** Stage 1 が選んだ課。 */
	candidateId: string;
	/** Stage 2 へ送った分掌の件数。 */
	sent: number;
	/** 閾値を超えた分掌のID（上位から）。 */
	hits: string[];
	/** 最上位の適合度。候補が無ければ null。 */
	topFit: number | null;
	abstained: boolean;
	latencyMs: number;
	inputTokens: number;
};

/**
 * Stage 2 を走らせる。
 *
 * 実行しない条件（無効、CITY以外、候補が組織に紐づかない、分掌が無い、
 * 予算が足りない）では null を返す。呼び出し側は既定の結果をそのまま返す。
 */
export async function runCitySemanticShadow(
	response: JudgeResponse,
	text: string,
	budgetMs: number,
	send: CitySemanticSender
): Promise<CitySemanticMetrics | null> {
	if (!isCitySemanticEnabled()) return null;

	// Stage 1 で時間を使い切っていれば追加で呼ばない。既定の結果を優先する。
	if (budgetMs <= 0) return null;

	const candidates = topCandidates(response);
	if (candidates.length === 0) return null;

	const responsibilities = candidates.flatMap((candidateId) =>
		responsibilityCandidates(candidateId, MAX_RESPONSIBILITIES)
	);
	// `other_or_unclear` のように組織へ紐づかない候補は分掌を持たない。
	if (responsibilities.length === 0) return null;

	const startedAt = performance.now();
	let inputTokens = 0;

	const scores = await evaluateSemanticFit(
		responsibilities.map((responsibility) => ({
			candidateId: responsibility.responsibilityId,
			// Stage 2 は分掌そのものとの適合を測るため、要約ではなく条文を送る
			// （docs/CITY_SEMANTIC_EXPERIMENT.md §4.3）。
			text: responsibility.officialText,
			context: responsibility.section
		})),
		CITY_POLICY,
		{ mode: 'city', text, jurisdiction: jurisdictionName() },
		async (request) => {
			const { answers, inputTokens: used } = await send(request);
			inputTokens += used;
			return answers;
		}
	);

	const ranked = rankCandidates(
		scores,
		responsibilities.map((responsibility) => responsibility.responsibilityId),
		CITY_RANKING
	);

	return {
		candidateId: candidates[0],
		sent: responsibilities.length,
		hits: ranked.ranked.map((row) => row.candidateId),
		topFit: ranked.ranked[0]?.probability ?? null,
		abstained: ranked.abstained,
		latencyMs: Math.round(performance.now() - startedAt),
		inputTokens
	};
}

/**
 * Stage 1 の結果から対象の課を選ぶ。
 *
 * 選ばれた候補を対象にする。分布の最大とは限らないため、確率順ではなく
 * `selected` を見る（docs/JEV_DESIGN.md §7）。
 */
function topCandidates(response: JudgeResponse): string[] {
	const routeTo = response.results.find((card) => card.id === 'route_to');
	if (routeTo?.kind !== 'choice') return [];
	return [routeTo.selected].slice(0, MAX_SECTIONS);
}
