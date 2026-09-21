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
 */
export const PRIVACY_VERDICTS = ['safe', 'review'] as const;
export type PrivacyVerdict = (typeof PRIVACY_VERDICTS)[number];

/** DEADLINE の意味カテゴリ。厳密な日時ではなく、対応の緊急度を表す。 */
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

export type BatchDataset = {
	schemaVersion: '1';
	theme: BatchTheme;
	/** 画面と評価に出す表示名。 */
	label: string;
	cases: BatchCase[];
};
