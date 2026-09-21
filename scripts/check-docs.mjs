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
//
//    段階は2つある。**途中まで進んだ機能を一括で「実装済み」とは言えない。**
//    BATCH JUDGE は schema と fixture があるがJev呼び出しとUIが無い。この
//    状態で「Jev呼び出しは未実装」と書くのは正しく、「着手前」と書くのは
//    誤りである。marker を分けて、落とす語も分ける。
const SHIPPED = [
	// v1 は既存モードの拡張で、まだ着手前である。v0 と同じ語なので除く。
	{
		label: 'SPEC FIND',
		path: 'src/lib/server/spec-find.server.ts',
		pattern: /SPEC ?FIND(?! ?v1)/i
	},
	{
		label: 'CITY Semantic Fit',
		path: 'src/lib/server/city-semantic.server.ts',
		pattern: /Semantic Fit/
	}
];
const STALE = /未実装|設計段階|未着手|着手前|まだ作成していない/;

/** 着手済み。全体が未実装ではないので、「着手前」とだけ書けない。 */
const STARTED = [{ label: 'BATCH JUDGE', path: 'data/batch', pattern: /BATCH ?JUDGE/i }];
const NOT_STARTED = /未着手|着手前|まだ作成していない/;

/**
 * 機能名が同じ行に無くても拾う。
 *
 * PRODUCT_SPEC.md が「どちらも着手前。」と書き、機能名は次のコードブロック
 * にあった。行だけを見る検査はこれを通してしまう。前後の行も見る。
 */
const CONTEXT_LINES = 6;
function nearby(lines, index) {
	return lines.slice(Math.max(0, index - CONTEXT_LINES), index + CONTEXT_LINES + 1).join('\n');
}

for (const file of DOC_FILES) {
	const lines = readFileSync(file, 'utf8').split('\n');
	for (const [index, line] of lines.entries()) {
		const around = nearby(lines, index);
		for (const feature of SHIPPED) {
			// こちらは行だけを見る。窓にすると「SPEC FIND v1 は着手前」の近くの
			// 「SPEC FIND」を拾って誤検知する。
			if (!STALE.test(line) || !feature.pattern.test(line) || !existsSync(feature.path)) continue;
			problems.push(
				`${file}:${index + 1}: ${feature.label} は実装済みだが未実装と書いてある（${feature.path}）`
			);
		}
		for (const feature of STARTED) {
			if (!NOT_STARTED.test(line) || !feature.pattern.test(around) || !existsSync(feature.path)) {
				continue;
			}
			// 何が未実装かを書き分けている行は落とさない。
			if (/一部実装|schema|fixture|UI|経路/.test(around)) continue;
			problems.push(
				`${file}:${index + 1}: ${feature.label} は着手済みだが着手前と書いてある（${feature.path}）。` +
					`何が未実装かを書き分けること`
			);
		}
	}
}

// 5. 採用をやめた方式を、今の方式のように書いていないか。
//    設計変更のあとに古い記述が残るのを何度も踏んでいる。DX JUDGE は
//    5つの独立Noulから3択のChoiceへ変えた。履歴として書くのは正しく、
//    今の方式として書くのは誤りである。
const RETIRED = [
	{
		label: 'DX JUDGE の5軸版',
		// 実装が3択であることの目印。Choice が消えたら検査を見直す。
		marker: 'src/lib/server/batch-questions.server.ts',
		markerPattern: /DX_AXES[\s\S]{0,200}key: 'first_move'/,
		claim: /DX[^。\n]*(複数Noul|独立Noul|5軸|5つの軸)|DX は 50件 × 5軸/,
		// 履歴として書いている行は落とさない。
		historical: /5軸版|当初|当時|以前|やめ|変えた|作り直|採用前|旧|§3\.3/
	}
];
for (const entry of RETIRED) {
	if (!existsSync(entry.marker)) continue;
	if (!entry.markerPattern.test(readFileSync(entry.marker, 'utf8'))) continue;
	for (const file of [...DOC_FILES, 'README.md']) {
		if (!existsSync(file)) continue;
		for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
			if (!entry.claim.test(line) || entry.historical.test(line)) continue;
			problems.push(
				`${file}:${index + 1}: ${entry.label} は採用していないが、今の方式のように書いてある`
			);
		}
	}
}

// 5. 未確認の gold を「人手で付けた正解ラベル」と書いていないか。
//    確認状態は data/batch/*.json の `labelStatus` が持つ。文章で状態を
//    書くと必ずデータと食い違う。実際に README・ARCHITECTURE・
//    IMPLEMENTATION_PLAN の3箇所が古いまま残っていた。
const BATCH_FIXTURES = ['privacy', 'deadline', 'dx'].map((theme) => `data/batch/${theme}.json`);
const unreviewed = BATCH_FIXTURES.filter(
	(file) => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).labelStatus !== 'reviewed'
);
if (unreviewed.length > 0) {
	const CLAIMS_HUMAN = /人手で(付け|作っ)た?[^。]*正解ラベル|人手で付けた正解/;
	const ABOUT_BATCH = /BATCH ?JUDGE|data\/batch|batch\/\*\.json/i;
	for (const file of [...DOC_FILES, 'README.md']) {
		if (!existsSync(file)) continue;
		for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
			if (!CLAIMS_HUMAN.test(line) || !ABOUT_BATCH.test(line)) continue;
			// 状態そのものを説明している行は除く。
			if (/暫定|確認前|labelStatus|draft/.test(line)) continue;
			problems.push(
				`${file}:${index + 1}: gold は未確認（${unreviewed.join(', ')} が draft）だが、` +
					`人手で付けた正解ラベルと書いてある`
			);
		}
	}
}

// 5. 配布コーパスの文字数が、ドキュメントの記述と合っているか。
//    コーパスを作り直すと文字数が変わる。`MAX_CORPUS_CHARS` の根拠は
//    「文字あたり何 state token か」なので、**根拠の数値だけが古くなる。**
//    実際に15,317字と書いたまま15,612字になっていた。
const CORPUS_FILE = 'data/spec/common-feature-2.7.json';
if (existsSync(CORPUS_FILE)) {
	const corpus = JSON.parse(readFileSync(CORPUS_FILE, 'utf8'));
	// `stateCharsOf` と同じ数え方。code point で数える。
	const chars = corpus.passages.reduce(
		(sum, passage) => sum + [...passage.text].length + [...passage.headingPath.join(' / ')].length,
		0
	);
	const printed = chars.toLocaleString('en-US');
	// 「15,612字」のような書き方を拾い、実際と違うものを落とす。
	const pattern = /(\d{1,3}(?:,\d{3})+)\s*字/g;
	for (const file of [...DOC_FILES, 'src/lib/server/spec-corpus.server.ts']) {
		if (!existsSync(file)) continue;
		const lines = readFileSync(file, 'utf8').split('\n');
		for (const [index, line] of lines.entries()) {
			if (!/配布コーパス|現在の配布/.test(line)) continue;
			for (const [, found] of line.matchAll(pattern)) {
				if (found === printed) continue;
				problems.push(
					`${file}:${index + 1}: 配布コーパスの文字数が ${found} 字と書いてあるが、実際は ${printed} 字`
				);
			}
		}
	}
}

// 5. 必要な Node のバージョンが package.json と食い違っていないか。
//    1箇所だけ直して他が残るのを何度も踏んだ。宣言は engines が唯一の
//    情報源で、ドキュメントはそれに追随する。
const required = JSON.parse(readFileSync('package.json', 'utf8')).engines?.node ?? '';
const requiredVersion = required.replace(/^[^0-9]*/, '');

for (const file of DOC_FILES) {
	const lines = readFileSync(file, 'utf8').split('\n');
	for (const [index, line] of lines.entries()) {
		// 「Node.js 22.12 以上」のように前提として述べている箇所だけ見る。
		for (const match of line.matchAll(/Node(?:\.js)? ?([0-9]+(?:\.[0-9]+)*) ?以上/g)) {
			if (match[1] === requiredVersion) continue;
			problems.push(
				`${file}:${index + 1}: 必要な Node が ${match[1]} 以上と書いてあるが、engines は ${required}`
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
