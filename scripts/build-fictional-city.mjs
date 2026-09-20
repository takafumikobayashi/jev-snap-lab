/**
 * 実在の自治体データから、公開用の架空データを生成する。
 *
 * 公開リポジトリと公開アプリには架空版だけを置く。実データと対応表は
 * .gitignore で除外しており、精度の検証は手元でのみ行う
 * （docs/CITY_DATA.md §10）。
 *
 *   pnpm city:build data/city/local-<自治体>-<施行日>.json
 *
 * 対応表と出力先は既定値を使う。元データのパスだけ渡す。
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * 対応表と出力先は既定値を持つ。どちらも自治体を特定しない固定のパスで、
 * データ更新でも変わらない。
 *
 * 一方、元データのパスに既定値は置かない。ファイル名に自治体名と施行日が
 * 入るため、ここへ書くと package.json 経由で実在の自治体名がコミット対象へ
 * 載る（check-no-leak がそれを検出する）。更新のたびに名前も変わる。
 */
const DEFAULT_MAP = 'scripts/city-name-map.local.json';
const DEFAULT_OUT = 'data/city/fictional-m-city.json';

const [, , sourcePath, mapPath = DEFAULT_MAP, outPath = DEFAULT_OUT] = process.argv;
if (!sourcePath) {
	console.error('usage: build-fictional-city.mjs <source.json> [map.json] [out.json]');
	console.error(`  map の既定: ${DEFAULT_MAP}`);
	console.error(`  out の既定: ${DEFAULT_OUT}`);
	console.error('  元データは手元専用のため既定値を持たない（data/city/local-*.json）。');
	process.exit(1);
}

const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const map = JSON.parse(readFileSync(mapPath, 'utf8'));

/** 長い語から順に置換する。部分一致で短い語が先に当たるのを防ぐ。 */
const replacements = [...map.replacements].sort((a, b) => b[0].length - a[0].length);

function mask(value) {
	if (typeof value === 'string') {
		let out = value;
		for (const [from, to] of replacements) out = out.split(from).join(to);
		return out;
	}
	if (Array.isArray(value)) return value.map(mask);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
	}
	return value;
}

const directory = mask(source);

// 出典の URL は自治体を特定できるため落とす。根拠は条番号などの
// 内部参照だけにし、架空データであることを notes で明示する。
directory.sourceIndex = directory.sourceIndex.map((entry) => ({
	...entry,
	title:
		entry.sourceType === 'rule'
			? `${map.displayName.to}事務組織規程（架空）`
			: `${map.displayName.to}組織一覧（架空）`,
	url: null,
	notes: '実在の自治体の公開情報をもとに生成した架空データ。実在の条文ではない。'
}));

directory.fictional = true;

// 書き出しは全ての検査を通ってから行う（ファイル末尾）。ここで書くと、
// 未分類の固有名詞で異常終了しても追跡対象の公開データが上書きされる。

/**
 * 固有名詞になりうる文字列の候補を列挙する。
 *
 * 手書きの禁止語リストは「思い付かなかったもの」を素通しする。実際に
 * 漢字表記だけを登録していたため、ひらがな表記の地名と、別の実在自治体の
 * 名前が架空データへ残った。
 *
 * そこで元データから候補を機械的に列挙し、**すべてが分類済みであること**を
 * 要求する。分類は対応表の replacements（置換する＝識別情報）か
 * allowGeneric（一般語＝残してよい）のどちらかに入れる。未分類が1件でも
 * あれば異常終了するので、データ更新で新しい固有名詞が入っても気付ける。
 */
const CANDIDATE_PATTERNS = [
	// 地名。「◯◯市」「◯◯県」など。
	/[^\s、。・()（）「」]{1,8}[市町村県]/g,
	// 団体名。
	/[^\s、。・()（）「」]{2,12}(?:組合|協議会|事業団|企業団|連合会|機構|公社|財団|株式会社)/g,
	// カタカナ語。固有名詞が混じる。
	/[ァ-ヴ][ァ-ヴー]{2,}/g,
	// 数字を含む名称。「◯◯21」のような事業名。
	/[ぁ-んァ-ヴ一-龯][^\s、。・()（）「」]{1,10}[0-9０-９]+/g
];

function extractCandidates(value, into = new Set()) {
	if (typeof value === 'string') {
		for (const pattern of CANDIDATE_PATTERNS) {
			for (const match of value.matchAll(pattern)) into.add(match[0]);
		}
	} else if (Array.isArray(value)) {
		for (const item of value) extractCandidates(item, into);
	} else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) extractCandidates(item, into);
	}
	return into;
}

const allowGeneric = new Set(map.allowGeneric ?? []);
const froms = replacements.map(([from]) => from);
/** 長い語から順に落とす。短い語が先に当たって残りを取りこぼすのを防ぐ。 */
const tos = replacements.map(([, to]) => to).sort((a, b) => b.length - a.length);

/**
 * 既知の語を空白へ落とす。
 *
 * 候補の判定に `candidate.includes(known)` を使ってはいけない。候補の正規表現は
 * 貪欲なので、1つのマッチが複数の固有名詞をまたぐ。`青空市から未分類市` は
 * 丸ごと1件のマッチになり、既知の `青空市` を含むという理由で分類済みと
 * 見なされて `未分類市` が素通りしていた（実際に再現した）。
 *
 * 既知の語を先に消し、**残りかす**から候補を拾い直す。空白は候補パターンの
 * 文字クラスから除外されているため、語の区切りとして働く。
 */
function blank(value, terms) {
	if (typeof value === 'string') {
		let out = value;
		for (const term of terms) out = out.split(term).join(' ');
		return out;
	}
	if (Array.isArray(value)) return value.map((item) => blank(item, terms));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blank(v, terms)]));
	}
	return value;
}

// 1. 元データの候補がすべて分類済みか。置換対象を落とした残りを見る。
const unclassified = [...extractCandidates(blank(source, froms))]
	.filter((candidate) => !allowGeneric.has(candidate))
	.sort();

// 2. 出力に置換対象が残っていないか。
const json = JSON.stringify(directory);
const leaked = [...new Set([...froms, ...(map.forbiddenTerms ?? [])])].filter((term) =>
	json.includes(term)
);

// 3. 出力側の候補も分類済みか（置換で生じた新しい名称を拾う）。
//    置換後の名前を落とした残りを見る。ここも includes では素通りする。
const outputUnknown = [...extractCandidates(blank(directory, tos))]
	.filter((candidate) => !allowGeneric.has(candidate))
	.sort();

console.log(`organizations: ${directory.organizations.length}`);
console.log(
	`responsibilities: ${directory.organizations.reduce((n, o) => n + o.responsibilities.length, 0)}`
);

let failed = false;
const report = (label, items, hint) => {
	if (items.length === 0) return;
	failed = true;
	console.error(`\n${label}: ${items.length} 件`);
	for (const item of items) console.error(`  ${item}`);
	console.error(hint);
};

report(
	'未分類の候補（元データ）',
	unclassified,
	'→ 識別情報なら replacements へ、一般語なら allowGeneric へ追加すること。'
);
report('置換対象の残存（出力）', leaked, '→ replacements の指定を見直すこと。');
report(
	'未分類の候補（出力）',
	outputUnknown,
	'→ 置換後に残った名称。allowGeneric か replacements へ追加すること。'
);

if (failed) {
	// 出力先には触れない。未検証のデータを公開用ファイルへ残さないため。
	// check-no-leak は対応表に載っている語しか見ないので、未分類語は
	// 後段では拾えない。ここで止めるのが唯一の砦になる。
	console.error(`\n${outPath} は更新しなかった。`);
	process.exit(1);
}

console.log('固有名詞の検査: すべて分類済み・残存なし');

// 同じディレクトリへ一時ファイルを書いてから rename する。書き込み途中で
// 落ちても、中途半端な公開データが残らない。
const tmpPath = `${outPath}.tmp-${process.pid}`;
try {
	writeFileSync(tmpPath, JSON.stringify(directory, null, '\t') + '\n');
	renameSync(tmpPath, outPath);
} catch (error) {
	rmSync(tmpPath, { force: true });
	throw error;
}
console.log(`${outPath} を更新した。`);
