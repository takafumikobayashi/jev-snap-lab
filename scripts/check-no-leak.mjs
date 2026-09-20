/**
 * 公開物に実在の自治体を示す文字列が混入していないか検査する。
 *
 * 架空データの生成時だけでなく、**ビルド成果物とコミット対象**も見る。
 * `publicSummary` は Jev の criteria としてリクエストに載るため、漏れれば
 * 画面だけでなく上流 API にも渡る。
 *
 *   node scripts/check-no-leak.mjs scripts/city-name-map.local.json
 *
 * 対応表は手元にしか無いため、CI では実行できない。手元で公開前に回す。
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [, , mapPath] = process.argv;
if (!mapPath) {
	console.error('usage: check-no-leak.mjs <map.json>');
	process.exit(1);
}

const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const terms = [
	...new Set([...map.replacements.map(([from]) => from), ...(map.forbiddenTerms ?? [])])
];

/** 実データと対応表そのものは検査対象から外す。手元にしか無いため。 */
const EXCLUDE = [/\/data\/city\/local-/, /\.local\.json$/, /\/node_modules\//, /\/\.git\//];

function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (EXCLUDE.some((pattern) => pattern.test(path))) continue;
		if (statSync(path).isDirectory()) walk(path, out);
		else out.push(path);
	}
	return out;
}

const tracked = execSync('git ls-files', { encoding: 'utf8' })
	.split('\n')
	.filter(Boolean)
	.filter((path) => !EXCLUDE.some((pattern) => pattern.test(path)));

const targets = [
	['コミット対象', tracked],
	['ビルド成果物 (.vercel/output)', walk('.vercel/output')],
	['ビルド成果物 (.svelte-kit/output)', walk('.svelte-kit/output')]
];

let failed = false;
for (const [label, files] of targets) {
	const hits = [];
	for (const path of files) {
		let content;
		try {
			content = readFileSync(path, 'utf8');
		} catch {
			continue; // バイナリなどは読み飛ばす
		}
		for (const term of terms) {
			if (content.includes(term)) hits.push(`${path}: ${term}`);
		}
	}
	if (hits.length > 0) {
		failed = true;
		console.error(`\n${label}: ${hits.length} 件の漏えい`);
		for (const hit of hits.slice(0, 20)) console.error(`  ${hit}`);
	} else {
		console.log(`${label}: ${files.length} ファイル、漏えいなし`);
	}
}

process.exit(failed ? 1 : 0);
