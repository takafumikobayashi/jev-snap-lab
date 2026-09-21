/**
 * ドキュメントの参照が実態と合っているか検査する。
 *
 * 設計書はコードと一緒に古くなる。実際、匿名化の一括置換で存在しない
 * データファイル名を参照したまま気付かなかった。相互リンクとパス参照を
 * 機械的に確かめる。
 *
 *   node scripts/check-docs.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { globSync } from 'node:fs';

const DOC_FILES = [
	'README.md',
	'.env.example',
	...readdirSync('docs')
		.filter((f) => f.endsWith('.md'))
		.map((f) => `docs/${f}`)
];

/** 未実装だと分かる書き方をしてあるパスは、存在しなくてよい。 */
const PLANNED = /実装予定|未作成|Phase \d/;

/**
 * 手元専用として gitignore してあるファイルの命名規約。
 *
 * クリーンチェックアウトには存在しない。存在を要求すると CI が落ちるが、
 * 置き場所のディレクトリが消えた取りこぼしは検出したい。
 */
const LOCAL_ONLY = /(^|\/)local-|\.local\./;

const problems = [];

for (const file of DOC_FILES) {
	const content = readFileSync(file, 'utf8');
	const lines = content.split('\n');

	// 1. Markdown の相対リンクが実在するか。
	for (const match of content.matchAll(/\]\(([^)#:\s]+\.md)(#[^)]*)?\)/g)) {
		const target = normalize(join(dirname(file), match[1]));
		if (!existsSync(target)) problems.push(`${file}: リンク切れ ${match[1]}`);
	}

	// 2. static/ 配下のファイル名への言及が実在するか。
	//    拡張子を変えたとき、説明文やコメントが取り残されやすい。
	for (const [index, line] of lines.entries()) {
		for (const match of line.matchAll(
			/\/((?:og-image|favicon|robots)[A-Za-z0-9_-]*\.[a-z0-9]+)/g
		)) {
			if (existsSync(join('static', match[1]))) continue;
			problems.push(`${file}:${index + 1}: static に無いファイル ${match[1]}`);
		}
	}

	// 3. バッククォート内のリポジトリ相対パスが実在するか。
	for (const [index, line] of lines.entries()) {
		for (const match of line.matchAll(
			/`((?:src|data|scripts|static|e2e|docs)\/[A-Za-z0-9_./*-]+)`/g
		)) {
			const path = match[1];

			// 手元専用のファイルは実在を要求せず、置き場所だけ確認する。
			if (LOCAL_ONLY.test(path)) {
				const parent = dirname(path);
				if (!existsSync(parent)) {
					problems.push(`${file}:${index + 1}: 置き場所が無い ${parent}（${path}）`);
				}
				continue;
			}

			const found = path.includes('*') ? globSync(path).length > 0 : existsSync(path);
			if (found) continue;
			if (PLANNED.test(line)) continue;
			problems.push(`${file}:${index + 1}: 存在しないパス ${path}`);
		}
	}
}

// 4. 実装済みの機能を「未実装」と書いていないか。
//    ドキュメントとコードのずれは何度も踏んでいる。機能ごとに「実装されて
//    いれば必ず存在するファイル」を決め、それがあるのに未実装と書いてある
//    行を落とす。
const SHIPPED = [
	{ label: 'SPEC FIND', path: 'src/lib/server/spec-find.server.ts', pattern: /SPEC ?FIND/i },
	{
		label: 'CITY Semantic Fit',
		path: 'src/lib/server/city-semantic.server.ts',
		pattern: /Semantic Fit/
	}
];
const STALE = /未実装|設計段階|未着手|まだ作成していない/;

for (const file of DOC_FILES) {
	const lines = readFileSync(file, 'utf8').split('\n');
	for (const [index, line] of lines.entries()) {
		if (!STALE.test(line)) continue;
		for (const feature of SHIPPED) {
			if (!feature.pattern.test(line) || !existsSync(feature.path)) continue;
			problems.push(
				`${file}:${index + 1}: ${feature.label} は実装済みだが未実装と書いてある（${feature.path}）`
			);
		}
	}
}

if (problems.length > 0) {
	console.error(`ドキュメントの参照に問題があります: ${problems.length} 件`);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
console.log(`ドキュメントの参照: ${DOC_FILES.length} ファイル、問題なし`);
