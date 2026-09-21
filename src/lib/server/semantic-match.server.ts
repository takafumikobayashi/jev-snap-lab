/**
 * CITY / SPEC FIND 共通の意味評価エンジン。
 *
 * 境界は `候補集合 -> Map<候補ID, probability>` とする。上流を何回呼ぶかは
 * この中の実装詳細であり、順位付け・abstain・出典joinの層はそれを知らない
 * （docs/IMPLEMENTATION_PLAN.md §8.0）。
 *
 * Jevには意味評価だけをさせる。順位、閾値、表示件数、説明文はアプリ側で決める。
 */

import { noul, type Questions } from '@typesafe-ai/sdk';
import { JudgeError } from './errors.server';
import type {
	RankingOptions,
	RankingResult,
	SemanticCandidate,
	SemanticScores
} from '$lib/types/semantic';

/**
 * 1リクエストへ入れる候補の上限。
 *
 * 実測で40件まで成立した（docs/IMPLEMENTATION_PLAN.md §8.1）。422もtoken上限も
 * answer欠落も無く、latencyは候補数にほとんど依存しない。超える場合だけ
 * 分割するが、分割はlatency 22倍・入力token 2.5倍になるため既定では使わない。
 */
export const MAX_CANDIDATES_PER_REQUEST = 40;

/** stateへ置く候補のキー接頭辞。質問IDの連番と対応する。 */
const CANDIDATE_KEY = 'c';
const QUESTION_KEY = 'fit';

/** ドメインごとに異なる部分。行政業務固有の判断ルールは共通化しない。 */
export type SemanticPolicy = {
	/** stateのどのキーへ候補を置くか。instructionsのパスと一致させる。 */
	candidatesKey: string;
	/**
	 * 質問文。候補への参照パスを受け取る。
	 *
	 * パスは**オブジェクトのキー**で渡す（`candidates.c12.text`）。配列
	 * インデックスにすると、候補が20件を超えたあたりから確率が隣接
	 * インデックスへ滲む（docs/IMPLEMENTATION_PLAN.md §8.1）。
	 */
	instructions: (paths: { text: string; context: string }) => string;
	criteria: { true: string; false: string };
};

/** 上流へ1回送る関数。engineの外から差し替える（テストではmock）。 */
export type SemanticSender = (request: {
	state: Record<string, unknown>;
	questions: Questions;
}) => Promise<Record<string, unknown>>;

type BuiltRequest = {
	state: Record<string, unknown>;
	questions: Questions;
	/** 質問の連番 -> 候補ID。質問IDの文字列からは復元しない。 */
	index: string[];
};

/**
 * 1回ぶんのリクエストを組み立てる。
 *
 * 候補はオブジェクトとして置く。`baseState` にはユーザー入力など、候補以外の
 * stateを入れる。判定に寄与しないバージョン文字列は入れない。
 */
export function buildSemanticRequest(
	candidates: readonly SemanticCandidate[],
	policy: SemanticPolicy,
	baseState: Record<string, unknown>
): BuiltRequest {
	if (candidates.length === 0) {
		throw new JudgeError('QUESTION_DEFINITION_ERROR', 'Semantic Fit の候補が空である');
	}
	if (candidates.length > MAX_CANDIDATES_PER_REQUEST) {
		throw new JudgeError(
			'QUESTION_DEFINITION_ERROR',
			`Semantic Fit の候補が ${candidates.length} 件で上限 ${MAX_CANDIDATES_PER_REQUEST} を超える`
		);
	}

	const bag: Record<string, { text: string; context?: string }> = {};
	const questions: Questions = {};
	const index: string[] = [];

	candidates.forEach((candidate, position) => {
		const key = `${CANDIDATE_KEY}${position}`;
		const path = `${policy.candidatesKey}.${key}`;
		bag[key] = candidate.context
			? { text: candidate.text, context: candidate.context }
			: { text: candidate.text };
		questions[`${QUESTION_KEY}_${position}`] = noul(
			policy.instructions({ text: `${path}.text`, context: `${path}.context` }),
			policy.criteria
		);
		index.push(candidate.candidateId);
	});

	return { state: { ...baseState, [policy.candidatesKey]: bag }, questions, index };
}

/**
 * Jevのanswersを `候補ID -> probability` へ直す。
 *
 * 欠落、未知のID、範囲外の確率はいずれも契約違反として扱い、部分的な結果を
 * 正しい判定として通さない。
 */
export function readSemanticScores(
	answers: unknown,
	index: readonly string[]
): Map<string, number> {
	if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
		throw contractError('answers がオブジェクトでない');
	}
	const record = answers as Record<string, unknown>;

	const expected = new Set(index.map((_, position) => `${QUESTION_KEY}_${position}`));
	for (const id of Object.keys(record)) {
		if (!expected.has(id)) throw contractError(`送っていない質問 ${id} が返っている`);
	}

	const scores = new Map<string, number>();
	index.forEach((candidateId, position) => {
		const id = `${QUESTION_KEY}_${position}`;
		const answer = record[id];
		if (answer === null || typeof answer !== 'object') {
			throw contractError(`${id} の answer が無い`);
		}
		const value = (answer as { noul?: unknown }).noul;
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
			throw contractError(`${id}.noul が 0..1 の数値でない`);
		}
		// 同じ候補IDを二重に送ると、どちらの確率か決められない。
		if (scores.has(candidateId)) throw contractError(`候補ID ${candidateId} が重複している`);
		scores.set(candidateId, value);
	});
	return scores;
}

/**
 * 意味評価を実行する。
 *
 * 候補が上限を超える場合だけ分割して送り、結果を1つのMapへまとめる。
 * 呼び出し側は回数を意識しない。
 */
export async function evaluateSemanticFit(
	candidates: readonly SemanticCandidate[],
	policy: SemanticPolicy,
	baseState: Record<string, unknown>,
	send: SemanticSender
): Promise<Map<string, number>> {
	const scores = new Map<string, number>();
	for (let from = 0; from < candidates.length; from += MAX_CANDIDATES_PER_REQUEST) {
		const chunk = candidates.slice(from, from + MAX_CANDIDATES_PER_REQUEST);
		const request = buildSemanticRequest(chunk, policy, baseState);
		const answers = await send({ state: request.state, questions: request.questions });
		for (const [candidateId, value] of readSemanticScores(answers, request.index)) {
			scores.set(candidateId, value);
		}
	}
	return scores;
}

/**
 * 順位付けとabstain。
 *
 * 同率は候補の並び順で決める。同じ入力・同じデータで同じ順序になることを
 * 保証しないと、比較実験の結果が読めない。
 */
export function rankCandidates(
	scores: SemanticScores,
	order: readonly string[],
	options: RankingOptions
): RankingResult {
	const position = new Map(order.map((candidateId, at) => [candidateId, at]));
	const rows = [...scores]
		.filter(([, probability]) => probability >= options.minProbability)
		.sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1];
			return (position.get(a[0]) ?? 0) - (position.get(b[0]) ?? 0);
		})
		.slice(0, options.topK);

	return {
		ranked: rows.map(([candidateId, probability], at) => ({
			candidateId,
			probability,
			rank: at + 1
		})),
		abstained: rows.length === 0
	};
}

function contractError(detail: string): JudgeError {
	return new JudgeError('UPSTREAM_UNAVAILABLE', `Semantic Fit の契約違反: ${detail}`);
}
