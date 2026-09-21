/**
 * SPEC FIND の根拠join。
 *
 * Jevが返すのは候補IDと確率だけである。タイトル、章、ページ、URL、出典表示は
 * すべてバージョン管理した静的データから解決する。Jevに生成させない
 * （docs/SPEC_FIND_DESIGN.md §3）。
 */

import type { SpecCorpus, SpecPassage } from '$lib/types/spec';
import type { RankedCandidate } from '$lib/types/semantic';
import type { SpecHit } from '$lib/types/judge';
import { attributionFor, headingContextOf } from './spec-corpus.server';

// 表示用の型はレスポンス契約と同じものを使う。写すと必ず片方が古くなる。
export type { SpecHit } from '$lib/types/judge';

export type SpecJoinResult = {
	hits: SpecHit[];
	/**
	 * joinできなかった候補ID。
	 *
	 * 画面には出さず、requestIdとデータセット版だけをログする
	 * （docs/SPEC_FIND_DESIGN.md §7）。出典を解決できない候補を、
	 * 公式根拠付きの結果として見せてはならない。
	 */
	unresolved: string[];
};

export function joinSpecEvidence(
	corpus: SpecCorpus,
	ranked: readonly RankedCandidate[]
): SpecJoinResult {
	const byId = new Map<string, SpecPassage>(
		corpus.passages.map((passage) => [passage.passageId, passage])
	);

	const hits: SpecHit[] = [];
	const unresolved: string[] = [];

	for (const candidate of ranked) {
		const passage = byId.get(candidate.candidateId);
		if (!passage) {
			unresolved.push(candidate.candidateId);
			continue;
		}
		hits.push({
			// 落とした候補があっても順位を詰め直す。画面に欠番を出さない。
			rank: hits.length + 1,
			passageId: passage.passageId,
			fitProbability: candidate.probability,
			headingPath: passage.headingPath,
			sourceLocator: passage.sourceLocator,
			page: passage.page,
			text: passage.text,
			normalized: passage.normalized,
			attribution: attributionFor(corpus.document, passage),
			sourceUrl: corpus.document.sourceUrl
		});
	}

	return { hits, unresolved };
}

/** Jevへ渡す候補。出典メタデータは送らない。 */
export function toSemanticCandidates(corpus: SpecCorpus) {
	return corpus.passages.map((passage) => ({
		candidateId: passage.passageId,
		text: passage.text,
		// 文脈の作り方は検証側と同じ関数を使う。別々に持つと予算の検査が古くなる。
		context: headingContextOf(passage)
	}));
}
