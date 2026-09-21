/**
 * CITY の Fit / Gap 実機評価。
 *
 * 既定ではスキップする。実行すると上流を1入力あたり2回呼び、課金が発生する。
 *
 *   LIVE_JEV=1 pnpm vitest run --reporter=verbose src/lib/server/city-fitgap.live.spec.ts
 *
 * 目的は「Semantic Fit の方が優秀」と示すことではない。**どの入力なら
 * Stage 1 だけで足り、どの入力で Stage 2 が効くか**を切り分ける
 * （docs/CITY_SEMANTIC_EXPERIMENT.md §6）。
 *
 * 正解ラベルは架空データセットの条文から人手で付けている。Jevの確率を
 * 正解にしない。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const LIVE = process.env.LIVE_JEV === '1';

// 評価は**本番と同じ入口**を通す。候補の選び方、state、policy、閾値を
// 評価側で組み直すと、片方だけ変わっても気付けない。
// 実際の env を土台にし、実験のフラグだけ上書きする。API キーとタイムアウトは
// 本番と同じ値を evaluate() へ渡す必要がある。
vi.mock('$env/dynamic/private', () => ({
	env: { ...process.env, CITY_SEMANTIC_EXPERIMENT: 'true', CITY_DIRECTORY: 'fictional-m-city' }
}));
// 上流は**本番のラッパー**を通す。直接 TypeSafeClient を叩くと、
// JEV_TIMEOUT_MS、総予算の AbortSignal、retry の中断、SDKエラーの
// マッピング、送信前の criteria 検査がすべて評価の対象外になる。
const { evaluate } = await import('./jev-client.server');
const { runCitySemanticShadow } = await import('./city-semantic.server');
const { buildCatalog, buildState } = await import('./question-catalog.server');
const { normalizeAnswers } = await import('./normalize-response.server');

const id = (suffix: string) => suffix;

/**
 * `section` は Stage 1 に期待する課。`responsibilities` は Stage 2 が
 * 拾ってほしい分掌。どちらも空なら「候補を出さないのが正解」。
 */
type GoldCase = {
	kind: string;
	query: string;
	section: string[];
	responsibilities: string[];
};

const GOLD: GoldCase[] = [
	// 条文の語がそのまま入る
	{
		kind: '直接',
		query: '子どもの定期予防接種について知りたい',
		section: ['child_family_center'],
		responsibilities: [id('child_family_center.u1.r5'), id('child_family_center.u1.r6')]
	},
	{
		kind: '直接',
		query: '住民票の写しがほしい',
		section: ['citizen_services'],
		responsibilities: [id('citizen_services.u1.r3')]
	},
	{
		kind: '直接',
		query: '防犯施設の設置について',
		section: ['crisis_management'],
		responsibilities: [id('crisis_management.u1.r1'), id('crisis_management.u1.r4')]
	},

	// 住民の言葉。条文の語と一致しない
	{
		kind: '言い換え',
		query: '夜道が暗くて不安なので照明をつけてほしい',
		section: ['crisis_management'],
		responsibilities: [id('crisis_management.u1.r1'), id('crisis_management.u1.r4')]
	},
	// 課境界。条文上どちらの課にも根拠があり、正解を1つに決められない。
	// 初回の評価ではラベルを片方に絞っていて外れたが、条文を確認すると
	// もう片方にも根拠があった。モデルの出力に合わせたのではなく、
	// データを読み直してラベルを広げている。
	{
		kind: '課境界',
		// 環境政策課に「飲用井戸等の衛生対策」、企業団に「水道の水質管理」がある。
		query: '井戸水を飲んでいるが水質が心配',
		section: ['environment_policy', 'water_enterprise'],
		responsibilities: [
			id('environment_policy.u1.r24'),
			id('environment_policy.u1.r26'),
			id('water_enterprise.u1.r1')
		]
	},
	{
		kind: '課境界',
		// 管理課に「生活道舗装整備事業」、建設課に「道路の新設改良」がある。
		query: '家の前の道がでこぼこで歩きにくい',
		section: ['construction_management', 'construction_works'],
		responsibilities: [
			id('construction_management.u1.r28'),
			id('construction_management.u1.r2'),
			id('construction_works.u1.r1'),
			id('construction_works.u1.r2')
		]
	},

	// 複数の課にまたがる
	{
		kind: '複数課',
		query: '隣の空き家が荒れていて困っている',
		section: ['construction_management', 'policy_planning'],
		responsibilities: [id('construction_management.u2.r4'), id('policy_planning.u2.r21')]
	},

	// 情報不足。無理に絞り込まないことを見る
	{ kind: '曖昧', query: '相談したいことがあります', section: [], responsibilities: [] },

	// CITY 対象外
	{ kind: '対象外', query: '宇宙旅行の予約をしたい', section: [], responsibilities: [] },
	{ kind: '対象外', query: '株式の売買手数料の相場を知りたい', section: [], responsibilities: [] }
];

/**
 * 採用基準。
 *
 * Stage 1 は既定経路なので、退行を検出する下限として置く。Stage 2 は
 * 「どこで効くか」を見るための実験であり、下限は緩い。
 */
const CRITERIA = {
	/** Stage 1 が期待した課を選ぶ割合（答えのある入力のみ）。 */
	sectionTop1: 0.7,
	/** Stage 2 の上位3件に期待した分掌が入る割合（課が当たった入力のみ）。 */
	responsibilityHitAt3: 0.7,
	/** Stage 1 + Stage 2 の合計 p95。 */
	p95LatencyMs: 4000
} as const;

type Row = {
	kind: string;
	query: string;
	gold: GoldCase;
	selected: string;
	sectionOk: boolean;
	stage2Ran: boolean;
	hits: string[];
	hitAt1: boolean;
	hitAt3: boolean;
	abstained: boolean;
	latencyMs: number;
	inputTokens: number;
};

type Measured = {
	rows: Row[];
	model: string;
	sectionTop1: number;
	responsibilityHitAt1: number;
	responsibilityHitAt3: number;
	p95LatencyMs: number;
};

describe.skipIf(!LIVE)('CITY Fit / Gap 実機評価', () => {
	let measured: Measured;

	beforeAll(
		async () => {
			const catalog = buildCatalog('city');
			const rows: Row[] = [];
			let model = '';

			for (const gold of GOLD) {
				const startedAt = performance.now();

				// Stage 1: 既定経路と同じ質問・同じ state・同じラッパー。
				const { result: stage1 } = await evaluate(
					buildState('city', gold.query),
					catalog.questions
				);
				model = stage1.model;
				let inputTokens = stage1.usage.input_tokens;
				const results = normalizeAnswers(catalog, stage1);
				const routeTo = results.find((card) => card.id === 'route_to');
				const selected = routeTo?.kind === 'choice' ? routeTo.selected : '';

				// Stage 2: 本番の shadow 経路をそのまま使う。
				const metrics = await runCitySemanticShadow(
					{
						requestId: 'eval',
						mode: 'city',
						model,
						latencyMs: 0,
						usage: { inputTokens },
						results
					},
					gold.query,
					16_000,
					async ({ state, questions }) => {
						// 本番と同じく残り予算を渡す。
						const remaining = 16_000 - (performance.now() - startedAt);
						const { result: stage2 } = await evaluate(state, questions, remaining);
						return {
							answers: stage2.answers as Record<string, unknown>,
							inputTokens: stage2.usage.input_tokens,
							outputTokens: stage2.usage.output_tokens
						};
					}
				);
				if (metrics) inputTokens += metrics.inputTokens;

				const hits = metrics?.hits ?? [];
				rows.push({
					kind: gold.kind,
					query: gold.query,
					gold,
					selected,
					sectionOk: gold.section.includes(selected),
					stage2Ran: metrics !== null,
					hits,
					hitAt1: hits.length > 0 && gold.responsibilities.includes(hits[0]),
					hitAt3: hits.slice(0, 3).some((hit) => gold.responsibilities.includes(hit)),
					abstained: metrics?.abstained ?? true,
					latencyMs: Math.round(performance.now() - startedAt),
					inputTokens
				});
			}

			const answerable = rows.filter((row) => row.gold.section.length > 0);
			const scored = answerable.filter((row) => row.sectionOk && row.stage2Ran);
			const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);

			measured = {
				rows,
				model,
				sectionTop1: answerable.filter((row) => row.sectionOk).length / answerable.length,
				responsibilityHitAt1:
					scored.filter((row) => row.hitAt1).length / Math.max(1, scored.length),
				responsibilityHitAt3:
					scored.filter((row) => row.hitAt3).length / Math.max(1, scored.length),
				p95LatencyMs:
					latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]
			};
			report(measured);
		},
		15 * 60 * 1000
	);

	it('Stage 1 が期待した課を選ぶ', () => {
		const missed = measured.rows
			.filter((row) => row.gold.section.length > 0 && !row.sectionOk)
			.map((row) => `${row.query} -> ${row.selected}`);
		expect(measured.sectionTop1, missed.join(' / ')).toBeGreaterThanOrEqual(CRITERIA.sectionTop1);
	});

	it('Stage 2 が期待した分掌を上位3件で拾う', () => {
		const missed = measured.rows
			.filter((row) => row.gold.section.length > 0 && row.sectionOk && row.stage2Ran && !row.hitAt3)
			.map((row) => `${row.query} -> ${row.hits.join(',') || '(abstain)'}`);
		expect(measured.responsibilityHitAt3, missed.join(' / ')).toBeGreaterThanOrEqual(
			CRITERIA.responsibilityHitAt3
		);
	});

	it('対象外の入力で分掌を提示しない', () => {
		// 候補を出さないのが正解の入力。Stage 1 が課を選んでも、Stage 2 が
		// 高い適合度を返してはいけない。
		const shown = measured.rows
			.filter((row) => row.gold.section.length === 0 && row.stage2Ran && !row.abstained)
			.map((row) => `${row.query} -> ${row.hits.join(',')}`);
		expect(shown).toEqual([]);
	});

	it('p95 latency が予算に収まる', () => {
		expect(measured.p95LatencyMs).toBeLessThanOrEqual(CRITERIA.p95LatencyMs);
	});

	it('Stage 2 を走らせた入力で出典を解決できる', () => {
		// 返ってきた分掌IDは、すべて現在のデータセットに存在しなければならない。
		const known = new Set(
			measured.rows.flatMap((row) => row.gold.responsibilities).concat(allResponsibilityIds())
		);
		const unknown = measured.rows.flatMap((row) => row.hits.filter((hit) => !known.has(hit)));
		expect(unknown).toEqual([]);
	});
});

function allResponsibilityIds(): string[] {
	// データセットのIDをそのまま使う。join できない結果を通さない。
	const corpus = JSON.parse(readFileSync('data/city/fictional-m-city.json', 'utf8')) as {
		organizations: { responsibilities: { responsibilityId: string }[] }[];
	};
	return corpus.organizations.flatMap((unit) =>
		unit.responsibilities.map((responsibility) => responsibility.responsibilityId)
	);
}

function report(measured: Measured): void {
	const { rows } = measured;
	console.log(`\nmodel ${measured.model} / gold ${rows.length} 件\n`);
	for (const row of rows) {
		const wantsAnswer = row.gold.section.length > 0;
		const ok = wantsAnswer ? row.sectionOk && row.hitAt3 : row.abstained;
		console.log(
			`${ok ? 'OK  ' : 'MISS'} [${row.kind.padEnd(4)}] ${row.query.slice(0, 22).padEnd(24)} ` +
				`課=${row.selected.padEnd(24)} ${row.sectionOk || !wantsAnswer ? '  ' : 'x '}` +
				`Stage2=${row.stage2Ran ? row.hits.map((h) => h.split('.').slice(-2).join('.')).join(',') || 'abstain' : '(未実行)'} ` +
				`${row.latencyMs}ms`
		);
	}
	console.log(
		`\nStage1 課の一致 ${(measured.sectionTop1 * 100).toFixed(0)}% (基準 ${CRITERIA.sectionTop1 * 100}%)  ` +
			`Stage2 分掌 hit@1 ${(measured.responsibilityHitAt1 * 100).toFixed(0)}% ` +
			`hit@3 ${(measured.responsibilityHitAt3 * 100).toFixed(0)}% (基準 ${CRITERIA.responsibilityHitAt3 * 100}%)`
	);
	console.log(
		`p95 ${measured.p95LatencyMs}ms (基準 ${CRITERIA.p95LatencyMs}ms)  ` +
			`入力token 平均 ${Math.round(rows.reduce((n, r) => n + r.inputTokens, 0) / rows.length)}  ` +
			`推計コスト $${((rows.reduce((n, r) => n + r.inputTokens, 0) / 1_000_000) * 0.042).toFixed(5)}`
	);
}
