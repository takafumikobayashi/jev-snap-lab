/**
 * BATCH JUDGE のサーバー側入口。
 *
 * fixture の検証は**リクエスト処理の中**で行う。モジュール初期化時に評価
 * すると、データの不備がルートの import 失敗になり、SvelteKit は JSON の
 * エラー封筒ではなく HTML の 500 を返す（SPEC FIND と同じ理由）。
 *
 * 同梱した例文と、利用者が入力した文章のどちらも判定する。
 *
 * **PRIVACY は「AIにそのまま入れてよい？」を判定するために入力文をAIへ送る。**
 * 利用者が実際の個人情報を貼ると、判定より先に送信が起きる。画面は入力欄の
 * 手前に送信する旨を常時出し、デモ用の例文をワンクリックで入れられるように
 * している（docs/BATCH_JUDGE_DESIGN.md §3.1）。この前提を外さないこと。
 */

import { env } from '$env/dynamic/private';
import rawPrivacy from '../../../data/batch/privacy.json';
import rawDeadline from '../../../data/batch/deadline.json';
import rawDx from '../../../data/batch/dx.json';
import {
	BATCH_THEMES,
	type BatchDataset,
	type BatchJudgeResponse,
	type BatchJudgeResult,
	type BatchTheme
} from '$lib/types/batch';
import { validateDataset } from './batch-dataset.server';
import { countCodePoints } from '$lib/types/judge';
import {
	AXES_BY_THEME,
	buildBatchRequest,
	privacyVerdict,
	questionIdOf,
	readBatchAnswers,
	type BatchAnswer,
	type BatchRequest
} from './batch-questions.server';

/**
 * 実験機能として既定では無効にする。
 *
 * 有効化は明示的な `true` だけ。値の取り違えで本番へ出ないようにする。
 */
export function isBatchJudgeEnabled(): boolean {
	return env.BATCH_JUDGE_ENABLED?.trim() === 'true';
}

/** 1ミリ秒未満の段階がある。小数1桁まで残さないと 0ms ばかりになる。 */
function round(ms: number): number {
	return Math.round(ms * 10) / 10;
}

const RAW: Record<BatchTheme, unknown> = {
	privacy: rawPrivacy,
	deadline: rawDeadline,
	dx: rawDx
};

const cached = new Map<BatchTheme, BatchDataset>();

export function loadDataset(theme: BatchTheme): BatchDataset {
	const hit = cached.get(theme);
	if (hit) return hit;
	const dataset = validateDataset(RAW[theme]);
	cached.set(theme, dataset);
	return dataset;
}

/**
 * 画面のタブに出す一覧。
 *
 * 例文そのものを渡す。**自分の文章を貼らなくても動きを確認できる**ように
 * するのは受入条件である（docs/BATCH_JUDGE_DESIGN.md §11）。
 */
export function batchCatalog(): {
	theme: BatchTheme;
	label: string;
	cases: number;
	samples: string[];
}[] {
	return BATCH_THEMES.map((theme) => {
		const dataset = loadDataset(theme);
		return {
			theme,
			label: dataset.label,
			cases: dataset.cases.length,
			samples: dataset.cases.map((item) => item.text)
		};
	});
}

/**
 * 渡された文章を事例にする。
 *
 * **gold を引き当てない。** 自由に貼った50件に正解は無い。以前は本文が例文と
 * 完全一致したときだけ gold を付けていたが、そのせいで「貼った文章がたまたま
 * 例文と同じだったときだけ一致率が出る」という不可解な挙動になっていた。
 * 評価は benchmark の仕事である（`batch-judge.live.spec.ts`）。
 */
function toCases(theme: BatchTheme, texts: readonly string[]): BatchDataset['cases'] {
	return texts.map(
		(text, at) =>
			({
				id: `${theme}_input_${String(at + 1).padStart(3, '0')}`,
				text,
				difficulty: 'medium' as const
			}) as BatchDataset['cases'][number]
	);
}

/** テストと benchmark から差し替える上流。 */
export type BatchSender = (
	request: BatchRequest
) => Promise<{ answers: Record<string, unknown>; inputTokens: number; outputTokens: number }>;

/**
 * 1テーマぶんを一度に判定する。
 *
 * 分割しない。実測で、分割すると入力tokenが2〜8%増え、質問数が多いほど
 * 実時間の差が開いた（docs/BATCH_JUDGE_DESIGN.md §4.6）。
 */
export async function runBatchJudge(
	theme: BatchTheme,
	send: BatchSender,
	texts: readonly string[]
): Promise<
	Omit<BatchJudgeResponse, 'requestId' | 'model' | 'latencyMs' | 'usage'> & {
		inputTokens: number;
		outputTokens: number;
	}
> {
	const dataset = loadDataset(theme);

	// 段階ごとに計る。**画面の「処理の流れ」はこの値を出す。** 計らずに段階を
	// 見せると、名前だけが本物で進み方は演出になる。
	const buildStartedAt = performance.now();
	const cases = toCases(theme, texts);
	const request = buildBatchRequest(dataset, cases);
	const buildMs = performance.now() - buildStartedAt;

	const upstreamStartedAt = performance.now();
	const raw = await send(request);
	const upstreamMs = performance.now() - upstreamStartedAt;

	const readStartedAt = performance.now();
	// 欠落と契約違反はここで弾く。**見ていない事例を安全に見せない**（§5.5.4）。
	const answers = readBatchAnswers(raw.answers, request);
	const readMs = performance.now() - readStartedAt;

	const decideStartedAt = performance.now();
	const results = cases.map((item) => toResult(theme, item, answers));
	const decideMs = performance.now() - decideStartedAt;

	return {
		mode: 'batch',
		theme,
		...(dataset.referenceDate ? { referenceDate: dataset.referenceDate } : {}),
		caseCount: request.caseCount,
		questionCount: request.questionCount,
		stateChars: cases.reduce((sum, item) => sum + countCodePoints(item.text), 0),
		stages: {
			buildMs: round(buildMs),
			upstreamMs: round(upstreamMs),
			readMs: round(readMs),
			decideMs: round(decideMs)
		},
		// 分割していない。画面で示すために数として返す。
		upstreamCalls: 1,
		results,
		inputTokens: raw.inputTokens,
		outputTokens: raw.outputTokens
	};
}

/**
 * 1事例ぶんの結果。
 *
 * `signals` には**判定に使わない軸も含める。** PRIVACY の `sensitive` は
 * 要確認になった理由として出すが、判定には使わない（§3.1）。閾値を変える
 * ために再実行しなくてよいよう、確率をそのまま持つ。
 */
function toResult(
	theme: BatchTheme,
	item: BatchDataset['cases'][number],
	answers: Map<string, BatchAnswer>
): BatchJudgeResult {
	const caseId = item.id;
	const signals = AXES_BY_THEME[theme].flatMap((axis) => {
		const answer = answers.get(questionIdOf(caseId, axis.key));
		if (answer?.type === 'noul' && typeof answer.noul === 'number') {
			return [{ key: axis.key, probability: answer.noul }];
		}
		// Choice は選んだ選択肢の確信度を1つ持つ。全分布は画面で使わない。
		if (answer?.type === 'choice' && typeof answer.confidence === 'number') {
			return [{ key: answer.choice ?? axis.key, probability: answer.confidence }];
		}
		return [];
	});

	const verdict =
		theme === 'privacy'
			? privacyVerdict(answers, caseId)
			: (answers.get(questionIdOf(caseId, AXES_BY_THEME[theme][0].key))?.choice ?? '');

	return { caseId, text: item.text, verdict, signals };
}
