/**
 * BATCH JUDGE と Jev の契約。
 *
 * 質問ID、primitive、instructions、criteria、stateの参照パスを**ここだけ**で
 * 決める。Phase 12 の実測はこのモジュールを通して行っており、docs に載る
 * 数値とこの定義は同じものである（docs/BATCH_JUDGE_DESIGN.md §4.6）。
 *
 * 評価用のコードへ質問文を書き写さない。書き写すと、片方だけ直したときに
 * 「測ったもの」と「動くもの」がずれる。CITY / SPEC FIND と同じ方針。
 */

import { createHash } from 'node:crypto';
import { choice, noul, type Questions } from '@typesafe-ai/sdk';
import { JudgeError } from './errors.server';
import {
	DX_CLASSES,
	type BatchCase,
	type BatchJevCase,
	type BatchDataset,
	type BatchTheme,
	type DxClass
} from '$lib/types/batch';
import type { JsonValue } from '$lib/types/semantic';

/**
 * 質問IDの作り方。`<caseId>__<axis>`。
 *
 * 質問IDはJevへ送られず、答えを事例へ戻すための対応表でしかない。IDの
 * 文字列から事例を復元せず、組み立てたときの対応をそのまま持ち回る。
 */
export function questionIdOf(caseId: string, axis: string): string {
	return `${caseId}__${axis}`;
}

/** stateのどこに事例を置くか。instructionsのパスと必ず一致させる。 */
export const CASES_KEY = 'cases';

/** 事例1件あたり1問を作る軸。`path` は `cases.privacy_001` のようなキー参照。 */
export type BatchAxis = { key: string; build: (path: string) => Questions[string] };

/**
 * PRIVACY の3軸。
 *
 * 判断の対象は**入力文そのもの**である。「〜をまとめたい」という作業の説明
 * ではなく、これから貼り付けようとしている文章を仕分ける。
 *
 * 判定は `identifies` か `personal` が閾値以上、とする。`sensitive` は話題の
 * 語に反応するため判定には使わず、要確認になった理由の内訳として出す
 * （docs/BATCH_JUDGE_DESIGN.md §3.1）。
 */
export const PRIVACY_AXES: BatchAxis[] = [
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

export const DEADLINE_CRITERIA = {
	now: 'The text asks for action right away, or says a deadline has already passed.',
	today: 'The text points at the end of the working day, tonight, or first thing tomorrow morning.',
	soon: 'The text points at this week, next week, or the end of this month.',
	later: 'The text points beyond this month: next month, this quarter, the fiscal year, or later.',
	none: 'The text expresses no time pressure at all.'
};

/**
 * DEADLINE の5択。
 *
 * **基準日を state で与える。** 「9月25日17時まで」のような絶対日付は、今日が
 * 何日かを知らなければどの区分にも決まらない。日付はアプリが持つ Knowledge で
 * あり、Jevに推測させない。日付そのもののparserは作らない（§3.2）。
 */
export const DEADLINE_AXES: BatchAxis[] = [
	{
		key: 'class',
		build: (path) =>
			choice(
				`How soon does \`${path}.text\` ask for a response? Today's date is given in \`referenceDate\`; read any explicit date against it. Judge how far off the deadline is, not the calendar arithmetic itself.`,
				DEADLINE_CRITERIA
			)
	}
];

export const DX_CRITERIA: Record<DxClass, string> = {
	bpr: 'The work itself should be questioned first. The form, the rule, the approval chain, or the duplication is the problem, and a tool laid over it would preserve that problem.',
	digital:
		'The work itself is needed and a tool would do it: copying, aggregating, searching, transcribing, sending, drafting, or sorting by meaning.',
	neither:
		'Neither fits. It is a matter of people, staffing, training, or a rule set outside this organisation, and has to be settled before any tool or redesign is chosen.'
};

/**
 * DX JUDGE の3択。
 *
 * 5つの独立Noulから変えた。軸が独立しておらず、goldが真の群と偽の群の平均差が
 * 0.06〜0.20しかなかった（§3.3）。切り口は**まず何をするか**である。
 */
export const DX_AXES: BatchAxis[] = [
	{
		key: 'first_move',
		build: (path) =>
			choice(
				`For the problem described in \`${path}.text\`, what should be taken up first?`,
				DX_CRITERIA as Record<string, string>
			)
	}
];

export const AXES_BY_THEME: Record<BatchTheme, BatchAxis[]> = {
	privacy: PRIVACY_AXES,
	deadline: DEADLINE_AXES,
	dx: DX_AXES
};

export type BatchRequest = {
	state: Record<string, JsonValue>;
	questions: Questions;
	/** 質問ID -> 事例ID。IDの文字列から復元しない。 */
	index: Map<string, string>;
	caseCount: number;
	questionCount: number;
};

/**
 * 1リクエストを組み立てる。
 *
 * 事例は**オブジェクトのキー**で置き、キーは fixture のIDをそのまま使う。
 * 配列インデックス参照は候補が20件を超えると確率が隣へ滲む（§4.3）。
 * 並び順を変えてもキーは動かないため、混線の検査はこの形のままできる。
 *
 * `referenceDate` は持つテーマだけ入れる。判定に寄与しない値をstateへ入れない。
 *
 * **stateへ入れるのは `id` と `text` だけである**（`BatchJevCase`）。`gold`、
 * `note`、`difficulty` は人手の評価であって判断材料ではない。
 *
 * **並び順を内容から決める**（`canonicalOrder`）。実測で、並び順を変えると
 * 同じ事例の確率が動いた（逆順で最大0.400、判定の反転が150件中6件）。
 * 配列インデックス参照のような大規模な混線ではないが、**並び順依存は残って
 * いる**（docs/BATCH_JUDGE_DESIGN.md §4.6）。
 *
 * 利用者が貼った順で送ると、同じ50件でも並べ替えただけで結果が変わる。
 * 本文のハッシュで並べれば、入力順が違っても state は同じになる。画面の
 * 並びは `index` から戻す。
 *
 * **これは並び順依存を消すものではない。** 入力順の影響を消すだけで、
 * 集合が変われば結果は変わりうる。混線を測るときは `canonicalOrder: false`
 * にして、素の並び順依存を見る。
 */
export type BuildOptions = {
	/** 既定は true。混線を測るときだけ false にする。 */
	canonicalOrder?: boolean;
};

/** 内容から決まる並び順のキー。入力順にもIDにも依らない。 */
function orderKey(item: BatchCase): string {
	return createHash('sha256').update(item.text).digest('hex');
}

export function buildBatchRequest(
	dataset: BatchDataset,
	cases: readonly BatchCase[] = dataset.cases,
	axes: BatchAxis[] = AXES_BY_THEME[dataset.theme],
	referenceDate = dataset.referenceDate,
	options: BuildOptions = {}
): BatchRequest {
	if (cases.length === 0) {
		throw new JudgeError('QUESTION_DEFINITION_ERROR', 'BATCH JUDGE の事例が空である');
	}

	const ordered =
		options.canonicalOrder === false
			? [...cases]
			: [...cases].sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1));

	// **gold と note を入れない。** 答えと根拠を渡せば一致率が測れなくなる。
	// 形を `BatchJevCase` に固定し、事例を展開してコピーしない。
	const bag: Record<string, Omit<BatchJevCase, 'id'>> = {};
	const questions: Questions = {};
	const index = new Map<string, string>();
	for (const item of ordered) {
		bag[item.id] = { text: item.text };
		for (const axis of axes) {
			const questionId = questionIdOf(item.id, axis.key);
			questions[questionId] = axis.build(`${CASES_KEY}.${item.id}`);
			index.set(questionId, item.id);
		}
	}

	return {
		state: {
			mode: 'batch',
			theme: dataset.theme,
			...(referenceDate ? { referenceDate } : {}),
			[CASES_KEY]: bag
		},
		questions,
		index,
		caseCount: cases.length,
		questionCount: Object.keys(questions).length
	};
}

export type BatchAnswer = { type: string; noul?: number; choice?: string; confidence?: number };

/**
 * answers を検証する。
 *
 * **欠落したらリクエスト全体を失敗させる。** 一部だけ返して残りを「判定
 * できなかった」と描くほうが親切に見えるが、PRIVACY で欠落が「要確認シグナル
 * なし」と並んで表示されると、**見ていない事例を安全に見せる**ことになる。
 *
 * 実測では 150問・250問・500問・750問のいずれでも欠落が1件も出ていない
 * （§4.6）。欠落は想定される状態ではなく異常であり、静かに欠けたまま
 * 見せるより、はっきり失敗させるほうがよい。再実行は数百msで済む。
 */
export function readBatchAnswers(
	answers: unknown,
	request: BatchRequest
): Map<string, BatchAnswer> {
	if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
		throw contractError('answers がオブジェクトでない');
	}
	const record = answers as Record<string, unknown>;

	const unexpected = Object.keys(record).filter((id) => !request.index.has(id));
	if (unexpected.length > 0) {
		// 送っていない質問の答えを受け取っている。対応表が壊れている。
		throw contractError(`送っていない質問の answer がある: ${unexpected.length} 件`);
	}

	const results = new Map<string, BatchAnswer>();
	const missing: string[] = [];
	for (const questionId of request.index.keys()) {
		const value = record[questionId];
		if (value === undefined) {
			missing.push(questionId);
			continue;
		}
		if (value === null || typeof value !== 'object') {
			throw contractError(`${questionId} の answer がオブジェクトでない`);
		}
		const answer = value as BatchAnswer;
		if (answer.type === 'noul') {
			if (typeof answer.noul !== 'number' || answer.noul < 0 || answer.noul > 1) {
				throw contractError(`${questionId} の noul が 0〜1 の数値でない`);
			}
		} else if (answer.type === 'choice') {
			if (typeof answer.choice !== 'string' || answer.choice.length === 0) {
				throw contractError(`${questionId} の choice が空でない文字列でない`);
			}
		} else {
			throw contractError(`${questionId} の type が noul でも choice でもない`);
		}
		results.set(questionId, answer);
	}

	if (missing.length > 0) {
		// 件数だけ出す。入力本文は例外メッセージへ入れない。
		throw contractError(`answer が ${missing.length}/${request.questionCount} 件欠けている`);
	}
	return results;
}

function contractError(detail: string): JudgeError {
	return new JudgeError('UPSTREAM_UNAVAILABLE', `BATCH JUDGE の契約違反: ${detail}`);
}

/**
 * PRIVACY の判定。
 *
 * **3軸の最大値では過検知する。** `sensitive` が話題の語に反応するためで、
 * 「生活保護受給世帯の一覧をExcelから抽出しました」は誰も特定できないのに
 * sensitive=0.96 になる（§4.6）。
 */
export const PRIVACY_REVIEW_THRESHOLD = 0.5;

export function privacyVerdict(
	answers: Map<string, BatchAnswer>,
	caseId: string,
	threshold = PRIVACY_REVIEW_THRESHOLD
): 'no_signal' | 'review' {
	const at = (axis: string) => answers.get(questionIdOf(caseId, axis))?.noul ?? 0;
	return at('identifies') >= threshold || at('personal') >= threshold ? 'review' : 'no_signal';
}

/** DEADLINE / DX は Choice なので、選ばれた値がそのまま結論になる。 */
export function choiceVerdict(answers: Map<string, BatchAnswer>, caseId: string, axis: string) {
	return answers.get(questionIdOf(caseId, axis))?.choice;
}

export const DX_CLASS_VALUES = DX_CLASSES;
