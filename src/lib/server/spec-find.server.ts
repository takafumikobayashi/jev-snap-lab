/**
 * SPEC FIND のサーバー側入口。
 *
 * コーパスの検証は**リクエスト処理の中**で行う。モジュール初期化時に評価
 * すると、データの不備がルートの import 失敗になり、SvelteKit は JSON の
 * エラー封筒ではなく HTML の 500 を返す。CITY で同じ穴を踏んでいる
 * （docs/ARCHITECTURE.md §7）。
 */

import { env } from '$env/dynamic/private';
import type { Questions } from '@typesafe-ai/sdk';
import rawCorpus from '../../../data/spec/common-feature-2.7.json';
import type { JsonValue } from '$lib/types/semantic';
import type { SpecCorpus } from '$lib/types/spec';
import type { SpecFindResult } from '$lib/types/judge';
import { validateCorpus } from './spec-corpus.server';
import { joinSpecEvidence, toSemanticCandidates } from './spec-evidence.server';
import { evaluateSemanticFit, rankCandidates } from './semantic-match.server';
import { SPEC_POLICY, SPEC_RANKING } from './semantic-policies.server';
import { JudgeError } from './errors.server';

/** 出典URLに許すホスト。公式の一次資料だけを扱う。 */
const ALLOWED_HOSTS = ['www.digital.go.jp'];

let cached: SpecCorpus | null = null;

/**
 * 実験機能として既定では無効にする。
 *
 * 有効化は明示的な `true` だけ。値の取り違えで本番へ出ないようにする。
 */
export function isSpecFindEnabled(): boolean {
	return env.SPEC_FIND_ENABLED?.trim() === 'true';
}

function loadCorpus(): SpecCorpus {
	if (cached) return cached;
	cached = validateCorpus(rawCorpus, { allowedHosts: ALLOWED_HOSTS });
	return cached;
}

/** テスト用。モジュールキャッシュを跨いで読み直す。 */
export function resetSpecCorpus(): void {
	cached = null;
}

/** 上流へ1回送る関数。`/api/judge` から既存の evaluate 経路を渡す。 */
export type SpecSender = (request: {
	state: Record<string, JsonValue>;
	questions: Questions;
}) => Promise<Record<string, unknown>>;

/**
 * 入力から、読むべき仕様箇所を探す。
 *
 * Jevには意味評価だけをさせる。順位、閾値、表示件数、出典はアプリ側で決める
 * （docs/SPEC_FIND_DESIGN.md §6）。
 */
export async function findSpecPassages(text: string, send: SpecSender): Promise<SpecFindResult> {
	if (!isSpecFindEnabled()) {
		throw new JudgeError('INVALID_INPUT', 'SPEC FIND is disabled');
	}
	const corpus = loadCorpus();

	const scores = await evaluateSemanticFit(
		toSemanticCandidates(corpus),
		SPEC_POLICY,
		{ mode: 'spec', text },
		send
	);
	const ranked = rankCandidates(
		scores,
		corpus.passages.map((passage) => passage.passageId),
		SPEC_RANKING
	);
	const { hits, unresolved } = joinSpecEvidence(corpus, ranked.ranked);

	return {
		documentTitle: corpus.document.title,
		version: corpus.document.version,
		retrievedAt: corpus.document.retrievedAt,
		sourceUrl: corpus.document.sourceUrl,
		// 候補が無いことを、無理に最上位を出して隠さない。
		abstained: ranked.abstained || hits.length === 0,
		hits,
		unresolved
	};
}
