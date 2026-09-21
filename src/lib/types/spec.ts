/**
 * SPEC FIND のデータセット。
 *
 * 出所は docs/SPEC_FIND_DESIGN.md の §4。判定対象の本文と出典メタデータを
 * 分離し、Jevへ渡すのは短い `text` と候補IDだけにする。画面に出すタイトル、
 * 章、ページ、URLはローカルデータからjoinする。
 */

export type SpecPassage = {
	/** 文書版を含めて安定化する。例: `common-2.7.euc.extract` */
	passageId: string;
	/** 所属文書。データセット内の `document.documentId` と一致する。 */
	documentId: string;
	/** 節番号。例: `2.2` */
	sectionId: string;
	/** 見出しの階層。画面のパンくずに使う。 */
	headingPath: string[];
	/** 検索・判定対象の本文。 */
	text: string;
	/** PDFページ。改版でずれるため補助情報に留める。 */
	page: number | null;
	/** 表示根拠の主。例: `§2.2 / 4.1.3` */
	sourceLocator: string;
	/**
	 * `text` が原文そのままか、抽出時に正規化したか。
	 *
	 * PDL 1.0 は加工物を無加工の政府資料として見せることを禁じる。真なら
	 * 出典表示に「加工して作成」を併記する（docs/SPEC_FIND_DESIGN.md §2）。
	 */
	normalized: boolean;
	tags: string[];
};

export type SpecDocument = {
	/** 例: `common-feature-2.7` */
	documentId: string;
	title: string;
	/** 例: `2.7` */
	version: string;
	publishedAt: string | null;
	retrievedAt: string;
	/** 公式PDFのURL。出典表示にそのまま使う。 */
	sourceUrl: string;
	/** 取得したPDFのhash。版の取り違えを検出する。 */
	contentHash: string;
};

/**
 * 実行時に読むデータセット。
 *
 * `document.passageIds` のような重複した索引は持たない。同じ事実を2箇所に
 * 持つと必ず片方が古くなる（CITYデータで同種の取りこぼしを経験している）。
 */
export type SpecCorpus = {
	schemaVersion: '1';
	document: SpecDocument;
	passages: SpecPassage[];
};
