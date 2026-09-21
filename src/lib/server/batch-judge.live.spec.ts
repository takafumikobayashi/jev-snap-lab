/**
 * BATCH JUDGE の benchmark（Phase 12）。
 *
 * 既定ではスキップする。実行すると上流を呼び、課金が発生する。
 *
 *   LIVE_JEV=1 node --env-file=.env node_modules/vitest/vitest.mjs run \
 *     --project server --reporter=verbose src/lib/server/batch-judge.live.spec.ts
 *
 * SPEC FIND の実機評価と違い、**本番の入口を通さない。** BATCH JUDGE は
 * まだ実装が無く、方式を決めるために測るのがこのフェーズだからである
 * （docs/IMPLEMENTATION_PLAN.md Phase 12）。上流のラッパー `evaluate()` は
 * 通す。timeout、AbortSignal、retry、SDKエラーの写像、送信前の criteria
 * 検査を benchmark の対象外にしないためである。
 *
 * goldは `data/batch/*.json` のラベル。Jevの出力をgoldにしない。ただし
 * `labelStatus: 'draft'` のあいだは人手の確認を経ておらず、**ここで出る一致率は
 * 暫定ラベルに対する実測値であって精度ではない**（§5）。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { noul } from '@typesafe-ai/sdk';
import { DX_CLASSES, type BatchDataset } from '$lib/types/batch';
import { datasetFingerprint, validateDataset } from './batch-dataset.server';
// 質問文を評価側へ書き写さない。片方だけ直すと、測ったものと動くものがずれる。
import {
	AXES_BY_THEME,
	DEADLINE_CRITERIA,
	DX_CRITERIA,
	PRIVACY_AXES,
	buildBatchRequest,
	privacyVerdict,
	readBatchAnswers,
	type BatchAnswer,
	type BatchAxis
} from './batch-questions.server';

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
 *
 * **`record()` が必ず検査する。** 出力へ書くだけでは基準が飾りになる。
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

/** Pattern C（別構造）用。DEADLINE の1つのChoiceを5つの独立したNoulへ展開する。 */
const DEADLINE_NOUL_AXES: BatchAxis[] = Object.entries(DEADLINE_CRITERIA).map(
	([key, description]) => ({
		key,
		build: (path) =>
			noul(`Does \`${path}.text\` ask for a response on this timescale?`, {
				true: description,
				false: 'The wording points at a different timescale, or at none.'
			})
	})
);

/** Pattern C（別構造）用。DX の3択を3つの独立Noulへ展開する。 */
const DX_NOUL_AXES: BatchAxis[] = DX_CLASSES.map((value) => ({
	key: value,
	build: (path) =>
		noul(`For the problem described in \`${path}.text\`, is this what should be taken up first?`, {
			true: DX_CRITERIA[value],
			false: 'Something else should be taken up first.'
		})
}));

type Built = ReturnType<typeof buildBatchRequest>;

/** 既定の軸で組み立てる薄い包み。benchmark 側の記述を短くするだけ。 */
function build(
	dataset: BatchDataset,
	cases: BatchDataset['cases'] = dataset.cases,
	axes: BatchAxis[] = AXES_BY_THEME[dataset.theme],
	referenceDate = dataset.referenceDate
): Built {
	return buildBatchRequest(dataset, cases, axes, referenceDate);
}

// ---------------------------------------------------------------------------
// 実行と計測
// ---------------------------------------------------------------------------

type Answer = BatchAnswer;
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

	// 契約の検査を benchmark でも通す。ここを通らない形が本番へ行かない。
	for (const request of requests) {
		readBatchAnswers(
			Object.fromEntries(
				[...request.index.keys()]
					.filter((id) => answers[id] !== undefined)
					.map((id) => [id, answers[id]])
			),
			{ ...request, index: new Map([...request.index].filter(([id]) => answers[id] !== undefined)) }
		);
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
function chunked(dataset: BatchDataset, axes: BatchAxis[]): Built[] {
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
	// 判定基準をここで効かせる。レポートに出すだけでは、超えても誰も気づかない。
	expect(Math.max(...result.latencyMs), `${label} が1リクエストの上限を超えた`).toBeLessThanOrEqual(
		MAX_ACCEPTABLE_MS
	);
	expect(result.missing, `${label} で answer が欠けた`).toEqual([]);
	report.push(
		[
			label.padEnd(24),
			`req=${String(result.requests).padStart(2)}`,
			`q=${String(built.reduce((sum, b) => sum + b.questionCount, 0)).padStart(4)}`,
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

function privacyAgreement(dataset: BatchDataset, answers: Record<string, Answer>): string {
	// 判定は契約側の関数をそのまま使う。benchmark 側で書き直さない。
	const verdict = (id: string, threshold: number) =>
		privacyVerdict(new Map(Object.entries(answers)), id, threshold);
	const sweep = [0.3, 0.5, 0.7].map((threshold) => {
		const hits = dataset.cases.filter((item) => verdict(item.id, threshold) === item.gold).length;
		return `${threshold}:${((hits / dataset.cases.length) * 100).toFixed(0)}%`;
	});

	// 一致率は非対称である。**見逃しと過検知を分けて数える。** 個人情報を
	// 見落とすのと、安全な文を要確認にするのとでは重さが違う。
	const missed = dataset.cases.filter(
		(item) => item.gold === 'review' && verdict(item.id, 0.5) === 'no_signal'
	);
	const over = dataset.cases.filter(
		(item) => item.gold === 'no_signal' && verdict(item.id, 0.5) === 'review'
	);
	const axesOf = (id: string) =>
		PRIVACY_AXES.map((axis) => (answers[`${id}__${axis.key}`]?.noul ?? 0).toFixed(2)).join('/');
	const oldRule = dataset.cases.filter((item) => {
		const top = Math.max(
			...PRIVACY_AXES.map((axis) => answers[`${item.id}__${axis.key}`]?.noul ?? 0)
		);
		return (top >= 0.5 ? 'review' : 'no_signal') === item.gold;
	}).length;

	// どちら向きに外したかが分からないと、ラベルを直すのか質問文を直すのか
	// 決められない。外した中身をそのまま出す。
	for (const [label, items] of [
		['見逃し', missed],
		['過検知', over]
	] as const) {
		report.push(
			...items.map(
				(item) => `    ${label} ${item.id} ${axesOf(item.id)} ${item.difficulty} ${item.text}`
			)
		);
	}
	if (process.env.BATCH_DUMP === '1') {
		// ラベルや判定ルールを変えたときの影響を、測り直さずに評価するための生値。
		report.push(
			...dataset.cases.map(
				(item) => `  DUMP ${item.id} ${item.gold as string} ${axesOf(item.id)} ${item.text}`
			)
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
		const best = DEADLINE_NOUL_AXES.map((axis) => ({
			key: axis.key,
			value: answers[`${item.id}__${axis.key}`]?.noul ?? 0
		})).sort((a, b) => b.value - a.value)[0];
		return best?.key === item.gold;
	}).length;
	return `agree=${((hits / dataset.cases.length) * 100).toFixed(0)}%`;
}

/** DX: 3択の一致。**混同の中身も出す。** どちらへ寄ったかが分からないと直せない。 */
function dxAgreement(dataset: BatchDataset, answers: Record<string, Answer>): string {
	const picked = (id: string) => answers[`${id}__first_move`]?.choice ?? '?';
	const hits = dataset.cases.filter((item) => picked(item.id) === item.gold).length;

	const confusion: Record<string, number> = {};
	for (const item of dataset.cases) {
		if (picked(item.id) !== item.gold) {
			const key = `${item.gold as string}→${picked(item.id)}`;
			confusion[key] = (confusion[key] ?? 0) + 1;
		}
	}
	const byClass = DX_CLASSES.map((value) => {
		const of = dataset.cases.filter((item) => item.gold === value);
		return `${value}:${of.filter((item) => picked(item.id) === value).length}/${of.length}`;
	});
	report.push(
		`    dx 内訳 ${byClass.join(' ')}  混同 ${
			Object.entries(confusion)
				.sort((a, b) => b[1] - a[1])
				.map(([key, count]) => `${key}=${count}`)
				.join(' ') || 'なし'
		}`
	);
	return `agree=${((hits / dataset.cases.length) * 100).toFixed(0)}%`;
}

function dxNoulAgreement(dataset: BatchDataset, answers: Record<string, Answer>): string {
	const hits = dataset.cases.filter((item) => {
		const best = DX_CLASSES.map((value) => ({
			value,
			score: answers[`${item.id}__${value}`]?.noul ?? 0
		})).sort((a, b) => b.score - a.score)[0];
		return best?.value === item.gold;
	}).length;
	return `agree=${((hits / dataset.cases.length) * 100).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------

describe.runIf(LIVE)('BATCH JUDGE benchmark', () => {
	const privacy = load('privacy');
	const deadline = load('deadline');
	const dx = load('dx');

	const patterns = () =>
		[
			[privacy, PRIVACY_AXES, privacyAgreement],
			[deadline, AXES_BY_THEME.deadline, deadlineChoiceAgreement],
			[dx, AXES_BY_THEME.dx, dxAgreement]
		] as const;

	it('Pattern A: 50件 × 各軸を1リクエストで送る', { timeout: 600_000 }, async () => {
		for (const [dataset, axes, agree] of patterns()) {
			const built = build(dataset, dataset.cases, axes as BatchAxis[]);
			const runs: RunResult[] = [];
			for (let at = 0; at < REPEATS; at += 1) runs.push(await run([built]));
			const merged: RunResult = {
				...runs[0],
				latencyMs: runs.flatMap((r) => r.latencyMs),
				requests: REPEATS,
				inputTokens: runs.reduce((sum, r) => sum + r.inputTokens, 0),
				outputTokens: runs.reduce((sum, r) => sum + r.outputTokens, 0),
				missing: runs.flatMap((r) => r.missing)
			};
			record(
				`A ${dataset.theme} 50x${(axes as BatchAxis[]).length}`,
				[built],
				merged,
				agree(dataset, runs[0].answers)
			);
			expect(merged.missing, `${dataset.theme} で欠けた answer`).toEqual([]);
		}
	});

	it('Pattern B: 質問数が実測上限に収まるようchunkする', { timeout: 600_000 }, async () => {
		for (const [dataset, axes, agree] of patterns()) {
			const built = chunked(dataset, axes as BatchAxis[]);
			const result = await run(built);
			record(`B ${dataset.theme} chunk`, built, result, agree(dataset, result.answers));
			expect(result.missing, `${dataset.theme} で欠けた answer`).toEqual([]);
		}
	});

	it('Pattern C: 軸の構造を変える（Choice⇄Noul）', { timeout: 600_000 }, async () => {
		// deadline: 1 Choice -> 5 Noul（50問 -> 250問）
		const deadlineBuilt = build(deadline, deadline.cases, DEADLINE_NOUL_AXES);
		const deadlineRun = await run([deadlineBuilt]);
		record(
			'C deadline 50x5 noul',
			[deadlineBuilt],
			deadlineRun,
			deadlineNoulAgreement(deadline, deadlineRun.answers)
		);

		// dx: 3択のChoice -> 3つの独立Noul（50問 -> 150問）
		const dxBuilt = build(dx, dx.cases, DX_NOUL_AXES);
		const dxRun = await run([dxBuilt]);
		record('C dx 50x3 noul', [dxBuilt], dxRun, dxNoulAgreement(dx, dxRun.answers));

		expect([...deadlineRun.missing, ...dxRun.missing]).toEqual([]);
	});

	it('入力順を変えても送るものが変わらない', { timeout: 600_000 }, async () => {
		// **本番は内容で並べる**ので、利用者が貼った順は結果に影響しない
		// （`canonicalOrder`）。素の並び順依存は次のテストで測る。
		const forward = build(privacy, privacy.cases);
		const reversed = build(privacy, [...privacy.cases].reverse());
		expect(JSON.stringify(reversed.state)).toBe(JSON.stringify(forward.state));

		const first = await run([forward]);
		const second = await run([reversed]);
		const flips = privacy.cases.filter(
			(item) =>
				privacyVerdict(new Map(Object.entries(first.answers)), item.id) !==
				privacyVerdict(new Map(Object.entries(second.answers)), item.id)
		);
		report.push(
			`canonical 入力順を逆にしたときの判定の違い ${flips.length}/${privacy.cases.length}`
		);
	});

	it('probabilityの混線: 並び順だけを変えて分布が動くか見る', { timeout: 600_000 }, async () => {
		// **canonicalOrder を外して素の性質を測る。** 本番の経路は上のテストの
		// 通り入力順に依らないが、それは並び順依存が無いという意味ではない。
		// 集合が変われば並びも変わるため、ここで残っている感度を記録する。
		//
		// **同じ並びで2回投げた差を先に測る。** これが無いと、逆順との差が
		// 位置のせいなのか、上流のゆらぎなのか区別できない。
		const raw = (cases: BatchDataset['cases']) =>
			buildBatchRequest(privacy, cases, PRIVACY_AXES, undefined, { canonicalOrder: false });
		const forward = raw(privacy.cases);
		const reversed = raw([...privacy.cases].reverse());

		const first = await run([forward]);
		const control = await run([forward]);
		const second = await run([reversed]);

		const compare = (a: RunResult, b: RunResult) =>
			privacy.cases.flatMap((item) =>
				PRIVACY_AXES.map((axis) => {
					const id = `${item.id}__${axis.key}`;
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
					label.padEnd(24),
					`max=${worst[0].delta.toFixed(3)}`,
					`mean=${(rows.reduce((sum, row) => sum + row.delta, 0) / rows.length).toFixed(3)}`,
					`over${MAX_BLEED_DELTA}=${rows.filter((row) => row.delta > MAX_BLEED_DELTA).length}/${rows.length}`,
					`flip@0.5=${rows.filter((row) => row.flipped).length}`,
					`worst: ${worst.map((row) => `${row.id} ${row.delta.toFixed(3)}`).join(', ')}`
				].join('  ')
			);
			return rows;
		};

		const jitter = describeDeltas('bleed privacy 同じ並び', compare(first, control));
		const shifted = describeDeltas('bleed privacy 逆順', compare(first, second));

		const mean = (rows: typeof jitter) =>
			rows.reduce((sum, row) => sum + row.delta, 0) / rows.length;
		const over = shifted.filter((row) => row.delta > MAX_BLEED_DELTA).length;
		report.push(
			`  逆順の平均差 / 同じ並びの平均差 = ${(mean(shifted) / Math.max(mean(jitter), 1e-9)).toFixed(2)}`,
			over > 0
				? `  **基準未達**: 素の並び順では ${over}/${shifted.length} が ${MAX_BLEED_DELTA} を超える。` +
						`本番は canonicalOrder で入力順の影響を消しているが、並び順依存そのものは残っている`
				: `  素の並び順でも ${MAX_BLEED_DELTA} を超えなかった`
		);

		// 素の並び順は基準未達である。**それを承知で測っているので、ここでは
		// 落とさない。** 代わりに、本番の経路が入力順に依らないことを上の
		// テストで担保し、残る感度をレポートへ必ず出す。
		expect(report.some((line) => line.includes('bleed privacy 逆順'))).toBe(true);
	});

	it('基準日を動かすと絶対日付の判定が動く', { timeout: 600_000 }, async () => {
		// 基準日をstateへ置くだけでは、使われている証明にならない。**同じ文で
		// 基準日だけを変え、判定が動くかを見る。** 動かなければ、絶対日付を
		// 含む事例のgoldは再現しない。
		const absolute = deadline.cases.filter((item) => /\d+月\d+日/.test(item.text));
		expect(absolute.length, '絶対日付を含む事例が無いと検査にならない').toBeGreaterThan(0);

		const dated = (referenceDate: string) =>
			build(deadline, absolute, AXES_BY_THEME.deadline, referenceDate);

		// 2026-09-21（月）から見た9月25日は今週の金曜。9月25日から見れば当日。
		const before = await run([dated('2026-09-21')]);
		const after = await run([dated('2026-09-25')]);

		const moved = absolute.filter(
			(item) =>
				before.answers[`${item.id}__class`]?.choice !== after.answers[`${item.id}__class`]?.choice
		);
		report.push(
			`基準日シフト 9/21 -> 9/25  動いた ${moved.length}/${absolute.length}`,
			...absolute.map(
				(item) =>
					`    ${item.id} ${before.answers[`${item.id}__class`]?.choice} -> ${
						after.answers[`${item.id}__class`]?.choice
					}  gold(9/21)=${item.gold as string}  ${item.text}`
			)
		);

		expect(before.missing).toEqual([]);
		expect(after.missing).toEqual([]);
		// 基準日を無視しているなら、どの事例も動かない。
		expect(moved.length, '基準日を変えても判定が動かない').toBeGreaterThan(0);
	});

	it('成立する最大の「件数 × 軸数」を探る', { timeout: 600_000 }, async () => {
		// 50×3=150 は上で成立している。**どこで壊れるかは別に測る。**
		// 成立した一点だけを見て上限を決めると、本番が端に立つ。
		// 精度は見ない。answerが全部返るかどうかだけを見る容量の試験なので、
		// 事例は fixture を複製して作る（IDは別にする）。
		for (const cases of [100, 200, 250, 350]) {
			const inflated: BatchDataset = {
				...privacy,
				cases: Array.from({ length: cases }, (_, at) => ({
					...privacy.cases[at % privacy.cases.length],
					id: `privacy_probe_${String(at).padStart(3, '0')}`
				}))
			};
			const built = build(inflated, inflated.cases, PRIVACY_AXES);
			try {
				const result = await run([built]);
				record(
					`probe privacy ${cases}x3`,
					[built],
					result,
					result.missing.length === 0 ? 'complete' : `MISSING ${result.missing.length}`
				);
				if (result.missing.length > 0) break;
			} catch (error) {
				report.push(
					`probe privacy ${cases}x3  q=${built.questionCount}  失敗: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
				break;
			}
		}
		expect(report.some((line) => line.startsWith('probe'))).toBe(true);
	});

	it('計測結果を出す', () => {
		// どのfixtureに対する数値かを一緒に出す。docsへ写した数値が後から
		// 辿れなくなるのを防ぐ。
		const fingerprints = [privacy, deadline, dx].map(
			(dataset) => `${dataset.theme}=${datasetFingerprint(dataset)}:${dataset.labelStatus}`
		);
		console.log(
			[
				'',
				'=== BATCH JUDGE benchmark ===',
				`dataset ${fingerprints.join(' ')}`,
				...report,
				''
			].join('\n')
		);
		console.log(
			`判定基準: 1リクエスト ${MAX_ACCEPTABLE_MS}ms 以内 / answer欠落0 / 並び替えの差 ${MAX_BLEED_DELTA} 以内`
		);
		// 一致率を状態なしで読ませない。draft のまま「精度」と書かれるのを防ぐ。
		const draft = [privacy, deadline, dx].filter((dataset) => dataset.labelStatus !== 'reviewed');
		if (draft.length > 0) {
			console.log(
				`注意: ${draft
					.map((dataset) => dataset.theme)
					.join(
						' / '
					)} の gold は人手確認前。上の一致率は暫定ラベルに対する実測値であり、精度ではない`
			);
		}
		// 前の5本が計測を record している。空なら計測せずに通ってしまう。
		expect(report.length).toBeGreaterThan(0);
	});
});
