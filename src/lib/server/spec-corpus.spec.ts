import { describe, expect, it } from 'vitest';
import {
	attributionFor,
	MAX_PASSAGE_CHARS,
	MAX_PASSAGES,
	validateCorpus
} from './spec-corpus.server';
import type { SpecDocument, SpecPassage } from '$lib/types/spec';

const HOSTS = { allowedHosts: ['www.digital.go.jp'] };

function passage(n: number): Record<string, unknown> {
	return {
		passageId: `common-2.7.p${n}`,
		documentId: 'common-feature-2.7',
		sectionId: `2.${n}`,
		headingPath: ['EUC機能', 'データ抽出'],
		text: `データを抽出し職員が利用可能な形式で出力できること（${n}）。`,
		page: 12 + n,
		sourceLocator: `§2.${n}`,
		normalized: false,
		tags: []
	};
}

function valid(count = 2): Record<string, unknown> {
	return {
		schemaVersion: '1',
		document: {
			documentId: 'common-feature-2.7',
			title: '地方公共団体情報システム共通機能標準仕様書',
			version: '2.7',
			publishedAt: '2026-02-27',
			retrievedAt: '2026-09-21',
			sourceUrl: 'https://www.digital.go.jp/assets/spec.pdf',
			contentHash: 'sha256-abc'
		},
		passages: Array.from({ length: count }, (_, i) => passage(i))
	};
}

const expectFail = (mutate: (c: Record<string, unknown>) => void, fragment: string | RegExp) => {
	const c = valid();
	mutate(c);
	expect(() => validateCorpus(c, HOSTS)).toThrow(fragment);
};

const first = (c: Record<string, unknown>) => (c.passages as Record<string, unknown>[])[0];
const doc = (c: Record<string, unknown>) => c.document as Record<string, unknown>;

describe('validateCorpus', () => {
	it('妥当なコーパスを通す', () => {
		expect(() => validateCorpus(valid(), HOSTS)).not.toThrow();
	});

	describe('文書', () => {
		it('schemaVersion が違えば拒否する', () => {
			expectFail((c) => (c.schemaVersion = '2'), 'schemaVersion');
		});

		it('必須項目が欠ければ拒否する', () => {
			for (const key of ['documentId', 'title', 'version', 'contentHash']) {
				expectFail((c) => delete doc(c)[key], `document.${key}`);
			}
		});

		it('日付でない retrievedAt を拒否する', () => {
			for (const bad of ['2026/09/21', '2026-13-45', '2026-02-30']) {
				expectFail((c) => (doc(c).retrievedAt = bad), 'document.retrievedAt');
			}
		});

		it('publishedAt は null を許す', () => {
			const c = valid();
			doc(c).publishedAt = null;
			expect(() => validateCorpus(c, HOSTS)).not.toThrow();
		});

		it('許可していないホストの URL を拒否する', () => {
			expectFail((c) => (doc(c).sourceUrl = 'https://example.test/spec.pdf'), 'ホストが許可');
		});

		it('例外メッセージへホスト名を出さない', () => {
			// サーバーログから対象が判明するのを避ける（CITY側と同じ扱い）。
			const c = valid();
			doc(c).sourceUrl = 'https://secret.example/spec.pdf';
			expect(() => validateCorpus(c, HOSTS)).toThrow(/ホストが許可されていない/);
			expect(() => validateCorpus(c, HOSTS)).not.toThrow(/secret\.example/);
		});

		it('http を拒否する', () => {
			expectFail((c) => (doc(c).sourceUrl = 'http://www.digital.go.jp/a.pdf'), 'https でない');
		});
	});

	describe('passage', () => {
		it('passageId の重複を拒否する', () => {
			expectFail((c) => {
				(c.passages as Record<string, unknown>[])[1].passageId = 'common-2.7.p0';
			}, '重複');
		});

		it('同一本文の重複を拒否する', () => {
			// 同じ要件のpassageは版内で一つにまとめる。
			expectFail((c) => {
				(c.passages as Record<string, unknown>[])[1].text = first(c).text;
			}, '同一である');
		});

		it('documentId が文書と食い違えば拒否する', () => {
			expectFail((c) => (first(c).documentId = 'other'), '一致しない');
		});

		it('出典表示に使う項目が欠ければ拒否する', () => {
			// 欠けると画面に undefined が出る。
			for (const key of ['sourceLocator', 'sectionId', 'text']) {
				expectFail((c) => delete first(c)[key], key);
			}
		});

		it('本文が長すぎれば拒否する', () => {
			expectFail((c) => (first(c).text = 'あ'.repeat(MAX_PASSAGE_CHARS + 1)), '上限');
		});

		it('normalized が真偽値でなければ拒否する', () => {
			// PDL 1.0 の加工表示を出し分けるため。
			for (const bad of ['true', 1, null, undefined]) {
				expectFail((c) => (first(c).normalized = bad), 'normalized');
			}
		});

		it('page は null を許すが小数を拒否する', () => {
			const ok = valid();
			first(ok).page = null;
			expect(() => validateCorpus(ok, HOSTS)).not.toThrow();
			expectFail((c) => (first(c).page = 1.5), 'page');
		});

		it('headingPath が空なら拒否する', () => {
			expectFail((c) => (first(c).headingPath = []), 'headingPath');
			expectFail((c) => (first(c).headingPath = ['章', 7]), 'headingPath');
		});

		it('tags は空配列を許す', () => {
			const ok = valid();
			first(ok).tags = [];
			expect(() => validateCorpus(ok, HOSTS)).not.toThrow();
		});
	});

	describe('件数', () => {
		it('空のコーパスを拒否する', () => {
			expectFail((c) => (c.passages = []), '空である');
		});

		it('上限ちょうどは通す', () => {
			expect(() => validateCorpus(valid(MAX_PASSAGES), HOSTS)).not.toThrow();
		});

		it('上限を超えるコーパスを拒否する', () => {
			// 実測の40件を超えるリクエストを送らない。
			expect(() => validateCorpus(valid(MAX_PASSAGES + 1), HOSTS)).toThrow('上限');
		});
	});
});

describe('attributionFor', () => {
	const document = valid().document as unknown as SpecDocument;

	it('原文のままなら出典表示だけ', () => {
		const p = { ...(passage(0) as unknown as SpecPassage), normalized: false };
		expect(attributionFor(document, p)).toBe(
			'出典：「地方公共団体情報システム共通機能標準仕様書」（デジタル庁）（https://www.digital.go.jp/assets/spec.pdf）'
		);
	});

	it('正規化していれば加工表示にする', () => {
		// PDL 1.0 は加工物を無加工の政府資料として見せることを禁じる。
		const p = { ...(passage(0) as unknown as SpecPassage), normalized: true };
		expect(attributionFor(document, p)).toContain('を加工して作成');
		expect(attributionFor(document, p)).not.toContain('出典：');
	});
});
