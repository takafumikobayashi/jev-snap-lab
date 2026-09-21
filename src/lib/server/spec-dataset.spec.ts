import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	attributionFor,
	MAX_CORPUS_CHARS,
	MAX_PASSAGE_CHARS,
	MAX_PASSAGES,
	stateCharsOf,
	validateCorpus
} from './spec-corpus.server';
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

	it('トークン予算に余裕がある', () => {
		// state は候補の文字数に比例する。Jev の制限は state と最長の質問で
		// 32k tokens（docs/IMPLEMENTATION_PLAN.md §8.1）。上限いっぱいで
		// 配布すると、次にpassageを足したときに黙って予算を超える。
		const total = corpus.passages.reduce((sum, p) => sum + stateCharsOf(p), 0);
		expect(total).toBeLessThanOrEqual(MAX_CORPUS_CHARS);
		expect(total / MAX_CORPUS_CHARS).toBeLessThan(0.9);
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
			if (passage.page === null) continue;
			expect(passage.page, passage.passageId).toBeGreaterThan(0);
			// 印字ページの最終は56。物理ページ（59）を入れてしまう取り違えを弾く。
			expect(passage.page, passage.passageId).toBeLessThanOrEqual(56);
		}
	});

	it('括弧が閉じている', () => {
		// 仕様書には「◯◯（……をいう。以下同じ。）」という定義が多い。括弧内の
		// 句点で切ると閉じ括弧と後続が失われ、Jevへ渡す候補としても抜粋
		// としても壊れる。
		for (const passage of corpus.passages) {
			const open = (passage.text.match(/[（(]/g) ?? []).length;
			const close = (passage.text.match(/[）)]/g) ?? []).length;
			expect(open, `${passage.passageId} の括弧が閉じていない`).toBe(close);
		}
	});

	it('上限ちょうどで打ち切られた抜粋が無い', () => {
		// 区切りが見つからず上限で強制的に切ると、項目や文の途中で終わる。
		for (const passage of corpus.passages) {
			expect(passage.text.length, passage.passageId).toBeLessThan(MAX_PASSAGE_CHARS);
		}
	});

	it('本文に節見出しが混ざらない', () => {
		// 見出しの収集と本文の収集がずれると、次の節の見出しが前の節の本文
		// 末尾へ入る。抜粋としても、Jevへ渡す候補としても壊れる。
		for (const passage of corpus.passages) {
			expect(passage.text, passage.passageId).not.toMatch(/\d+\.\d+\.\s/);
		}
	});

	it('折り返した見出しをつないで持つ', () => {
		// §1.5 は版面の幅で見出しが折り返される。つないでおかないと、
		// パンくずが「…共通機能の関」で切れ、続きの「係性」が本文の先頭へ混ざる。
		const wrapped = corpus.passages.find((passage) => passage.sectionId === '1.5');
		expect(wrapped).toBeDefined();
		expect(wrapped?.headingPath.at(-1)).toBe(
			'標準準拠システム以外のシステムと本仕様書が対象とする共通機能の関係性'
		);
		expect(wrapped?.text.startsWith('標準準拠システム以外のシステムが')).toBe(true);
	});

	it('見出しが連体修飾で終わらない', () => {
		// 折り返しを取りこぼすと、見出しが文の途中で切れる。
		// 「◯◯とは」は正当な見出しなので対象外にする。
		for (const passage of corpus.passages) {
			const heading = passage.headingPath.at(-1) ?? '';
			if (heading.endsWith('とは')) continue;
			expect(heading, passage.passageId).not.toMatch(/[のへをがはでや]$/);
		}
	});

	it('複数の節をまとめたpassageはページを持たない', () => {
		// 統合元は別々のページにある。1つを代表に選ぶと、どれが当たっても
		// 同じページを引用として示すことになる。locator に全節を並べる。
		const merged = corpus.passages.filter((passage) => passage.sectionId.includes(','));
		expect(merged.length).toBeGreaterThan(0);
		for (const passage of merged) {
			expect(passage.page, passage.passageId).toBeNull();
			for (const sectionId of passage.sectionId.split(', ')) {
				expect(passage.sourceLocator).toContain(`§${sectionId}`);
			}
		}
	});
});
