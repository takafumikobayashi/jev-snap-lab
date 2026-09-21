/**
 * BATCH JUDGE の benchmark（Phase 12）。
 *
 * 既定ではスキップする。実行すると上流を呼び、課金が発生する。
 *
 *   LIVE_JEV=1 node --env-file=.env ./node_modules/.bin/vitest run \
 *     src/lib/server/batch-judge.live.spec.ts
 *
 * SPEC FIND の実機評価と違い、**本番の入口を通さない。** BATCH JUDGE は
 * まだ実装が無く、方式を決めるために測るのがこのフェーズだからである
 * （docs/IMPLEMENTATION_PLAN.md Phase 12）。上流のラッパー `evaluate()` は
 * 通す。timeout、AbortSignal、retry、SDKエラーの写像、送信前の criteria
 * 検査を benchmark の対象外にしないためである。
 *
 * goldは人手のラベル（data/batch/*.json）。Jevの出力をgoldにしない。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { choice, noul, type Questions } from '@typesafe-ai/sdk';
import { DX_DIMENSIONS, type BatchDataset, type DxDimension } from '$lib/types/batch';
import { validateDataset } from './batch-dataset.server';
import type { JsonValue } from '$lib/types/semantic';

// timeout は benchmark 用に広げる。250問が**成立するか**を先に見たいので、
// 本番の予算で先に切ってしまうと「落ちた理由」が分からなくなる。本番へ
// 出せるかどうかは、測った latency を §判定基準の上限と比べて決める。
vi.mock('$env/dynamic/private', () => ({
	env: { ...process.env, JEV_TIMEOUT_MS: '120000', JEV_TOTAL_TIMEOUT_MS: '120000' }
}));
const { evaluate } = await import('./jev-client.server');

const LIVE = process.env.LIVE_JEV === '1';

// ---------------------------------------------------------------------------
// 判定基準（**測る前に決める**。docs/IMPLEMENTATION_PLAN.md Phase 12）
// ---------------------------------------------------------------------------

/**
 * 本番へ出せる上限。`/api/judge` の REQUEST_BUDGET_MS と同じ値。
 * これを超える構成は、実装しても Vercel の maxDuration に収まらない。
 */
const MAX_ACCEPTABLE_MS = 16_000;

/**
 * 混線とみなす確率の差。
 *
 * 事例の並び順だけを変えて同じ質問を投げ、同じ事例の確率がこれ以上動いたら
 * 参照が効いていない。SPEC FIND ではキー参照で2位との差が0.77まで開いた
 * のに対し、配列indexでは0.00〜0.01だった。0.10は「順位が入れ替わらない」
 * ことを保証する側に寄せた値である。
 */
const MAX_BLEED_DELTA = 0.1;

/** 1リクエストの質問数の上限（実測済み）。Pattern B の chunk 幅に使う。 */
const MEASURED_QUESTION_LIMIT = 40;

/** latency のばらつきを見るための試行回数。p95 を出すには足りない。 */
const REPEATS = 3;

// ---------------------------------------------------------------------------
// データセット
// ---------------------------------------------------------------------------

function load(theme: 'privacy' | 'deadline' | 'dx'): BatchDataset {
	return validateDataset(JSON.parse(readFileSync(`data/batch/${theme}.json`, 'utf8')) as unknown);
}

// ---------------------------------------------------------------------------
// 質問の組み立て
// ---------------------------------------------------------------------------

/** 事例1件あたり1問を作る軸。`path` は `cases.privacy_001` のようなキー参照。 */
type Axis = { key: string; build: (path: string) => Questions[string] };

/**
 * PRIVACY の軸。
 *
 * 判断の対象は**入力文そのもの**である。「〜をまとめたい」という作業の
 * 説明ではなく、これから貼り付けようとしている文章を仕分ける。fixture も
 * その形にしてある（data/batch/privacy.json）。
 */
const PRIVACY_AXES: Axis[] = [
	{
		key: 'identifies',
		build: (path) =>
			noul(`Does \`${path}.text\` single out one particular private individual?`, {
				true: 'One particular person can be pinned down from it — by name, address, phone number, email address, an identification number, an internal staff or case number, a role held by one person, or a combination of attributes narrow enough to isolate one person.',
				false:
					'No particular private individual can be pinned down. Aggregate figures, organisations and companies, places without a household, and public figures acting in their official capacity do not count.'
			})
	},
	{
		key: 'personal',
		build: (path) =>
			noul(`Does \`${path}.text\` describe a particular person's own situation?`, {
				true: "It states something about an individual's circumstances, household, family, conduct, finances, or dealings with the authority.",
				false:
					'It concerns procedures, rules, schedules, statistics, facilities, or organisations rather than any individual.'
			})
	},
	{
		key: 'sensitive',
		build: (path) =>
			noul(`Does \`${path}.text\` touch information that would harm someone if mishandled?`, {
				true: 'It touches health, disability, medical treatment, welfare or benefit receipt, poverty or debt, criminal or abuse matters, domestic violence, beliefs, social status, or a child at risk.',
				false:
					'Ordinary administrative content, where disclosure would not expose anyone to harm or prejudice.'
			})
	}
];

const DEADLINE_CRITERIA = {
	now: 'The text asks for action right away, or says a deadline has already passed.',
	today: 'The text points at the end of the working day, tonight, or first thing tomorrow morning.',
	soon: 'The text points at this week, next week, or the end of this month.',
	later: 'The text points beyond this month: next month, this quarter, the fiscal year, or later.',
	none: 'The text expresses no time pressure at all.'
};

const DEADLINE_CHOICE: Axis = {
	key: 'class',
	build: (path) =>
		choice(
			`How soon does \`${path}.text\` ask for a response? Judge the urgency the wording conveys, not a calendar date.`,
			DEADLINE_CRITERIA
		)
};

/** Pattern C（別構造）用。1つのChoiceを5つの独立したNoulへ展開する。 */
const DEADLINE_AXES: Axis[] = Object.entries(DEADLINE_CRITERIA).map(([key, description]) => ({
	key,
	build: (path) =>
		noul(`Does \`${path}.text\` ask for a response on this timescale?`, {
			true: description,
			false: 'The wording points at a different timescale, or at none.'
		})
}));

const DX_CRITERIA: Record<DxDimension, { true: string; false: string }> = {
	bpr_first: {
		true: 'The work itself should be questioned first: the form, the rule, the approval chain, or whether the step is needed at all.',
		false: 'The shape of the work is fine; only how it is carried out is at issue.'
	},
	automation: {
		true: 'A deterministic rule could do it: copying, aggregating, sending on a schedule, or matching by an exact key.',
		false: 'No fixed rule would cover it.'
	},
	ai_candidate: {
		true: 'It needs reading meaning from language: sorting by intent, classifying, drafting, or summarising.',
		false: 'It needs no reading of meaning.'
	},
	system_change: {
		true: 'It cannot be solved without changing or introducing a system, a database, or shared infrastructure.',
		false: 'It can be addressed without touching a system.'
	},
	human_review: {
		true: 'A person must stay in the loop: the judgement affects someone, or knowledge sits with one person and has to be made shared.',
		false: 'It can run without a person checking each case.'
	}
};

const DX_AXES: Axis[] = DX_DIMENSIONS.map((dimension) => ({
	key: dimension,
	build: (path) =>
		noul(
			`For the problem described in \`${path}.text\`, is this a direction worth taking up?`,
			DX_CRITERIA[dimension]
		)
}));

/** Pattern C（別構造）用。5つのNoulを1つのChoiceへ畳む。 */
const DX_CHOICE: Axis = {
	key: 'primary',
	build: (path) =>
		choice(
			`For the problem described in \`${path}.text\`, which direction should be taken up first?`,
			Object.fromEntries(
				DX_DIMENSIONS.map((dimension) => [dimension, DX_CRITERIA[dimension].true])
			) as Record<string, string>
		)
};

type Built = { state: Record<string, JsonValue>; questions: Questions; questionCount: number };

/**
 * 1リクエストを組み立てる。
 *
 * 事例は**オブジェクトのキー**で置き、キーは fixture のIDをそのまま使う。
 * 配列インデックス参照は候補が20件を超えると確率が隣へ滲む（§4.3）。
 * 並び順を変えてもキーは動かないため、混線の検査はこの形のままできる。
 */
function build(dataset: BatchDataset, cases: BatchDataset['cases'], axes: Axis[]): Built {
	const bag: Record<string, { text: string }> = {};
	const questions: Questions = {};
	for (const item of cases) {
		bag[item.id] = { text: item.text };
		for (const axis of axes) {
			questions[`${item.id}__${axis.key}`] = axis.build(`cases.${item.id}`);
		}
	}
	return {
		state: { mode: 'batch', theme: dataset.theme, cases: bag },
		questions,
		questionCount: Object.keys(questions).length
	};
}

// ---------------------------------------------------------------------------
// 実行と計測
// ---------------------------------------------------------------------------

type Answer = { type: string; noul?: number; choice?: string; confidence?: number };
type RunResult = {
	answers: Record<string, Answer>;
	latencyMs: number[];
	inputTokens: number;
	outputTokens: number;
	model: string;
	pricePerMillion: number;
	requests: number;
	missing: string[];
};

async function run(requests: Built[]): Promise<RunResult> {
	const answers: Record<string, Answer> = {};
	const latencyMs: number[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let model = '';
	let pricePerMillion = 0;

	for (const request of requests) {
		const { result, latencyMs: ms, config } = await evaluate(request.state, request.questions);
		latencyMs.push(ms);
		inputTokens += result.usage.input_tokens;
		outputTokens += result.usage.output_tokens;
		model = result.model;
		pricePerMillion = config.inputPricePerMillionTokens;
		Object.assign(answers, result.answers as Record<string, Answer>);
	}

	const asked = requests.flatMap((request) => Object.keys(request.questions));
	return {
		answers,
		latencyMs,
		inputTokens,
		outputTokens,
		model,
		pricePerMillion,
		requests: requests.length,
		// 200 が返ることは、全部の質問に答えた証明にならない。
		missing: asked.filter((id) => answers[id] === undefined)
	};
}

/** Pattern B。1リクエストの質問数が実測上限を超えないよう事例を切る。 */
function chunked(dataset: BatchDataset, axes: Axis[]): Built[] {
	const perChunk = Math.max(1, Math.floor(MEASURED_QUESTION_LIMIT / axes.length));
	const chunks: Built[] = [];
	for (let at = 0; at < dataset.cases.length; at += perChunk) {
		chunks.push(build(dataset, dataset.cases.slice(at, at + perChunk), axes));
	}
	return chunks;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const report: string[] = [];
function record(label: string, built: Built[], result: RunResult, agreement: string): void {
	const total = result.latencyMs.reduce((sum, ms) => sum + ms, 0);
	report.push(
		[
			label.padEnd(26),
			`req=${String(result.requests).padStart(2)}`,
			`q=${String(built.reduce((sum, b) => sum + b.questionCount, 0)).padStart(3)}`,
			`total=${String(Math.round(total)).padStart(6)}ms`,
			`max1=${String(Math.round(Math.max(...result.latencyMs))).padStart(6)}ms`,
			`med1=${String(Math.round(median(result.latencyMs))).padStart(6)}ms`,
			`in=${String(result.inputTokens).padStart(6)}`,
			`out=${String(result.outputTokens).padStart(5)}`,
			`usd=${((result.inputTokens / 1_000_000) * result.pricePerMillion).toFixed(6)}`,
			`missing=${result.missing.length}`,
			agreement
		].join('  ')
	);
}

// ---------------------------------------------------------------------------
// 一致率（人手gold）
// ---------------------------------------------------------------------------

/**
 * PRIVACY の判定ルール。
 *
 * **3軸の最大値では過検知する。** `sensitive` が話題の語に反応するためで、
 * 「生活保護受給世帯の一覧をExcelから抽出しました」は誰も特定できないのに
 * sensitive=0.96 になる。個人が出てこない文を要確認にしても、利用者は
 * 警告を無視するようになるだけである。
 *
 * 実測（§4.6）では `identifies` か `personal` のどちらかが閾値以上、という
 * 規則が最も良かった。見逃し0のまま、過検知が4件から2件に減る。
 */
function privacyVerdict(answers: Record<string, Answer>, id: string, threshold: number): string {
	const at = (key: string) => answers[`${id}__${key}`]?.noul ?? 0;
	return at('identifies') >= threshold || at('personal') >= threshold ? 'review' : 'safe';
}

function privacyAgreement(dataset: BatchDataset, answers: Record<string, Answer>): string {
	const sweep = [0.3, 0.5, 0.7].map((threshold) => {
		const hits = dataset.cases.filter(
			(item) => privacyVerdict(answers, item.id, threshold) === item.gold
		).length;
		return `${threshold}:${((hits / dataset.cases.length) * 100).toFixed(0)}%`;
	});

	// 一致率は非対称である。**見逃しと過検知を分けて数える。** 個人情報を
	// 見落とすのと、安全な文を要確認にするのとでは重さが違う。
	const missed = dataset.cases.filter(
		(item) => item.gold === 'review' && privacyVerdict(answers, item.id, 0.5) === 'safe'
	);
	const over = dataset.cases.filter(
		(item) => item.gold === 'safe' && privacyVerdict(answers, item.id, 0.5) === 'review'
	);
	const oldRule = dataset.cases.filter((item) => {
		const top = Math.max(
			...PRIVACY_AXES.map((axis) => answers[`${item.id}__${axis.key}`]?.noul ?? 0)
		);
		return (top >= 0.5 ? 'review' : 'safe') === item.gold;
	}).length;

	// どちら向きに外したかが分からないと、ラベルを直すのか質問文を直すのか
	// 決められない。外した中身をそのまま出す。
	for (const [label, items] of [
		['見逃し', missed],
		['過検知', over]
	] as const) {
		report.push(
			...items.map((item) => {
				const axes = PRIVACY_AXES.map((axis) =>
					(answers[`${item.id}__${axis.key}`]?.noul ?? 0).toFixed(2)
				).join('/');
				return `    ${label} ${item.id} ${axes} ${item.difficulty} ${item.text}`;
			})
		);
	}
	if (process.env.BATCH_DUMP === '1') {
		// ラベルや判定ルールを変えたときの影響を、測り直さずに評価するための生値。
		report.push(
			...dataset.cases.map((item) => {
				const axes = PRIVACY_AXES.map((axis) =>
					(answers[`${item.id}__${axis.key}`]?.noul ?? 0).toFixed(2)
				).join('/');
				return `  DUMP ${item.id} ${item.gold as string} ${axes} ${item.text}`;
			})
		);
	}
	return `agree(${sweep.join(' ')}) 見逃し=${missed.length} 過検知=${over.length} max3軸なら=${
		oldRule * 2
	}%`;
}

function deadlineChoiceAgreement(dataset: BatchDataset, answers: Record<string, Answer>): string {
	const hits = dataset.cases.filter(
		(item) => answers[`${item.id}__class`]?.choice === item.gold
	).length;
	return `agree=${((hits / dataset.cases.length) * 100).toFixed(0)}%`;
}

function deadlineNoulAgreement(dataset: BatchDataset, answers: Record<string, Answer>): string {
	const hits = dataset.cases.filter((item) => {
		const best = DEADLINE_AXES.map((axis) => ({
			key: axis.key,
			value: answers[`${item.id}__${axis.key}`]?.noul ?? 0
		})).sort((a, b) => b.value - a.value)[0];
		return best?.key === item.gold;
	}).length;
	return `agree=${((hits / dataset.cases.length) * 100).toFixed(0)}%`;
}

/**
 * DX: 軸ごとに独立して数える。単一のaccuracyへ潰さない。
 *
 * 閾値は**測る前に決められない。** 0.5を正解の定義にすると、Noulの分布が
 * どこにあっても「その閾値での一致率」しか見えない。掃引して報告する。
 */
function dxAgreement(dataset: BatchDataset, answers: Record<string, Answer>): string {
	const sweep = [0.3, 0.5, 0.7].map((threshold) => {
		const hits = dataset.cases.flatMap((item) =>
			DX_DIMENSIONS.map(
				(dimension) =>
					(answers[`${item.id}__${dimension}`]?.noul ?? 0) >= threshold ===
					(item.gold as Record<DxDimension, boolean>)[dimension]
			)
		);
		return `${threshold}:${((hits.filter(Boolean).length / hits.length) * 100).toFixed(0)}%`;
	});
	const perAxis = DX_DIMENSIONS.map((dimension) => {
		const hits = dataset.cases.filter((item) => {
			const gold = (item.gold as Record<DxDimension, boolean>)[dimension];
			return (answers[`${item.id}__${dimension}`]?.noul ?? 0) >= 0.5 === gold;
		}).length;
		return `${dimension.slice(0, 4)}:${((hits / dataset.cases.length) * 100).toFixed(0)}%`;
	});
	return `agree(${sweep.join(' ')} | @0.5 ${perAxis.join(' ')})`;
}

function dxChoiceAgreement(dataset: BatchDataset, answers: Record<string, Answer>): string {
	// 畳んだChoiceは「選んだ軸がgoldで真か」しか見られない。軸ごとの
	// false positive / negative は測れなくなる。これが Pattern C の代償である。
	const hits = dataset.cases.filter((item) => {
		const picked = answers[`${item.id}__primary`]?.choice as DxDimension | undefined;
		return picked !== undefined && (item.gold as Record<DxDimension, boolean>)[picked] === true;
	}).length;
	return `picked-is-true=${((hits / dataset.cases.length) * 100).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------

describe.runIf(LIVE)('BATCH JUDGE benchmark', () => {
	const privacy = load('privacy');
	const deadline = load('deadline');
	const dx = load('dx');

	it('Pattern A: 50件 × 各軸を1リクエストで送る', { timeout: 600_000 }, async () => {
		for (const [dataset, axes, agree] of [
			[privacy, PRIVACY_AXES, privacyAgreement],
			[deadline, [DEADLINE_CHOICE], deadlineChoiceAgreement],
			[dx, DX_AXES, dxAgreement]
		] as const) {
			const built = build(dataset, dataset.cases, axes as Axis[]);
			const runs: RunResult[] = [];
			for (let at = 0; at < REPEATS; at += 1) runs.push(await run([built]));
			const merged: RunResult = {
				...runs[0],
				latencyMs: runs.flatMap((r) => r.latencyMs),
				requests: REPEATS,
				inputTokens: runs.reduce((s, r) => s + r.inputTokens, 0),
				outputTokens: runs.reduce((s, r) => s + r.outputTokens, 0),
				missing: runs.flatMap((r) => r.missing)
			};
			record(
				`A ${dataset.theme} 50x${(axes as Axis[]).length}`,
				[built],
				merged,
				agree(dataset, runs[0].answers)
			);
			expect(merged.missing, `${dataset.theme} で欠けた answer`).toEqual([]);
		}
	});

	it('Pattern B: 質問数が実測上限に収まるようchunkする', { timeout: 600_000 }, async () => {
		for (const [dataset, axes, agree] of [
			[privacy, PRIVACY_AXES, privacyAgreement],
			[deadline, [DEADLINE_CHOICE], deadlineChoiceAgreement],
			[dx, DX_AXES, dxAgreement]
		] as const) {
			const built = chunked(dataset, axes as Axis[]);
			const result = await run(built);
			record(`B ${dataset.theme} chunk`, built, result, agree(dataset, result.answers));
			expect(result.missing, `${dataset.theme} で欠けた answer`).toEqual([]);
		}
	});

	it('Pattern C: 軸の構造を変える（Choice⇄Noul）', { timeout: 600_000 }, async () => {
		// deadline: 1 Choice -> 5 Noul（50問 -> 250問）
		const deadlineBuilt = build(deadline, deadline.cases, DEADLINE_AXES);
		const deadlineRun = await run([deadlineBuilt]);
		record(
			'C deadline 50x5 noul',
			[deadlineBuilt],
			deadlineRun,
			deadlineNoulAgreement(deadline, deadlineRun.answers)
		);

		// dx: 5 Noul -> 1 Choice（250問 -> 50問）
		const dxBuilt = build(dx, dx.cases, [DX_CHOICE]);
		const dxRun = await run([dxBuilt]);
		record('C dx 50x1 choice', [dxBuilt], dxRun, dxChoiceAgreement(dx, dxRun.answers));

		expect([...deadlineRun.missing, ...dxRun.missing]).toEqual([]);
	});

	it('probabilityの混線: 並び順だけを変えて分布が動くか見る', { timeout: 600_000 }, async () => {
		// コーパスも質問も同じで、事例の並びだけを逆にする。キー参照が
		// 効いていれば、同じ事例の確率はほぼ動かないはずである。
		// 200 が返ることは参照が効いた証明にならない（§4.4）。
		//
		// **同じ並びで2回投げた差を先に測る。** これが無いと、逆順との差が
		// 位置のせいなのか、上流のゆらぎなのか区別できない。
		const forward = build(dx, dx.cases, DX_AXES);
		const reversed = build(dx, [...dx.cases].reverse(), DX_AXES);

		const first = await run([forward]);
		const control = await run([forward]);
		const second = await run([reversed]);

		const compare = (a: RunResult, b: RunResult) =>
			dx.cases.flatMap((item) =>
				DX_DIMENSIONS.map((dimension) => {
					const id = `${item.id}__${dimension}`;
					const left = a.answers[id]?.noul ?? 0;
					const right = b.answers[id]?.noul ?? 0;
					// 閾値をまたぐ差だけが判定を変える。差の大きさとは別に数える。
					return { id, delta: Math.abs(left - right), flipped: left >= 0.5 !== right >= 0.5 };
				})
			);

		const describeDeltas = (label: string, rows: ReturnType<typeof compare>) => {
			const worst = [...rows].sort((a, b) => b.delta - a.delta).slice(0, 3);
			report.push(
				[
					label.padEnd(26),
					`max=${worst[0].delta.toFixed(3)}`,
					`mean=${(rows.reduce((sum, row) => sum + row.delta, 0) / rows.length).toFixed(3)}`,
					`over${MAX_BLEED_DELTA}=${rows.filter((row) => row.delta > MAX_BLEED_DELTA).length}/${rows.length}`,
					`flip@0.5=${rows.filter((row) => row.flipped).length}`,
					`worst: ${worst.map((row) => `${row.id} ${row.delta.toFixed(3)}`).join(', ')}`
				].join('  ')
			);
			return rows;
		};

		const jitter = describeDeltas('bleed dx 同じ並びで2回', compare(first, control));
		const shifted = describeDeltas('bleed dx 逆順', compare(first, second));

		// 位置を変えた差が、同じ並びのゆらぎを超えているか。超えていなければ
		// 「混線」ではなく上流のゆらぎである。
		const mean = (rows: typeof jitter) =>
			rows.reduce((sum, row) => sum + row.delta, 0) / rows.length;
		report.push(
			`  逆順の平均差 / 同じ並びの平均差 = ${(mean(shifted) / Math.max(mean(jitter), 1e-9)).toFixed(2)}`
		);

		expect(first.missing).toEqual([]);
		expect(second.missing).toEqual([]);
		expect(control.missing).toEqual([]);
	});

	it('成立する最大の「件数 × 軸数」を探る', { timeout: 600_000 }, async () => {
		// 50×5=250 は上で成立している。**どこで壊れるかは別に測る。**
		// 成立した一点だけを見て上限を決めると、本番が端に立つ。
		// 精度は見ない。answerが全部返るかどうかだけを見る容量の試験なので、
		// 事例は fixture を複製して作る（IDは別にする）。
		for (const cases of [100, 150, 200]) {
			const inflated: BatchDataset = {
				...dx,
				cases: Array.from({ length: cases }, (_, at) => ({
					...dx.cases[at % dx.cases.length],
					id: `dx_probe_${String(at).padStart(3, '0')}`
				}))
			};
			const built = build(inflated, inflated.cases, DX_AXES);
			try {
				const result = await run([built]);
				record(
					`probe dx ${cases}x5`,
					[built],
					result,
					result.missing.length === 0 ? 'complete' : `MISSING ${result.missing.length}`
				);
				if (result.missing.length > 0) break;
			} catch (error) {
				report.push(
					`probe dx ${cases}x5  q=${built.questionCount}  失敗: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
				break;
			}
		}
		expect(report.some((line) => line.startsWith('probe'))).toBe(true);
	});

	it('計測結果を出す', () => {
		console.log(['', '=== BATCH JUDGE benchmark ===', ...report, ''].join('\n'));
		console.log(
			`判定基準: 1リクエスト ${MAX_ACCEPTABLE_MS}ms 以内 / answer欠落0 / 並び替えの差 ${MAX_BLEED_DELTA} 以内`
		);
		// 前の4本が計測を record している。空なら計測せずに通ってしまう。
		expect(report.length).toBeGreaterThan(0);
	});
});
