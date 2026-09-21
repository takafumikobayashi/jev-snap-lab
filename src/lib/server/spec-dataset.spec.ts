import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { attributionFor, MAX_PASSAGES, validateCorpus } from './spec-corpus.server';
import { toSemanticCandidates } from './spec-evidence.server';
import { MAX_CANDIDATES_PER_REQUEST } from './semantic-match.server';

/** 実際に配布するコーパス。壊れていればここで落ちる。 */
const corpus = validateCorpus(
	JSON.parse(readFileSync('data/spec/common-feature-2.7.json', 'utf8')),
	{ allowedHosts: ['www.digital.go.jp'] }
);

describe('配布する SPEC コーパス', () => {
	it('固定した版を指している', () => {
		expect(corpus.document.version).toBe('2.7');
		expect(corpus.document.publishedAt).toBe('2026-02-27');
		expect(corpus.document.sourceUrl).toContain('digital.go.jp');
	});

	it('1リクエストに収まる件数である', () => {
		// 超えると分割呼び出しになり、latencyとtokenが増える。
		expect(corpus.passages.length).toBeLessThanOrEqual(MAX_CANDIDATES_PER_REQUEST);
		expect(corpus.passages.length).toBeLessThanOrEqual(MAX_PASSAGES);
		// 代表passageとして最低限の広さは要る。
		expect(corpus.passages.length).toBeGreaterThanOrEqual(20);
	});

	it('主要な機能領域をすべて含む', () => {
		// 章が欠けると、その領域の問い合わせが必ず abstain になる。
		const sections = corpus.passages.flatMap((p) => p.sectionId.split(', '));
		for (const required of ['1.3', '2.1.2', '2.2.5', '2.3.1', '2.4.1', '2.5.2', '2.6.1', '3.1']) {
			expect(sections, required).toContain(required);
		}
	});

	it('全passageが出典表示を組み立てられる', () => {
		for (const passage of corpus.passages) {
			const attribution = attributionFor(corpus.document, passage);
			expect(attribution).toContain('デジタル庁');
			expect(attribution).toContain(corpus.document.sourceUrl);
			// pdftotext の出力を畳んでいるため、v0のpassageはすべて加工物。
			expect(passage.normalized).toBe(true);
			expect(attribution).toContain('を加工して作成');
		}
	});

	it('Jevへ送る候補に出典メタデータが混ざらない', () => {
		const sent = JSON.stringify(toSemanticCandidates(corpus));
		expect(sent).not.toContain('digital.go.jp');
		expect(sent).not.toContain('sha256');
	});

	it('v0の対象外資料を含まない', () => {
		// 機能要件Excel、項目定義書、API仕様書は別データセットとして後から追加する。
		expect(corpus.document.sourceUrl).toMatch(/\.pdf$/i);
		expect(corpus.document.documentId).toBe('common-feature-2.7');
	});

	it('ページ番号が文書の印字ページに収まる', () => {
		for (const passage of corpus.passages) {
			expect(passage.page, passage.passageId).not.toBeNull();
			expect(passage.page).toBeGreaterThan(0);
			expect(passage.page).toBeLessThanOrEqual(56);
		}
	});
});
