/**
 * モード別の質問定義と、日本語の表示ラベル。
 *
 * 出所は docs/JEV_DESIGN.md の §5 / §6 / §7。
 *
 * 質問 ID は英語の stable key、表示文言は日本語の label map で管理する。
 * `instructions` は質問 ID に依存させず、`text` の何を判定するかを毎回明記する
 * （ID はモデルへ送られないため）。criteria は type ごとに形が異なる（§4）。
 */

import { choice, noul, score, type Questions } from '@typesafe-ai/sdk';
import type { Mode } from '$lib/types/judge';
import {
	categoryCriteria,
	categoryLabels,
	jurisdictionName,
	routeCriteria,
	routeLabels
} from './city-directory.server';

export type QuestionCatalog = {
	questions: Questions;
	/** 質問 ID -> 画面に出す日本語ラベル。 */
	labels: Record<string, string>;
	/** Choice の候補キー -> 画面に出す日本語ラベル。 */
	optionLabels: Record<string, Record<string, string>>;
	/**
	 * Score の質問 ID -> レベル順の日本語ラベル。
	 *
	 * `criteria` は英語のままにしている。Jev は英語が主な学習言語であり
	 * （[Models](https://docs.typesafe.ai/models)）、判定精度を優先するため。
	 * 一方レスポンスの `legend` は送った `criteria` がそのまま返るため、
	 * 日本語 UI にそのまま出すと英語が混在する。表示にはこの配列を使う。
	 *
	 * 配列は `criteria` と同じ長さ・同じ順序でなければならない。ずれは
	 * contract test と正規化時の検証で検出する。
	 */
	scoreLabels: Record<string, string[]>;
};

/**
 * Jev へ渡す state。ユーザー入力と、サーバーが決める固定値だけを入れる。
 *
 * CITY だけ `jurisdiction` を足す。どの自治体への問い合わせとして読むかは
 * 判定に効くため。一方 `directory_version` と `directory_effective_date` は
 * state へ入れない。モデルにとって意味を持たないIDと日付でトークンを使う
 * だけで、候補の説明は criteria 側に入っているため判定に寄与しない。
 * データバージョンはレスポンスの `city.directoryVersion` に必ず記録する。
 */
export type JudgeState = {
	mode: Mode;
	text: string;
	jurisdiction?: string;
};

// CITY の管轄名・データバージョン・架空フラグは定数にしない。
// モジュール初期化時に評価するとデータセットの読み込みが import 時に起き、
// 設定ミスがルートの import 失敗になる。SvelteKit はその場合 JSON の
// エラー封筒ではなく HTML の 500 を返し、CITY と無関係な LOVE / SOCIAL まで
// 巻き添えで落ちる。`jurisdictionName()` / `directoryVersion()` /
// `isFictional()` をリクエスト処理の中から呼ぶ。

// ---------------------------------------------------------------------------
// LOVE
// ---------------------------------------------------------------------------

const LOVE_FRAMES = {
	breakup: '関係の終了や別れが文面の中心。',
	lingering: '関係が終わった後も相手への気持ちが残っている読み。',
	passionate: '強く燃える恋愛感情が中心。',
	unrequited: '気持ちが一方通行、または相手の気持ちが示されない片思い。',
	long_distance: '物理的な距離や離れている状態が恋愛上の要素。',
	ambiguous: '恋愛的ではあるが、どの読みとも決めがたい。',
	not_romantic: '恋愛的な含意が読み取れない。'
} as const;

function loveCatalog(): QuestionCatalog {
	return {
		questions: {
			romantic_frame: choice(
				'Which reading best describes the romantic framing of `text`? Judge how the text reads, not what its author actually felt.',
				LOVE_FRAMES
			),
			love_signal_strength: score(
				'How strongly does `text` carry romantic meaning? Judge the text itself, not the author.',
				[
					'No romantic meaning at all.',
					'Weak or context-dependent romantic meaning.',
					'Clear romantic meaning.',
					'Romantic meaning is the center of the text.'
				]
			),
			is_passionate: noul('Does `text` read as intense, burning romantic feeling?', {
				true: 'Strong romantic passion is central to the text.',
				false: 'The text does not support that reading.'
			}),
			is_unrequited: noul(
				'Does `text` read as one-sided love, where the feeling is not shown to be returned?',
				{
					true: 'The feeling reads as one-directional, or the other person’s feeling is absent.',
					false: 'The text does not read that way.'
				}
			),
			is_long_distance: noul(
				'Does physical distance or separation matter romantically in `text`?',
				{
					true: 'Distance or being apart is a romantic element of the text.',
					false: 'No such element is present.'
				}
			),
			relationship_ended: noul('Does `text` read as a relationship that has already ended?', {
				true: 'The text states or strongly implies the relationship is over.',
				false:
					'The relationship reads as ongoing, or it cannot be determined. Do not answer high when it is merely ambiguous.'
			}),
			still_loves: noul('Does `text` read as still holding romantic feeling right now?', {
				true: 'Romantic feeling reads as still present at the time of writing.',
				false: 'The text does not read as still holding romantic feeling.'
			})
		},
		labels: {
			romantic_frame: '恋愛的な読み',
			love_signal_strength: '恋愛シグナルの強さ',
			is_passionate: '熱愛として読める？',
			is_unrequited: '片思いとして読める？',
			is_long_distance: '遠距離の要素がある？',
			relationship_ended: '関係は終わっている？',
			still_loves: 'まだ気持ちがある？'
		},
		scoreLabels: {
			love_signal_strength: ['含意なし', '弱い', '明確', '非常に強い']
		},
		optionLabels: {
			romantic_frame: {
				breakup: '失恋・別れ',
				lingering: '未練',
				passionate: '熱愛',
				unrequited: '片思い',
				long_distance: '遠距離',
				ambiguous: '曖昧',
				not_romantic: '恋愛ではない'
			}
		}
	};
}

// ---------------------------------------------------------------------------
// SOCIAL
// ---------------------------------------------------------------------------

const POST_TYPES = {
	observation: '日常の観察や気づきの共有。',
	humor: '笑いを狙ったネタ、オチ、誇張。',
	learning: '知識や発見の共有。',
	opinion: '主張や意見の表明。',
	question: '読者への問いかけ。',
	complaint: '不満や愚痴。',
	promotion: '告知、宣伝、勧誘。',
	other: '上のいずれにも当てはまらない。'
} as const;

function socialCatalog(): QuestionCatalog {
	return {
		questions: {
			post_type: choice(
				'What kind of social media post is `text` most centrally? Pick the single most central type.',
				POST_TYPES
			),
			casualness: score('How casual is the tone of `text`?', [
				'Formal or stiff.',
				'Conversational.',
				'Loose, casual social media voice.'
			]),
			discussion_level: score('How much discussion would `text` invite from readers?', [
				'Invites almost no discussion.',
				'Leaves room for exchanging opinions.',
				'Strongly invites disagreement or debate.'
			]),
			is_surprising: noul('Would readers find the claim in `text` surprising or unexpected?', {
				true: 'The text presents something readers would find surprising.',
				false: 'No such element is present.'
			}),
			is_joke_like: noul('Does `text` read as a joke or bit?', {
				true: 'It has a punchline, exaggeration, wordplay, or aims for a laugh.',
				false: 'The text does not support that reading.'
			}),
			is_learning_or_discovery: noul(
				'Does `text` read as sharing a discovery or something learned?',
				{
					true: 'It shares knowledge, a realization, or a discovery.',
					false: 'The text does not support that reading.'
				}
			),
			invites_agreement: noul('Does `text` read as asking readers to relate or agree?', {
				true: 'It reads as inviting "same here" style agreement or empathy.',
				false: 'The text does not support that reading.'
			}),
			is_boastful: noul('Does `text` read as showing off?', {
				true: 'It reads as displaying the writer’s advantage, achievement, or possession.',
				false: 'The text does not read that way.'
			}),
			is_taunting: noul('Does `text` read as needling or provoking others?', {
				true: 'It reads as provoking, taunting, or looking down on someone.',
				false: 'The text does not support that reading.'
			}),
			is_reaction_bait: noul('Is `text` structured to invite replies, quotes, or reactions?', {
				true: 'It uses a question, exaggeration, punchline, or provocation that invites a response.',
				false: 'No such structure is present.'
			})
		},
		labels: {
			post_type: '投稿の主な型',
			casualness: 'カジュアル度',
			discussion_level: '議論性',
			is_surprising: '驚きとして読める？',
			is_joke_like: 'ネタとして読める？',
			is_learning_or_discovery: '学び・発見として読める？',
			invites_agreement: '共感を誘うように読める？',
			is_boastful: '自慢っぽく読める？',
			is_taunting: '煽りとして読める？',
			is_reaction_bait: '反応を誘う構造がある？'
		},
		scoreLabels: {
			casualness: ['形式的', '会話的', 'くだけた'],
			discussion_level: ['議論を招かない', '意見交換の余地あり', '議論を強く招く']
		},
		optionLabels: {
			post_type: {
				observation: '観察',
				humor: 'ネタ',
				learning: '学び',
				opinion: '意見',
				question: '質問',
				complaint: '愚痴',
				promotion: '告知',
				other: 'その他'
			}
		}
	};
}

// ---------------------------------------------------------------------------
// CITY
// ---------------------------------------------------------------------------

function cityCatalog(): QuestionCatalog {
	return {
		questions: {
			route_to: choice(
				'Which city department should look at this resident enquiry first? Judge only from `text`. Choose `other_or_unclear` when the text does not narrow it down.',
				routeCriteria()
			),
			request_category: choice(
				'Which category does this resident enquiry belong to?',
				categoryCriteria()
			),
			urgency: score(
				'How soon does this enquiry appear to need attention? This is a reading of the text, not a service level agreement.',
				[
					'Routine. No time pressure is expressed.',
					'Worth checking within a few days.',
					'Worth checking the same day.',
					'May involve an immediate risk to people or serious safety.'
				]
			),
			onsite_visit_likely: noul('Would someone likely need to inspect the site in person?', {
				true: 'Handling it likely requires checking the physical location, equipment, or condition.',
				false: 'It can likely be answered from the text alone.'
			}),
			human_review_likely: noul('Would a person likely need to review this before answering?', {
				true: 'It likely needs checking facts, eligibility, personal information, exceptions, or authority.',
				false: 'It does not involve those.'
			}),
			cross_department_likely: noul(
				'Would handling this likely involve more than one department or an outside body?',
				{
					true: 'It likely involves several departments, a branch office, the police, the prefecture, or the water utility.',
					false: 'A single department likely covers it.'
				}
			),
			location_information_missing: noul(
				'Is location information needed to route this, but missing from `text`?',
				{
					true: 'A town name, facility name, or address is needed to decide, and the text does not give one.',
					false: 'Location is given, or location is not needed.'
				}
			),
			emergency_signal: noul(
				'Does `text` explicitly describe an immediate emergency such as a fire, an accident, danger to a person, or a crime in progress?',
				{
					true: 'The text explicitly describes such immediacy.',
					false: 'No such explicit signal is present.'
				}
			)
		},
		labels: {
			route_to: '担当課の候補',
			request_category: '問い合わせカテゴリ',
			urgency: '緊急度',
			onsite_visit_likely: '現地確認が必要そう？',
			human_review_likely: '人による確認が必要そう？',
			cross_department_likely: '他課との連携がありそう？',
			location_information_missing: '場所の情報が足りない？',
			emergency_signal: '緊急性が明示されている？'
		},
		scoreLabels: {
			urgency: ['通常', '近日確認', '当日確認', '即時リスクの可能性']
		},
		optionLabels: {
			route_to: routeLabels(),
			request_category: categoryLabels()
		}
	};
}

// ---------------------------------------------------------------------------

export function buildCatalog(mode: Mode): QuestionCatalog {
	if (mode === 'love') return loveCatalog();
	if (mode === 'social') return socialCatalog();
	return cityCatalog();
}

export function buildState(mode: Mode, text: string): JudgeState {
	if (mode === 'city') return { mode, text, jurisdiction: jurisdictionName() };
	return { mode, text };
}
