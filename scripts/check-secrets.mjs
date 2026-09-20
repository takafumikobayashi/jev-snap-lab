/**
 * コミット対象に秘密情報が混ざっていないか検査する。
 *
 * 対応表を必要としないので CI で回せる（漏えい検査 check-no-leak.mjs は
 * 手元専用）。誤検知を避けるため、実際に危険なパターンだけを見る。
 *
 *   node scripts/check-secrets.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
	// 値の入った API キーらしき代入。.env.example のプレースホルダは除く。
	{
		name: 'API キーらしき値',
		re: /(?:api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_-]{24,}['"]/i
	},
	{ name: 'TypeSafe のキー形式', re: /\bapi-[A-Za-z0-9_-]{40,}\b/ },
	{ name: '秘密鍵', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
	{ name: 'AWS アクセスキー', re: /\bAKIA[0-9A-Z]{16}\b/ }
];

/** 検査から外す。パターンの定義そのものや、鍵を持たない生成物。 */
const EXCLUDE = [/^scripts\/check-secrets\.mjs$/, /^pnpm-lock\.yaml$/];

const files = execSync('git ls-files', { encoding: 'utf8' })
	.split('\n')
	.filter(Boolean)
	.filter((path) => !EXCLUDE.some((pattern) => pattern.test(path)));

const hits = [];
for (const path of files) {
	let content;
	try {
		content = readFileSync(path, 'utf8');
	} catch {
		continue;
	}
	for (const { name, re } of PATTERNS) {
		const match = content.match(re);
		// 値そのものは出力しない。場所と種別だけ報告する。
		if (match) hits.push(`${path}: ${name}`);
	}
}

if (hits.length > 0) {
	console.error(`秘密情報らしき記述: ${hits.length} 件`);
	for (const hit of hits) console.error(`  ${hit}`);
	process.exit(1);
}
console.log(`秘密情報の検査: ${files.length} ファイル、問題なし`);
