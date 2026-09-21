/**
 * BATCH JUDGE の表示文言。
 *
 * **`safe` を「安全」と訳さない。** このモードが出せる結論ではない
 * （docs/BATCH_JUDGE_DESIGN.md §3.1）。値そのものも `no_signal` にしてある。
 */

import type { BatchTheme } from '$lib/types/batch';

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

/** テーマごとの注意文。画面に常時出す。 */
export const THEME_NOTES: Record<BatchTheme, string[]> = {
	privacy: [
		'「要確認シグナルなし」は、このモードが見る範囲で明確なシグナルが出なかったという意味だけです。個人情報に該当しないという判定でも、AIサービスへ送ってよいという保証でもありません。',
		'電話番号やマイナンバーのように規則で検出できるものは、本来この判定だけに任せず、regex や DLP と組み合わせます。Jevを唯一の制御にしないでください。'
	],
	deadline: [
		'文面から読み取れる緊急度の目安です。日時の厳密な解釈はしていません。基準日はサーバーが渡しています。'
	],
	dx: [
		'相談文から「まず何を検討するか」を仕分ける技術検証です。正式なDXコンサルティング判断ではありません。'
	]
};
