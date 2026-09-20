import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('./build-fictional-city.mjs', import.meta.url).pathname;

/** @type {string} */
let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fictional-city-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * 最小のソース。`extra` を publicSummary へ足して未分類語を混ぜる。
 *
 * 自治体名は実在しない「甲市」を使う。実データの名前を書くと、この
 * フィクスチャ自体が漏えい検査に引っかかる（実際に一度引っかかった）。
 */
function source(extra = '') {
	return {
		schemaVersion: '1',
		jurisdiction: 'kou',
		displayName: '甲市',
		sourceIndex: [
			{
				sourceId: 's1',
				title: '組織一覧',
				url: 'https://example.test/a',
				sourceType: 'organization_page'
			}
		],
		organizations: [
			{
				organizationUnitId: 'sec.u1',
				section: '総務課',
				officialName: '甲市 総務部 総務課',
				publicSummary: `総務に関すること。${extra}`,
				responsibilities: [{ responsibilityId: 'r1', officialText: '総務に関すること。' }]
			}
		]
	};
}

const map = {
	displayName: { from: '甲市', to: 'M市' },
	replacements: [['甲市', 'M市']],
	// 「データ」はスクリプトが付ける notes 由来。カタカナ語の候補に当たる。
	allowGeneric: ['総務課', 'データ'],
	forbiddenTerms: []
};

function run(extra = '', overrides = {}) {
	const sourcePath = join(dir, 'source.json');
	const mapPath = join(dir, 'map.json');
	const outPath = join(dir, 'out.json');
	writeFileSync(sourcePath, JSON.stringify(source(extra)));
	writeFileSync(mapPath, JSON.stringify({ ...map, ...overrides }));
	let status = 0;
	try {
		execFileSync('node', [SCRIPT, sourcePath, mapPath, outPath], { stdio: 'pipe' });
	} catch (error) {
		status = error.status;
	}
	return { status, outPath };
}

describe('build-fictional-city', () => {
	it('元データのパスが無ければ usage を出して終了する', () => {
		// 既定値を持たせない。ファイル名に自治体名と施行日が入るため、
		// package.json へ書くとそれ自体がコミット対象への漏えいになる。
		let status = 0;
		let stderr = '';
		try {
			execFileSync('node', [SCRIPT], { stdio: 'pipe' });
		} catch (error) {
			status = error.status;
			stderr = String(error.stderr);
		}
		expect(status).toBe(1);
		expect(stderr).toContain('usage:');
		// 対応表と出力先は既定値を案内する。
		expect(stderr).toContain('scripts/city-name-map.local.json');
		expect(stderr).toContain('data/city/fictional-m-city.json');
	});

	it('検査を通れば出力する', () => {
		const { status, outPath } = run();
		expect(status).toBe(0);
		expect(JSON.parse(readFileSync(outPath, 'utf8')).fictional).toBe(true);
	});

	it('既知の名前と並んだ未分類の名前を見逃さない', () => {
		// 候補の正規表現は貪欲なので「甲市から未分類市」が丸ごと1件の
		// マッチになる。`candidate.includes('甲市')` で分類済みと見なすと
		// 未分類市 が素通りする（実際に再現した）。
		const { status, outPath } = run('甲市から未分類市との連絡調整に関すること。');
		expect(status).toBe(1);
		expect(existsSync(outPath)).toBe(false);
	});

	it('並んだ名前が両方とも分類済みなら通す', () => {
		// 厳しくしすぎて、正しく登録済みの組み合わせまで落とさないこと。
		const { status, outPath } = run('甲市から乙市との連絡調整に関すること。', {
			replacements: [
				['甲市', 'M市'],
				['乙市', 'N市']
			]
		});
		expect(status).toBe(0);
		expect(JSON.parse(readFileSync(outPath, 'utf8')).organizations[0].publicSummary).toContain(
			'M市からN市'
		);
	});

	it('置換後の名前に隠れた未分類の名前も見逃さない', () => {
		// 出力側の検査も includes では素通りする。置換後の名前を落とした
		// 残りかすを見る必要がある。
		const { status } = run('甲市と未分類町の連絡調整に関すること。');
		expect(status).toBe(1);
	});

	// 市町村県だけを終端にしていたため、特別区・府・道・郡の地名が
	// 素通りしていた（`新宿区` が公開データへ残ることを再現した）。
	it.each(['区', '都', '道', '府', '郡'])('%s で終わる地名も未分類として落とす', (suffix) => {
		const { status, outPath } = run(`未分類${suffix}との連絡調整に関すること。`);
		expect(status).toBe(1);
		expect(existsSync(outPath)).toBe(false);
	});

	it('一般語として登録済みなら通す', () => {
		// 下水道や財産区のような一般語も同じパターンに当たる。分類を
		// 要求するが、登録してあれば止めない。
		const { status } = run('公共下水道及び財産区に関すること。', {
			allowGeneric: ['総務課', 'データ', '公共下水道', '及び財産区']
		});
		expect(status).toBe(0);
	});

	it('未分類の固有名詞があれば出力先を書き換えない', () => {
		// 異常終了しても書き換えてしまうと、追跡対象の公開データに未検証の
		// 実在地名が残る。check-no-leak は対応表に載っている語しか見ないため、
		// 後段では拾えない。
		const sourcePath = join(dir, 'source.json');
		const mapPath = join(dir, 'map.json');
		const outPath = join(dir, 'out.json');
		writeFileSync(sourcePath, JSON.stringify(source('未分類市との連絡調整に関すること。')));
		writeFileSync(mapPath, JSON.stringify(map));
		writeFileSync(outPath, 'SENTINEL');

		let status = 0;
		try {
			execFileSync('node', [SCRIPT, sourcePath, mapPath, outPath], { stdio: 'pipe' });
		} catch (error) {
			status = error.status;
		}

		expect(status).toBe(1);
		expect(readFileSync(outPath, 'utf8')).toBe('SENTINEL');
	});

	it('失敗しても出力先を新規作成しない', () => {
		const sourcePath = join(dir, 'source.json');
		const mapPath = join(dir, 'map.json');
		const outPath = join(dir, 'out.json');
		writeFileSync(sourcePath, JSON.stringify(source('未分類市との連絡調整に関すること。')));
		writeFileSync(mapPath, JSON.stringify(map));

		try {
			execFileSync('node', [SCRIPT, sourcePath, mapPath, outPath], { stdio: 'pipe' });
		} catch {
			// 異常終了は想定どおり。
		}
		expect(existsSync(outPath)).toBe(false);
		// 一時ファイルも残さない。
		expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
	});
});
