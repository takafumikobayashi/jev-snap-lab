import { describe, expect, it } from 'vitest';
import { joinSpecEvidence, toSemanticCandidates } from './spec-evidence.server';
import { validateCorpus } from './spec-corpus.server';
import {
	buildSemanticRequest,
	evaluateSemanticFit,
	rankCandidates,
	readSemanticScores
} from './semantic-match.server';
import { SPEC_POLICY, SPEC_RANKING } from './semantic-policies.server';
import type { SpecCorpus } from '$lib/types/spec';

function corpus(): SpecCorpus {
	return validateCorpus(
		{
			schemaVersion: '1',
			document: {
				documentId: 'common-feature-2.7',
				title: '地方公共団体情報システム共通機能標準仕様書',
				version: '2.7',
				publishedAt: '2026-02-27',
				retrievedAt: '2026-09-21',
				sourceUrl: 'https://www.digital.go.jp/assets/spec.pdf',
				contentHash: 'sha256-abc'
			},
			passages: [
				{
					passageId: 'p.euc',
					documentId: 'common-feature-2.7',
					sectionId: '6.1',
					headingPath: ['EUC機能', 'データ抽出'],
					text: 'データを抽出し、職員が利用可能な形式で出力できること。',
					page: 42,
					sourceLocator: '§6.1',
					normalized: false,
					tags: ['euc']
				},
				{
					passageId: 'p.renkei',
					documentId: 'common-feature-2.7',
					sectionId: '3.2',
					headingPath: ['庁内データ連携機能', '連携方式'],
					text: '庁内の他業務システムとデータを連携できること。',
					page: 21,
					sourceLocator: '§3.2',
					normalized: true,
					tags: []
				}
			]
		},
		{ allowedHosts: ['www.digital.go.jp'] }
	);
}

describe('toSemanticCandidates', () => {
	it('出典メタデータをJevへ送らない', () => {
		// Jevへ渡すのは短い本文と候補IDだけ。URL・ページ・版は送らない。
		const candidates = toSemanticCandidates(corpus());
		expect(candidates[0]).toEqual({
			candidateId: 'p.euc',
			text: 'データを抽出し、職員が利用可能な形式で出力できること。',
			context: 'EUC機能 / データ抽出'
		});
		const sent = JSON.stringify(candidates);
		expect(sent).not.toContain('digital.go.jp');
		expect(sent).not.toContain('§6.1');
		expect(sent).not.toContain('2.7');
	});
});

describe('joinSpecEvidence', () => {
	it('順位ごとに出典を解決する', () => {
		const result = joinSpecEvidence(corpus(), [
			{ candidateId: 'p.euc', probability: 0.94, rank: 1 }
		]);
		expect(result.hits[0]).toMatchObject({
			rank: 1,
			passageId: 'p.euc',
			fitProbability: 0.94,
			sourceLocator: '§6.1',
			page: 42,
			sourceUrl: 'https://www.digital.go.jp/assets/spec.pdf'
		});
		expect(result.unresolved).toEqual([]);
	});

	it('原文と加工物で出典表示を変える', () => {
		const result = joinSpecEvidence(corpus(), [
			{ candidateId: 'p.euc', probability: 0.9, rank: 1 },
			{ candidateId: 'p.renkei', probability: 0.8, rank: 2 }
		]);
		expect(result.hits[0].attribution).toContain('出典：');
		expect(result.hits[1].attribution).toContain('を加工して作成');
	});

	it('joinできない候補は表示せず、IDだけ残す', () => {
		// 出典を解決できない候補を公式根拠付きの結果として見せない。
		const result = joinSpecEvidence(corpus(), [
			{ candidateId: 'p.missing', probability: 0.99, rank: 1 },
			{ candidateId: 'p.euc', probability: 0.9, rank: 2 }
		]);
		expect(result.hits.map((h) => h.passageId)).toEqual(['p.euc']);
		expect(result.unresolved).toEqual(['p.missing']);
	});

	it('落とした候補があっても順位を詰め直す', () => {
		const result = joinSpecEvidence(corpus(), [
			{ candidateId: 'p.missing', probability: 0.99, rank: 1 },
			{ candidateId: 'p.euc', probability: 0.9, rank: 2 }
		]);
		expect(result.hits[0].rank).toBe(1);
	});
});

describe('SPEC FIND の一連の流れ（Jevはmock）', () => {
	/** 候補IDごとに返す確率を決めたmock。 */
	const sender =
		(byId: Record<string, number>) =>
		async (request: { state: Record<string, unknown>; questions: Record<string, unknown> }) => {
			const bag = request.state.passages as Record<string, { text: string }>;
			return Object.fromEntries(
				Object.keys(request.questions).map((id) => {
					const position = Number(id.slice('fit_'.length));
					const text = bag[`c${position}`].text;
					return [id, { type: 'noul', noul: byId[text] ?? 0 }];
				})
			);
		};

	it('入力から出典付きの結果へ到達する', async () => {
		const data = corpus();
		const scores = await evaluateSemanticFit(
			toSemanticCandidates(data),
			SPEC_POLICY,
			{ mode: 'spec', text: 'Excelにデータを出して職員が加工したい' },
			sender({
				'データを抽出し、職員が利用可能な形式で出力できること。': 0.94,
				'庁内の他業務システムとデータを連携できること。': 0.11
			})
		);

		const ranked = rankCandidates(
			scores,
			data.passages.map((p) => p.passageId),
			SPEC_RANKING
		);
		expect(ranked.abstained).toBe(false);

		const joined = joinSpecEvidence(data, ranked.ranked);
		expect(joined.hits).toHaveLength(1);
		expect(joined.hits[0].passageId).toBe('p.euc');
		expect(joined.hits[0].sourceLocator).toBe('§6.1');
	});

	it('対象外の入力では abstain する', async () => {
		const data = corpus();
		const scores = await evaluateSemanticFit(
			toSemanticCandidates(data),
			SPEC_POLICY,
			{ mode: 'spec', text: '株式の売買手数料の相場を知りたい' },
			sender({})
		);
		const ranked = rankCandidates(
			scores,
			data.passages.map((p) => p.passageId),
			SPEC_RANKING
		);

		expect(ranked.abstained).toBe(true);
		expect(joinSpecEvidence(data, ranked.ranked).hits).toEqual([]);
	});

	it('質問文が passage をキーのパスで指す', () => {
		const built = buildSemanticRequest(toSemanticCandidates(corpus()), SPEC_POLICY, {});
		const first = built.questions.fit_0 as { instructions: string };
		expect(first.instructions).toContain('`passages.c0.text`');
		expect(first.instructions).not.toContain('passages[');
	});

	it('answerが欠けたら結果全体を通さない', () => {
		const built = buildSemanticRequest(toSemanticCandidates(corpus()), SPEC_POLICY, {});
		expect(() => readSemanticScores({ fit_0: { type: 'noul', noul: 0.9 } }, built.index)).toThrow(
			/fit_1/
		);
	});
});
