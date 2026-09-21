/**
 * BATCH JUDGE のサーバー側入口。
 *
 * fixture の検証は**リクエスト処理の中**で行う。モジュール初期化時に評価
 * すると、データの不備がルートの import 失敗になり、SvelteKit は JSON の
 * エラー封筒ではなく HTML の 500 を返す（SPEC FIND と同じ理由）。
 *
 * v0 は**同梱した fixture を判定するだけ**で、利用者の入力を受け付けない。
 * 理由は2つある。
 *
 * 1. このモードの見せ場は「数十件を一度に」であり、利用者が50件を打ち込む
 *    使い方は現実的でない
 * 2. PRIVACY は「AIにそのまま入れてよい？」を判定するために入力文をAIへ
 *    送る。利用者が実際の個人情報を貼ると、判定より先に送信が起きる
 *    （docs/BATCH_JUDGE_DESIGN.md §3.1）
 *
 * 入力を受け付けるなら、§3.1 の注意文とデモ用例文を先に用意すること。
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
import { datasetFingerprint, summarizeDataset, validateDataset } from './batch-dataset.server';
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

/** 画面のタブに出す一覧。件数まで出すのでデータから作る。 */
export function batchCatalog(): { theme: BatchTheme; label: string; cases: number }[] {
	return BATCH_THEMES.map((theme) => {
		const dataset = loadDataset(theme);
		return { theme, label: dataset.label, cases: dataset.cases.length };
	});
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
	send: BatchSender
): Promise<
	Omit<BatchJudgeResponse, 'requestId' | 'model' | 'latencyMs' | 'usage'> & {
		inputTokens: number;
		outputTokens: number;
	}
> {
	const dataset = loadDataset(theme);
	const request = buildBatchRequest(dataset);
	const raw = await send(request);
	// 欠落と契約違反はここで弾く。**見ていない事例を安全に見せない**（§5.5.4）。
	const answers = readBatchAnswers(raw.answers, request);

	return {
		mode: 'batch',
		theme,
		datasetFingerprint: datasetFingerprint(dataset),
		...(dataset.referenceDate ? { referenceDate: dataset.referenceDate } : {}),
		caseCount: request.caseCount,
		questionCount: request.questionCount,
		labelStatus: dataset.labelStatus,
		results: dataset.cases.map((item) => toResult(theme, item, answers)),
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
	const gold = item.gold as string;
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

	return { caseId, text: item.text, verdict, signals, gold, agrees: verdict === gold };
}

/** 画面の要約。**暫定ラベルに対する一致であることを呼び出し側が消せない形にする。** */
export function summarizeResults(response: BatchJudgeResponse): {
	agreed: number;
	total: number;
	labelStatus: BatchJudgeResponse['labelStatus'];
	perGold: Record<string, number>;
} {
	return {
		agreed: response.results.filter((result) => result.agrees).length,
		total: response.results.length,
		labelStatus: response.labelStatus,
		perGold: summarizeDataset(loadDataset(response.theme)).gold
	};
}
