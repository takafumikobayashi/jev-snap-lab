/**
 * 実在の自治体データから、公開用の架空データを生成する。
 *
 * 公開リポジトリと公開アプリには架空版だけを置く。実データと対応表は
 * .gitignore で除外しており、精度の検証は手元でのみ行う
 * （docs/CITY_DATA.md §10）。
 *
 *   node scripts/build-fictional-city.mjs \
 *     data/city/local-<source>.json scripts/city-name-map.local.json \
 *     data/city/fictional-m-city.json
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , sourcePath, mapPath, outPath] = process.argv;
if (!sourcePath || !mapPath || !outPath) {
	console.error('usage: build-fictional-city.mjs <source.json> <map.json> <out.json>');
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

writeFileSync(outPath, JSON.stringify(directory, null, '\t') + '\n');

// 置換対象そのものだけでなく、禁止語が部分文字列として残っていないかも
// 見る。県名を置換しても、その県名を含む団体名や事業名が残る、といった
// 取りこぼしを検出するため。
const json = JSON.stringify(directory);
const terms = [...new Set([...replacements.map(([from]) => from), ...(map.forbiddenTerms ?? [])])];
const leaked = terms.filter((term) => json.includes(term));
console.log(`organizations: ${directory.organizations.length}`);
console.log(
	`responsibilities: ${directory.organizations.reduce((n, o) => n + o.responsibilities.length, 0)}`
);
if (leaked.length === 0) {
	console.log('固有名詞の残存: なし');
} else {
	console.error(`固有名詞の残存: ${leaked.join(', ')}`);
	for (const term of leaked) {
		const at = json.indexOf(term);
		console.error(`  ${term}: …${json.slice(Math.max(0, at - 40), at + 40)}…`);
	}
}
process.exit(leaked.length === 0 ? 0 : 1);
