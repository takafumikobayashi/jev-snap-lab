/**
 * SPEC FIND の実機評価（gold case）。
 *
 * 既定ではスキップする。実行すると上流を呼び、課金が発生する。
 *
 *   LIVE_JEV=1 node --env-file=.env ./node_modules/.bin/vitest run src/lib/server/spec-recall.live.spec.ts
 *
 * 正解ラベルは公式PDFの本文から人手で付けている。Jevの確率を正解に
 * しない（docs/SPEC_FIND_DESIGN.md §8）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { validateCorpus } from './spec-corpus.server';
import { toSemanticCandidates, joinSpecEvidence } from './spec-evidence.server';
import { evaluateSemanticFit, rankCandidates } from './semantic-match.server';
import { SPEC_POLICY, SPEC_RANKING } from './semantic-policies.server';

const LIVE = process.env.LIVE_JEV === '1';

const corpus = validateCorpus(
	JSON.parse(readFileSync('data/spec/common-feature-2.7.json', 'utf8')),
	{ allowedHosts: ['www.digital.go.jp'] }
);

const id = (suffix: string) => `common-feature-2.7.${suffix}`;

/** `accept` は許容する正解。空なら「該当なし（abstain）が正解」。 */
type GoldCase = { kind: string; query: string; accept: string[] };

const GOLD: GoldCase[] = [
	// 仕様語が入力に含まれる直接一致
	{ kind: '直接', query: 'EUC機能とは何か', accept: [id('s2-5-1'), id('s2-5-2')] },
	{
		kind: '直接',
		query: '団体内統合宛名番号の付番について',
		accept: [id('s2-4-1'), id('s2-4-2'), id('s2-4-3'), id('s2-4-3-2')]
	},
	{ kind: '直接', query: '住登外者宛名番号管理機能の役割', accept: [id('s2-3-1')] },
	{
		kind: '直接',
		query: '統合収納管理機能と統合滞納管理機能の位置づけ',
		accept: [id('s2-6-1'), id('s2-6-2')]
	},

	// 仕様用語を知らない自然文・言い換え
	{
		kind: '言い換え',
		query: 'Excelにデータを出して職員が加工したい',
		accept: [id('s2-5-1'), id('s2-5-2')]
	},
	{
		kind: '言い換え',
		query: 'マイナポータルから来た申請を基幹システムに取り込みたい',
		accept: [id('s2-1-1'), id('s2-1-2'), id('s2-1-4')]
	},
	{
		kind: '言い換え',
		query: '住民票のない人にも番号をつけて管理したい',
		accept: [id('s2-3-1'), id('s2-3-2')]
	},
	{
		kind: '言い換え',
		query: 'システム同士をAPIでつなぎたい',
		accept: [id('s2-2-1'), id('s2-2-2'), id('s2-2-5')]
	},
	{
		kind: '言い換え',
		query: 'APIのアクセストークンの有効期限はどう決まるか',
		accept: [id('s2-2-5'), id('s2-2-5-2')]
	},
	{
		kind: '言い換え',
		query: '税や介護保険の収納をまとめて管理したい',
		accept: [id('s2-6-1'), id('s2-6-2')]
	},

	// 複数の章にまたがる要求
	{
		kind: '複数章',
		query: '独自に作ったシステムから共通機能を使えるか',
		accept: [
			id('s1-5'),
			id('s2-1-6'),
			id('s2-2-4'),
			id('s2-3-4'),
			id('s2-4-5'),
			id('s2-5-4'),
			id('s2-6-4')
		]
	},
	{
		kind: '複数章',
		query: '既存システムからのデータ移行はどう考えるか',
		accept: [id('s2-3-5'), id('s2-4-6')]
	},

	// 章は近いが要件が異なる
	{ kind: '近接', query: '機能要件の一覧はどこに書いてあるか', accept: [id('required-functions')] },
	{ kind: '近接', query: 'この仕様書が対象とする機能の範囲', accept: [id('s1-3'), id('s1-4')] },
	{ kind: '近接', query: '仕様書が改版される流れを知りたい', accept: [id('s3-1')] },

	// 文書外
	{ kind: '対象外', query: '株式の売買手数料の相場を知りたい', accept: [] },
	{ kind: '対象外', query: 'ふるさと納税の返礼品を選びたい', accept: [] }
];

describe.skipIf(!LIVE)('SPEC FIND 実機評価', () => {
	const candidates = toSemanticCandidates(corpus);
	const order = corpus.passages.map((p) => p.passageId);

	it(
		'gold case で Recall と latency を測る',
		async () => {
			// クライアントの生成は it の中で行う。describe.skipIf でも
			// コールバック本体は収集時に評価されるため、外に置くと API キーの
			// 無い環境（CI）でファイル全体が失敗する。
			const client = new TypeSafeClient({
				apiKey: process.env.TYPESAFE_API_KEY,
				defaultModel: process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest',
				timeout: 30_000
			});

			const rows: Record<string, unknown>[] = [];
			let model = '';

			for (const gold of GOLD) {
				const startedAt = performance.now();
				let inputTokens = 0;
				const scores = await evaluateSemanticFit(
					candidates,
					SPEC_POLICY,
					{ mode: 'spec_find', text: gold.query },
					async ({ state, questions }) => {
						const result = await client.systemOne({ state, questions });
						inputTokens += result.usage.input_tokens;
						model = result.model;
						return result.answers as Record<string, unknown>;
					}
				);
				const latency = Math.round(performance.now() - startedAt);
				const ranked = rankCandidates(scores, order, SPEC_RANKING);
				const hits = joinSpecEvidence(corpus, ranked.ranked).hits;
				const top = hits.map((h) => h.passageId);

				const wantAbstain = gold.accept.length === 0;
				const at1 = top.length > 0 && gold.accept.includes(top[0]);
				const at3 = top.some((p) => gold.accept.includes(p));
				const ok = wantAbstain ? ranked.abstained : at3;

				rows.push({
					kind: gold.kind,
					query: gold.query,
					ok,
					at1,
					at3,
					abstained: ranked.abstained,
					top: top.map((p) => p.replace('common-feature-2.7.', '')),
					topProb: hits[0]?.fitProbability ?? null,
					latency,
					inputTokens
				});
			}

			// --- 集計 ---
			const answerable = rows.filter((r) => (r.top as string[]).length >= 0 && r.kind !== '対象外');
			const recall1 = answerable.filter((r) => r.at1).length / answerable.length;
			const recall3 = answerable.filter((r) => r.at3).length / answerable.length;
			const offTopic = rows.filter((r) => r.kind === '対象外');
			const latencies = rows.map((r) => r.latency as number).sort((a, b) => a - b);
			const tokens = rows.reduce((n, r) => n + (r.inputTokens as number), 0);

			console.log(
				`\nmodel ${model} / passage ${corpus.passages.length} 件 / gold ${GOLD.length} 件\n`
			);
			for (const r of rows) {
				console.log(
					`${r.ok ? 'OK  ' : 'MISS'} [${String(r.kind).padEnd(4)}] ${String(r.query).slice(0, 26).padEnd(28)} top=${(r.top as string[]).join(',') || '(abstain)'} p=${r.topProb ?? '-'} ${r.latency}ms`
				);
			}
			console.log(
				`\nRecall@1 ${(recall1 * 100).toFixed(0)}%  Recall@3 ${(recall3 * 100).toFixed(0)}%  ` +
					`対象外のabstain ${offTopic.filter((r) => r.abstained).length}/${offTopic.length}`
			);
			console.log(
				`latency 中央値 ${latencies[Math.floor(latencies.length / 2)]}ms 最大 ${latencies[latencies.length - 1]}ms  ` +
					`入力token 合計 ${tokens} 平均 ${Math.round(tokens / rows.length)}  ` +
					`推計コスト $${((tokens / 1_000_000) * 0.042).toFixed(5)}`
			);

			expect(rows).toHaveLength(GOLD.length);
		},
		10 * 60 * 1000
	);
});
