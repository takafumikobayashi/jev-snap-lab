/**
 * BATCH JUDGE の表示文言。
 *
 * **`safe` を「安全」と訳さない。** このモードが出せる結論ではない
 * （docs/BATCH_JUDGE_DESIGN.md §3.1）。値そのものも `no_signal` にしてある。
 */

import type { BatchJudgeResult, BatchTheme } from '$lib/types/batch';

const VERDICT_LABELS: Record<string, string> = {
	// PRIVACY。「安全」「OK」「そのまま入力」としない。
	no_signal: '要確認シグナルなし',
	review: '要確認',
	// DEADLINE
	now: 'いますぐ',
	today: '今日中',
	soon: '近いうち',
	later: '先の話',
	none: '期限なし',
	// DX JUDGE
	bpr: '業務の見直し',
	digital: 'デジタル化',
	neither: 'どちらでもない'
};

export function verdictLabel(verdict: string): string {
	return VERDICT_LABELS[verdict] ?? verdict;
}

/** 軸の説明。要確認になった理由の内訳に使う。 */
const SIGNAL_LABELS: Record<string, string> = {
	identifies: '個人が特定される',
	personal: '個人の事情を含む',
	sensitive: '慎重に扱う情報'
};

export function signalLabel(key: string): string {
	return SIGNAL_LABELS[key] ?? verdictLabel(key);
}

/**
 * テーマごとの注意文。
 *
 * 誤認を招く一点だけに絞る。**注意書きを積むと読まれなくなる。**
 *
 * PRIVACY の「要確認シグナルなし」の意味は、ラベルの文言そのものが担う。
 * `safe` という語を使わないことを型とテストで固定してあるので（§3.1）、
 * 段落で重ねない。regex / DLP と組み合わせる話は実装者への助言であり、
 * デモの利用者への注意ではないので設計書にだけ置く。
 */
const THEME_NOTES_BY_THEME: Record<BatchTheme, string[]> = {
	privacy: [],
	deadline: [
		'文面から読み取れる緊急度の目安です。日時の厳密な解釈はしていません。基準日はサーバーが渡しています。'
	],
	dx: [
		'相談文から「まず何を検討するか」を仕分ける技術検証です。正式なDXコンサルティング判断ではありません。'
	]
};

export const THEME_NOTES = THEME_NOTES_BY_THEME;

/**
 * 判定に効いた軸。
 *
 * PRIVACY は `identifies` か `personal` で決める。`sensitive` は理由として
 * 出すだけで判定には使わない（docs/BATCH_JUDGE_DESIGN.md §3.1）。
 */
const DECIDING_SIGNALS: Partial<Record<BatchTheme, string[]>> = {
	privacy: ['identifies', 'personal']
};

/**
 * 行に出す確率。
 *
 * **全軸の最大値を出してはならない。** 「生活保護受給世帯の一覧をExcelから
 * 抽出しました」は `sensitive` が0.97、判定は `要確認シグナルなし` である。
 * 最大値を並べると「要確認シグナルなし 97%」となり、シグナルが無いことの
 * 確信度に見える。実際に画面へ出てしまった。
 */
export function decidingProbability(theme: BatchTheme, signals: BatchJudgeResult['signals']) {
	const deciding = DECIDING_SIGNALS[theme];
	const used = deciding ? signals.filter((signal) => deciding.includes(signal.key)) : signals;
	// Choice のテーマは選ばれた選択肢の confidence が1つ入る。
	return used.reduce((best, signal) => Math.max(best, signal.probability), 0);
}

/**
 * 結論ごとの色。
 *
 * **色だけに意味を持たせない。** どの行にも文字のラベルが並ぶ（§6）。
 * 色は読み分けを速くするためのもので、色が見えなくても結論は分かる。
 *
 * PRIVACY の `no_signal` に**緑を使わない。** 緑は安全の合図として読まれ、
 * このモードが出せる結論ではない（§3.1）。注意側だけに色を置き、もう一方は
 * 無彩色にする。
 *
 * DEADLINE は急ぎ度の順に暖色から寒色へ。DX は順序が無いので別々の色相に
 * する。
 */
export type VerdictStyle = { bar: string; text: string };

const NEUTRAL: VerdictStyle = {
	bar: 'bg-neutral-400 dark:bg-neutral-500',
	text: 'text-neutral-600 dark:text-neutral-400'
};

const VERDICT_STYLES: Record<string, VerdictStyle> = {
	// PRIVACY。要確認だけに色を置く。
	review: { bar: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' },
	no_signal: NEUTRAL,
	// DEADLINE。急ぎ度の順。
	now: { bar: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' },
	today: { bar: 'bg-orange-500', text: 'text-orange-700 dark:text-orange-400' },
	soon: { bar: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' },
	later: { bar: 'bg-teal-500', text: 'text-teal-700 dark:text-teal-400' },
	none: NEUTRAL,
	// DX。順序が無いので別々の色相にする。
	bpr: { bar: 'bg-violet-500', text: 'text-violet-700 dark:text-violet-400' },
	digital: { bar: 'bg-sky-500', text: 'text-sky-700 dark:text-sky-400' },
	neither: NEUTRAL
};

export function verdictStyle(verdict: string): VerdictStyle {
	return VERDICT_STYLES[verdict] ?? NEUTRAL;
}

/**
 * 1件ずつ開示するときの1件あたりの間隔（ミリ秒）。
 *
 * **これは処理時間ではない。** 全件は1回のリクエストで同時に評価されている。
 * 受信後の再生であり、画面にもそう書く（§6）。
 */
export function revealIntervalMs(caseCount: number): number {
	if (caseCount <= 1) return 0;
	// 件数が多くても全体で1.2秒に収める。少なければ1件あたりを長くしない。
	return Math.min(40, Math.max(12, Math.round(1_200 / caseCount)));
}
