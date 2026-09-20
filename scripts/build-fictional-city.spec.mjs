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

function run(extra = '') {
	const sourcePath = join(dir, 'source.json');
	const mapPath = join(dir, 'map.json');
	const outPath = join(dir, 'out.json');
	writeFileSync(sourcePath, JSON.stringify(source(extra)));
	writeFileSync(mapPath, JSON.stringify(map));
	let status = 0;
	try {
		execFileSync('node', [SCRIPT, sourcePath, mapPath, outPath], { stdio: 'pipe' });
	} catch (error) {
		status = error.status;
	}
	return { status, outPath };
}

describe('build-fictional-city', () => {
	it('検査を通れば出力する', () => {
		const { status, outPath } = run();
		expect(status).toBe(0);
		expect(JSON.parse(readFileSync(outPath, 'utf8')).fictional).toBe(true);
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
