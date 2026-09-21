/**
 * BATCH JUDGE のデータセット。
 *
 * 出所は docs/BATCH_JUDGE_DESIGN.md。短文を数十件まとめて判定し、人手で
 * 付けた正解ラベルとの一致を見る。**Jev自身の出力をgoldにしない。**
 */

/** 判定テーマ。軸の数が違うため、1リクエストの質問数も変わる。 */
export const BATCH_THEMES = ['privacy', 'deadline', 'dx'] as const;
export type BatchTheme = (typeof BATCH_THEMES)[number];

/**
 * PRIVACY の結論。
 *
 * 「個人情報です／違います」と断定しない。人が確認すべきかどうかだけを示す。
 *
 * **`safe` という語を使わない。** 安全の保証と読まれるためである。
 * `no_signal` が意味するのは次の一点だけである。
 *
 * > このモードが見る範囲で、明確な要確認シグナルが検出されなかった
 *
 * 次のいずれでもない。
 *
 * - 法的な「個人情報に該当しない」という判定
 * - Jev や他のAIサービスへ送ってよいという保証
 * - 組織の規程・契約・条例に照らした可否
 *
 * 見落としは起こる。実測では見逃し0だったが、それは50件のfixtureに対する
 * 値であり、一般の入力に対する保証ではない（docs/BATCH_JUDGE_DESIGN.md §3.1）。
 */
export const PRIVACY_VERDICTS = ['no_signal', 'review'] as const;
export type PrivacyVerdict = (typeof PRIVACY_VERDICTS)[number];

/**
 * DEADLINE の意味カテゴリ。厳密な日時ではなく、対応の緊急度を表す。
 *
 * 「9月25日17時まで」のような絶対日付は、**基準日が無ければどの区分にも
 * 決まらない。** 基準日はアプリが持つ Knowledge であり、Jev に推測させる
 * ものではない（docs/BATCH_JUDGE_DESIGN.md §9）。`BatchDataset.referenceDate`
 * で与える。
 */
export const DEADLINE_CLASSES = ['now', 'today', 'soon', 'later', 'none'] as const;
export type DeadlineClass = (typeof DEADLINE_CLASSES)[number];

/**
 * DX JUDGE の検討方向。
 *
 * 排他的な3択にする。当初は5つの独立Noulだったが、実測で軸が独立して
 * いなかった。goldが真の群と偽の群の平均差が0.06〜0.20しかなく、どの課題も
 * どの軸も「検討に値する」になっていた（docs/BATCH_JUDGE_DESIGN.md §4.6）。
 *
 * 「否」の受け皿として `neither` を置く。人・体制・制度の問題は、手を
 * 動かす前に別の議論が要る。**無理にBPRかデジタルへ寄せない。**
 */
export const DX_CLASSES = ['bpr', 'digital', 'neither'] as const;
export type DxClass = (typeof DX_CLASSES)[number];

/** 難易度。曖昧なケースを意図的に入れるため、評価時に分けて見る。 */
export type BatchDifficulty = 'easy' | 'medium' | 'hard';

type BaseCase = {
	/** 例: `privacy_001`。質問IDの対応表に使う安定ID。 */
	id: string;
	text: string;
	difficulty: BatchDifficulty;
	/** なぜそのラベルかの覚書。人手のラベルを後から読み返すために持つ。 */
	note?: string;
};

export type PrivacyCase = BaseCase & { gold: PrivacyVerdict };
export type DeadlineCase = BaseCase & { gold: DeadlineClass };
export type DxCase = BaseCase & { gold: DxClass };

export type BatchCase = PrivacyCase | DeadlineCase | DxCase;

/**
 * Jevへ送ってよい部分。
 *
 * **`gold` と `note` を送らない。** `gold` は答えそのもの、`note` は
 * 「属性の組み合わせで個人が絞られうる」のような根拠であり、どちらも
 * 渡せば一致率が測れなくなる。`difficulty` も人手の評価であって判断材料
 * ではない。
 *
 * `BatchCase` をそのまま state へ入れないこと。dataset を丸ごと渡す書き方に
 * 変えると静かに漏れるため、[batch-questions.spec.ts](../server/batch-questions.spec.ts)
 * で state の中身を検査している。
 */
export type BatchJevCase = Pick<BatchCase, 'id' | 'text'>;

export type BatchDataset = {
	schemaVersion: '1';
	theme: BatchTheme;
	/** 画面と評価に出す表示名。 */
	label: string;
	/**
	 * gold を決めた日。`YYYY-MM-DD`。
	 *
	 * DEADLINE では必須。これが無いと絶対日付の gold が再現しない。本番では
	 * 実行時の日付を state へ入れる。
	 */
	referenceDate?: string;
	cases: BatchCase[];
};

/**
 * 1事例ぶんの結果。
 *
 * `verdict` はテーマごとの結論で、PRIVACY は `no_signal` / `review`、
 * DEADLINE は `DEADLINE_CLASSES`、DX は `DX_CLASSES` の値をとる。
 *
 * `signals` は判定に使った確率をそのまま持つ。**閾値を変えるために再実行
 * しなくてよいようにする。** PRIVACY の `sensitive` のように判定には使わない
 * が理由として出すものも含む（docs/BATCH_JUDGE_DESIGN.md §3.1）。
 */
export type BatchJudgeResult = {
	caseId: string;
	verdict: string;
	signals: { key: string; probability: number }[];
	/** fixture を評価したときだけ入る。利用者の入力には gold が無い。 */
	gold?: string;
	agrees?: boolean;
};

/**
 * BATCH JUDGE のレスポンス。
 *
 * 既存の `JudgeResponse` と `usage` の形を揃える。新しい計測の仕組みを作らず、
 * LOVE / SOCIAL / CITY / SPEC FIND と横並びで比較できるようにする（§8）。
 *
 * `datasetFingerprint`、`caseCount`、`questionCount` を持つのは、**表示した
 * 数値がどのデータに対するものか後から辿れるようにする**ためである。fixture を
 * 1件でも直せば fingerprint が変わる。
 */
export type BatchJudgeResponse = {
	requestId: string;
	mode: 'batch';
	theme: BatchTheme;
	model: string;
	/** fixture の内容から計算する。手で書くバージョン番号は必ず古くなる。 */
	datasetFingerprint: string;
	/** DEADLINE のときだけ入る。判定の基準になった日（§3.2）。 */
	referenceDate?: string;
	caseCount: number;
	questionCount: number;
	latencyMs: number;
	usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
	results: BatchJudgeResult[];
};
