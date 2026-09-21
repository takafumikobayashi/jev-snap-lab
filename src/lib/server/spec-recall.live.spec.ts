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

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateCorpus } from './spec-corpus.server';

// 評価は**本番と同じ入口**を通す。候補の作り方、state、policy、閾値、
// 出典joinを評価側で組み直すと、片方だけ変わっても気付けない。
// mode 文字列もJevの判断入力なので、ここがずれると測るものが変わる。
// 実際の env を土台にし、フラグだけ上書きする。API キーとタイムアウトは
// 本番と同じ値を evaluate() へ渡す必要がある。
vi.mock('$env/dynamic/private', () => ({ env: { ...process.env, SPEC_FIND_ENABLED: 'true' } }));
// 上流は**本番のラッパー**を通す。直接 TypeSafeClient を叩くと、
// JEV_TIMEOUT_MS、総予算の AbortSignal、retry の中断、SDKエラーの
// マッピング、送信前の criteria 検査がすべて評価の対象外になる。
const { evaluate } = await import('./jev-client.server');
const { findSpecPassages } = await import('./spec-find.server');

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

/**
 * 採用基準。Phase 10 の採否判断をログの目視に依存させないため、明示して固定する。
 *
 * 実測（2026-09-21、model jev-1.13.0）は Recall@1 93% / Recall@3 100% /
 * abstain 2/2 / latency 最大 984ms だった。基準はそこから余裕を取った下限で、
 * 「measured と同じ」ではない。1〜2件の揺れは通し、本当の退行だけ落とす。
 */
const CRITERIA = {
	/** 上位1件が正解である割合。 */
	recallAt1: 0.8,
	/** 上位3件のどれかが正解である割合。読むべき箇所を探す用途の主指標。 */
	recallAt3: 0.9,
	/**
	 * Stage 2 単体の p95。`JEV_TIMEOUT_MS` が3,500msで、超えるとSDKが
	 * timeout扱いでretryし遅延が倍になる。その内側に収める。
	 */
	p95LatencyMs: 3000,
	/**
	 * リクエスト全体のtoken上限（64k）に対する使用率の上限。
	 * 予算の半分を超えたらコーパスの大きさを見直す。
	 */
	maxRequestTokenRatio: 0.5
} as const;

type Measured = {
	rows: Row[];
	model: string;
	recallAt1: number;
	recallAt3: number;
	p95LatencyMs: number;
	maxInputTokens: number;
};

type Row = {
	kind: string;
	query: string;
	accept: string[];
	at1: boolean;
	at3: boolean;
	abstained: boolean;
	top: string[];
	topProb: number | null;
	unresolved: string[];
	latency: number;
	inputTokens: number;
};

describe.skipIf(!LIVE)('SPEC FIND 実機評価', () => {
	let measured: Measured;

	// 上流は1回だけ回し、基準ごとに別々のitで判定する。どの基準を満たせて
	// いないかがそのまま出るようにする。
	beforeAll(
		async () => {
			const rows: Row[] = [];
			let model = '';

			for (const gold of GOLD) {
				const startedAt = performance.now();
				let inputTokens = 0;
				const spec = await findSpecPassages(gold.query, async ({ state, questions }) => {
					// 本番が組み立てた state をそのまま送る。ここで作り替えない。
					expect(state.mode, 'state の mode が本番と違う').toBe('spec');
					const { result } = await evaluate(state, questions);
					inputTokens += result.usage.input_tokens;
					model = result.model;
					return result.answers as Record<string, unknown>;
				});
				const latency = Math.round(performance.now() - startedAt);
				const top = spec.hits.map((hit) => hit.passageId);

				rows.push({
					kind: gold.kind,
					query: gold.query,
					accept: gold.accept,
					at1: top.length > 0 && gold.accept.includes(top[0]),
					at3: top.some((passageId) => gold.accept.includes(passageId)),
					abstained: spec.abstained,
					top,
					topProb: spec.hits[0]?.fitProbability ?? null,
					unresolved: spec.unresolved,
					latency,
					inputTokens
				});
			}

			const answerable = rows.filter((row) => row.accept.length > 0);
			const latencies = rows.map((row) => row.latency).sort((a, b) => a - b);
			measured = {
				rows,
				model,
				recallAt1: answerable.filter((row) => row.at1).length / answerable.length,
				recallAt3: answerable.filter((row) => row.at3).length / answerable.length,
				// 標本が少ないので p95 は「上から5%を切り捨てた最大値」として扱う。
				p95LatencyMs:
					latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)],
				maxInputTokens: Math.max(...rows.map((row) => row.inputTokens))
			};

			report(measured);
		},
		10 * 60 * 1000
	);

	it('Recall@1 が基準を満たす', () => {
		expect(measured.recallAt1, missesOf(measured, 'at1')).toBeGreaterThanOrEqual(
			CRITERIA.recallAt1
		);
	});

	it('Recall@3 が基準を満たす', () => {
		expect(measured.recallAt3, missesOf(measured, 'at3')).toBeGreaterThanOrEqual(
			CRITERIA.recallAt3
		);
	});

	it('対象外の入力をすべて abstain する', () => {
		// 関係の薄いpassageを回答のように見せないことは安全性の要件であり、
		// 取りこぼしを許さない。
		const offTopic = measured.rows.filter((row) => row.accept.length === 0);
		const shown = offTopic.filter((row) => !row.abstained);
		expect(offTopic.length).toBeGreaterThan(0);
		expect(shown.map((row) => `${row.query} -> ${row.top.join(',')}`)).toEqual([]);
	});

	it('正解を出した入力で abstain していない', () => {
		// 見つかるはずの入力を「見つからない」と言うのも失敗である。
		const missed = measured.rows.filter((row) => row.accept.length > 0 && row.abstained);
		expect(missed.map((row) => row.query)).toEqual([]);
	});

	it('出典をすべて解決できる', () => {
		const broken = measured.rows.filter((row) => row.unresolved.length > 0);
		expect(broken.map((row) => `${row.query} -> ${row.unresolved.join(',')}`)).toEqual([]);
	});

	it('p95 latency が予算に収まる', () => {
		expect(measured.p95LatencyMs).toBeLessThanOrEqual(CRITERIA.p95LatencyMs);
	});

	it('リクエストがtoken予算の半分を超えない', () => {
		// 64k tokens/request の制限に対する使用率。超えたらコーパスを見直す。
		expect(measured.maxInputTokens / 64_000).toBeLessThanOrEqual(CRITERIA.maxRequestTokenRatio);
	});
});

/** 失敗時に、どの入力が外したかをそのまま出す。 */
function missesOf(measured: Measured, at: 'at1' | 'at3'): string {
	const missed = measured.rows.filter((row) => row.accept.length > 0 && !row[at]);
	return missed.map((row) => `${row.query} -> ${row.top.join(',') || '(abstain)'}`).join(' / ');
}

function report(measured: Measured): void {
	const { rows } = measured;
	const offTopic = rows.filter((row) => row.accept.length === 0);
	const tokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);

	console.log(
		`\nmodel ${measured.model} / passage ${corpus.passages.length} 件 / gold ${rows.length} 件\n`
	);
	for (const row of rows) {
		const ok = row.accept.length === 0 ? row.abstained : row.at3;
		console.log(
			`${ok ? 'OK  ' : 'MISS'} [${row.kind.padEnd(4)}] ${row.query.slice(0, 26).padEnd(28)} ` +
				`top=${row.top.map((p) => p.replace('common-feature-2.7.', '')).join(',') || '(abstain)'} ` +
				`p=${row.topProb ?? '-'} ${row.latency}ms`
		);
	}
	console.log(
		`\nRecall@1 ${(measured.recallAt1 * 100).toFixed(0)}% (基準 ${CRITERIA.recallAt1 * 100}%)  ` +
			`Recall@3 ${(measured.recallAt3 * 100).toFixed(0)}% (基準 ${CRITERIA.recallAt3 * 100}%)  ` +
			`対象外のabstain ${offTopic.filter((row) => row.abstained).length}/${offTopic.length}`
	);
	console.log(
		`p95 latency ${measured.p95LatencyMs}ms (基準 ${CRITERIA.p95LatencyMs}ms)  ` +
			`入力token 最大 ${measured.maxInputTokens} 平均 ${Math.round(tokens / rows.length)}  ` +
			`推計コスト $${((tokens / 1_000_000) * 0.042).toFixed(5)}`
	);
}
