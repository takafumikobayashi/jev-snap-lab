/**
 * 入力PDFが、固定した出典と同じものかを確かめる。
 *
 * コーパスは「第2.7版の公式PDF」として題名・版・URLを固定で名乗り、PDL 1.0 の
 * 出典表示もその内容で組み立てる。別の版や無関係なPDFを渡しても、見出しの
 * 番号付けさえ合えば抽出は通ってしまう。**出来上がるのは、公式資料を名乗る
 * 別物**である。ハッシュを記録するだけでは防げないので、生成の前に照合する。
 */

/**
 * @typedef {object} PinnedSource
 * @property {string} title 表紙に現れる題名
 * @property {string} version 例: `2.7`
 * @property {string} contentHash 例: `sha256-…`
 */

/**
 * @param {{ contentHash: string, text: string, pinned: PinnedSource }} input
 * @returns {string[]} 問題の一覧。空なら固定した出典と一致する
 */
export function verifySource({ contentHash, text, pinned }) {
	const problems = [];

	if (contentHash !== pinned.contentHash) {
		problems.push(
			`content hash が固定値と違う\n    固定値: ${pinned.contentHash}\n    入力値: ${contentHash}`
		);
	}

	// ハッシュ違いだけでは「何を渡したのか」が分からない。表紙の題名と版を
	// 併せて見て、取り違えなのか改版なのかを切り分けられるようにする。
	const head = text.split('\f')[0]?.replace(/\s+/g, '') ?? '';
	if (!head.includes(pinned.title.replace(/\s+/g, ''))) {
		problems.push(`表紙に「${pinned.title}」が無い`);
	}

	const found = detectVersion(text);
	if (found !== pinned.version) {
		problems.push(`表紙の版が「${found ?? '読み取れない'}」で、固定値「${pinned.version}」と違う`);
	}

	return problems;
}

/** 表紙の「【第 2.7 版】」から版を読む。 */
export function detectVersion(text) {
	const head = text.split('\f')[0]?.replace(/\s+/g, '') ?? '';
	return head.match(/第([0-9]+\.[0-9]+)版/)?.[1] ?? null;
}
