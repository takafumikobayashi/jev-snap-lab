/**
 * デジタル庁の公式PDFから SPEC FIND のコーパスを作る。
 *
 *   pnpm spec:build <path/to/common-2.7.pdf>
 *
 * PDF本体はリポジトリへ置かない（1.6MBあり、公式URLから常に取得できる）。
 * 手元でPDFを取得してこのスクリプトへ渡す。出力のJSONだけをコミットする。
 *
 * 全ての検査を通ってから出力する。city:build と同じ理由で、途中で失敗した
 * 未検証のデータを追跡対象のファイルへ書かない。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { verifySource } from './lib/spec-source.mjs';
// 検証はアプリと同じ実装を使う。スクリプト側へ写すと必ず片方が古くなる。
// 型だけのimportなので、Nodeの型ストリップでそのまま読める。
import {
	validateCorpus,
	MAX_CORPUS_CHARS,
	MAX_PASSAGE_CHARS,
	stateCharsOf
} from '../src/lib/server/spec-corpus.server.ts';

const DEFAULT_OUT = 'data/spec/common-feature-2.7.json';

const [, , pdfPath, outPath = DEFAULT_OUT] = process.argv;
if (!pdfPath) {
	console.error('usage: build-spec-corpus.mjs <spec.pdf> [out.json]');
	console.error(`  out の既定: ${DEFAULT_OUT}`);
	console.error('  PDF はリポジトリに置かないため既定値を持たない。公式URLから取得して渡すこと。');
	process.exit(1);
}
if (!existsSync(pdfPath)) {
	console.error(`PDF が見つからない: ${pdfPath}`);
	process.exit(1);
}

/** 固定して扱う版。別の文書を誤って取り込まないための錠。 */
const DOCUMENT = {
	documentId: 'common-feature-2.7',
	title: '地方公共団体情報システム共通機能標準仕様書',
	version: '2.7',
	publishedAt: '2026-02-27',
	/**
	 * 固定した公式PDFの content hash。
	 *
	 * 別のPDFを渡してもこのメタデータで名乗ってしまうため、生成の前に照合する。
	 * 改版で差し替えるときは、公式ページで版・公開日・URLを確認したうえで、
	 * この値と `version` / `publishedAt` / `sourceUrl` を同時に更新する。
	 */
	contentHash: 'sha256-41d7fe7a96d5bcee527bd7caa21ac565a21d8d98a9fdc72431171ec93fad346d',
	sourceUrl:
		'https://www.digital.go.jp/assets/contents/node/basic_page/field_ref_resources/4d056a04-6eba-4109-9850-a786d3e71971/023dffea/20260227_policies_local_governments_common_02.pdf'
};

/** 表紙と目次。本文はここから後ろ。 */
const FRONT_MATTER_PAGES = 3;
/** 印字ページ番号 = 物理ページ - この値。 */
const PAGE_OFFSET = 3;
/** これを超える節は2つ目のpassageを作る。 */
const LONG_SECTION_CHARS = 2000;
/** 「別紙1のとおり」の一文だけかどうかの目安。 */
const BOILERPLATE_CHARS = 100;

const HEADING = /^\s*(\d+(?:\.\d+){0,2})\.\s+(\S.*)$/;
/** 章見出し（`1.` など）は本文中の番号付き箇条書きと紛れる。短い行だけ拾う。 */
const CHAPTER_TITLE_MAX = 30;

const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], {
	encoding: 'utf8',
	maxBuffer: 64 * 1024 * 1024
});
const pages = text.split('\f');
const contentHash = `sha256-${createHash('sha256').update(readFileSync(pdfPath)).digest('hex')}`;

// 固定した出典と同じPDFか、抽出の前に確かめる。
const mismatches = verifySource({ contentHash, text, pinned: DOCUMENT });
if (mismatches.length > 0) {
	console.error('入力PDFが固定した出典と一致しない:');
	for (const problem of mismatches) console.error(`  - ${problem}`);
	console.error('\n公式ページで版・公開日・URLを確認し、');
	console.error('scripts/build-spec-corpus.mjs の DOCUMENT を更新してから実行すること。');
	console.error(`${outPath} は更新しなかった。`);
	process.exit(1);
}

// --- 見出しを拾う ---
const sections = [];
pages.forEach((page, i) => {
	if (i < FRONT_MATTER_PAGES) return;
	page.split('\n').forEach((line, at) => {
		const match = line.match(HEADING);
		// 目次行はリーダー（...）を持つ。
		if (!match || line.includes('...')) return;
		// 章見出しは短い。長ければ本文中の箇条書きなので拾わない。
		if (!match[1].includes('.') && match[2].trim().length > CHAPTER_TITLE_MAX) return;
		sections.push({
			number: match[1],
			title: normalizeInline(match[2]),
			page: i + 1,
			at,
			lines: []
		});
	});
});

// --- 各見出しの本文を集める ---
let cursor = 0;
pages.forEach((page, i) => {
	if (i < FRONT_MATTER_PAGES) return;
	page.split('\n').forEach((line, at) => {
		while (
			cursor + 1 < sections.length &&
			(sections[cursor + 1].page < i + 1 ||
				(sections[cursor + 1].page === i + 1 && sections[cursor + 1].at <= at))
		) {
			cursor += 1;
		}
		const current = sections[cursor];
		if (current && (i + 1 > current.page || at > current.at)) current.lines.push(line);
	});
});

for (const section of sections) section.body = cleanBody(section.lines);

// --- passage を組み立てる ---
const passages = [];
const merged = [];

for (const section of sections) {
	// 章見出し（2.1 など）は直後に項が続くだけで本文を持たない。
	if (section.body.length === 0) continue;

	// 「求められる機能」の節は「別紙1_機能要件のとおりである」の一文だけのものが
	// 多く、6件並べても候補が薄まる。定型文だけの節を1件へまとめる。
	// §2.6.3 のように帳票要件などを追記している節は、独立したpassageとして残す。
	if (/求められる機能$/.test(section.title) && section.body.length < BOILERPLATE_CHARS) {
		merged.push(section);
		continue;
	}

	for (const [at, chunk] of chunksOf(section).entries()) {
		passages.push(makePassage(section, chunk, at));
	}
}

if (merged.length > 0) {
	passages.push({
		passageId: `${DOCUMENT.documentId}.required-functions`,
		documentId: DOCUMENT.documentId,
		sectionId: merged.map((s) => s.number).join(', '),
		headingPath: ['共通機能の要件の標準について', '各機能に求められる機能'],
		text: `各共通機能の具体的な機能要件は、本文ではなく別紙「別紙1_機能要件」に定められている。対象は${merged
			.map((s) => s.title.replace(/に求められる機能$/, ''))
			.join('、')}。`,
		// 統合した節は別々のページにある。1つを代表に選ぶと、他のどれが
		// 当たっても同じページを引用として示すことになる。ページは持たせず、
		// locator に全節を並べる。
		page: null,
		sourceLocator: `§${merged.map((s) => s.number).join(' / §')}`,
		normalized: true,
		tags: ['機能要件', '別紙']
	});
}

// --- 検査してから書く ---
const corpus = {
	schemaVersion: '1',
	document: { ...DOCUMENT, retrievedAt: today(), contentHash },
	passages
};

console.log(`見出し ${sections.length} 件 -> passage ${passages.length} 件`);
const stateChars = passages.reduce((n, p) => n + stateCharsOf(p), 0);
console.log(
	`state の文字数 ${stateChars} / 上限 ${MAX_CORPUS_CHARS}（${Math.round((stateChars / MAX_CORPUS_CHARS) * 100)}%）`
);

try {
	validateCorpus(corpus, { allowedHosts: ['www.digital.go.jp'] });
} catch (error) {
	console.error(`\n検査に失敗した: ${error.message}`);
	console.error(`${outPath} は更新しなかった。`);
	process.exit(1);
}
console.log('コーパスの検査: 問題なし');

const tmpPath = `${outPath}.tmp-${process.pid}`;
try {
	writeFileSync(tmpPath, `${JSON.stringify(corpus, null, '\t')}\n`);
	renameSync(tmpPath, outPath);
} catch (error) {
	rmSync(tmpPath, { force: true });
	throw error;
}
console.log(`${outPath} を更新した。`);

// ---------------------------------------------------------------------------

function normalizeInline(value) {
	return value.replace(/\s+/g, ' ').trim();
}

/**
 * ページ番号だけの行と空行を落とし、1行へ畳む。
 *
 * PDFの改行は版面の都合であって文の区切りではない。畳んだ時点で加工物に
 * あたるため、passageは `normalized: true` になる（PDL 1.0）。
 */
function cleanBody(lines) {
	return (
		lines
			.filter((line) => !/^\s*\d{1,3}\s*$/.test(line))
			.map((line) => line.replace(/\s+/g, ' ').trim())
			.filter(Boolean)
			// 日本語の行は空白なしで繋ぐが、箇条書きの記号だけは前に空白を入れる。
			// 入れないと「認証方式client_secret_jwt」のように見出しと地の文が
			// くっつき、抜粋としても読みにくい。
			.map((line, at) => (at > 0 && /^[（(]?[0-9０-９①-⑳][)）]?/.test(line) ? ` ${line}` : line))
			.join('')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/**
 * 節から抜粋を切り出す。
 *
 * v0は全文検索ではなく代表passageの索引である。長い節は先頭の抜粋で代表し、
 * 続きは `sourceLocator` を辿って原文で読む前提にする。2,000字を超える節
 * だけ、2つ目の抜粋を作る。
 */
function chunksOf(section) {
	const first = cutAtSentence(section.body, MAX_PASSAGE_CHARS);
	if (section.body.length <= LONG_SECTION_CHARS) return [first];
	const rest = section.body.slice(first.length);
	return [first, cutAtSentence(rest, MAX_PASSAGE_CHARS)];
}

/** 上限以内で、最後の句点までを返す。文の途中で切らない。 */
function cutAtSentence(body, limit) {
	if (body.length <= limit) return body;
	const window = body.slice(0, limit);
	const at = window.lastIndexOf('。');
	return at > limit / 2 ? window.slice(0, at + 1) : window;
}

function makePassage(section, chunk, at) {
	const suffix = at === 0 ? '' : `-${at + 1}`;
	return {
		passageId: `${DOCUMENT.documentId}.s${section.number.replace(/\./g, '-')}${suffix}`,
		documentId: DOCUMENT.documentId,
		sectionId: section.number,
		headingPath: headingPathFor(section),
		text: chunk,
		page: section.page - PAGE_OFFSET,
		sourceLocator: `§${section.number}${suffix ? `（${at + 1}つ目の抜粋）` : ''}`,
		// pdftotext の出力を1行へ畳んでいる。原文そのままではない。
		normalized: true,
		tags: []
	};
}

/** 上位の見出しを辿ってパンくずにする。 */
function headingPathFor(section) {
	const path = [];
	const parts = section.number.split('.');
	for (let depth = 1; depth < parts.length; depth += 1) {
		const prefix = parts.slice(0, depth).join('.');
		const parent = sections.find((s) => s.number === prefix);
		if (parent) path.push(parent.title);
	}
	path.push(section.title);
	return path;
}

function today() {
	return new Date().toISOString().slice(0, 10);
}
