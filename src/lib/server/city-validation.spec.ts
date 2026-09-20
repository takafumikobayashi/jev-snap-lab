import { describe, expect, it } from 'vitest';
import { getDirectory } from './city-directory.server';
import { parseAllowedHosts, validateDirectory } from './city-validation.server';

const NO_HOSTS = { allowedHosts: [] };

/** 最小の妥当なデータセット。各テストで1箇所だけ壊す。 */
function valid(): Record<string, unknown> {
	return {
		schemaVersion: '1',
		fictional: true,
		jurisdiction: 'mcity',
		displayName: 'M市',
		effectiveFrom: '2026-04-01',
		retrievedAt: '2026-09-20',
		sourceIndex: [
			{ sourceId: 's1', title: '出典1', url: null, retrievedAt: '2026-09-20' },
			{ sourceId: 's2', title: '出典2', url: null, retrievedAt: '2026-09-20' }
		],
		categories: [
			{ id: 'safety', label: '安全' },
			{ id: 'other', label: 'その他' }
		],
		organizations: [
			{
				organizationUnitId: 'sec.u1',
				routingCandidateId: 'sec',
				organizationType: 'city_department',
				department: 'A部',
				section: 'B課',
				unit: 'C係',
				officialName: 'M市 A部 B課 C係',
				publicSummary: '説明',
				responsibilities: [
					{
						responsibilityId: 'sec.u1.r1',
						officialText: '何かに関すること。',
						publicSummary: '何か',
						keywords: [],
						sourceRefs: ['s1']
					}
				],
				routingCategories: ['safety'],
				sourceRefs: ['s1', 's2'],
				effectiveFrom: '2026-04-01',
				effectiveTo: null,
				active: true
			}
		]
	};
}

const expectFail = (mutate: (d: Record<string, unknown>) => void, fragment: string) => {
	const d = valid();
	mutate(d);
	expect(() => validateDirectory(d, NO_HOSTS)).toThrow(fragment);
};

describe('validateDirectory', () => {
	it('妥当なデータセットを通す', () => {
		expect(() => validateDirectory(valid(), NO_HOSTS)).not.toThrow();
	});

	it('実際に配布するデータセットが検証を通る', () => {
		// これが落ちるなら、公開するデータが壊れている。
		expect(() => validateDirectory(getDirectory(), NO_HOSTS)).not.toThrow();
	});

	describe('トップレベル', () => {
		it('オブジェクトでなければ拒否する', () => {
			for (const value of [null, 'x', 42, []]) {
				expect(() => validateDirectory(value, NO_HOSTS)).toThrow();
			}
		});

		it('schemaVersion が違えば拒否する', () => {
			expectFail((d) => (d.schemaVersion = '2'), 'schemaVersion');
		});

		it('fictional が無い、または真偽値でなければ拒否する', () => {
			expectFail((d) => delete d.fictional, 'fictional');
			expectFail((d) => (d.fictional = 'true'), 'fictional');
		});

		it('displayName が空なら拒否する', () => {
			expectFail((d) => (d.displayName = ''), 'displayName');
		});
	});

	describe('出典', () => {
		it('sourceId の重複を拒否する', () => {
			expectFail((d) => {
				(d.sourceIndex as Record<string, unknown>[])[1].sourceId = 's1';
			}, '重複');
		});

		it('許可されていないホストの URL を拒否する', () => {
			expectFail((d) => {
				(d.sourceIndex as Record<string, unknown>[])[0].url = 'https://evil.test/x';
			}, '許可されていない');
		});

		it('許可ホストなら通す', () => {
			const d = valid();
			(d.sourceIndex as Record<string, unknown>[])[0].url = 'https://ok.test/x';
			expect(() => validateDirectory(d, { allowedHosts: ['ok.test'] })).not.toThrow();
		});

		it('http を拒否する', () => {
			const d = valid();
			(d.sourceIndex as Record<string, unknown>[])[0].url = 'http://ok.test/x';
			expect(() => validateDirectory(d, { allowedHosts: ['ok.test'] })).toThrow('https');
		});

		it('例外メッセージにホスト名を含めない', () => {
			// ログから自治体が判明するのを避ける。
			const d = valid();
			(d.sourceIndex as Record<string, unknown>[])[0].url = 'https://secret-city.example/x';
			expect(() => validateDirectory(d, NO_HOSTS)).toThrow(
				expect.not.stringContaining('secret-city')
			);
		});
	});

	describe('組織単位', () => {
		it('organizationUnitId の重複を拒否する', () => {
			expectFail((d) => {
				const orgs = d.organizations as Record<string, unknown>[];
				orgs.push({ ...orgs[0] });
			}, '重複');
		});

		it('未知の出典を参照していたら拒否する', () => {
			expectFail((d) => {
				(d.organizations as Record<string, unknown>[])[0].sourceRefs = ['s9'];
			}, '未知の出典');
		});

		it('未知のカテゴリを参照していたら拒否する', () => {
			expectFail((d) => {
				(d.organizations as Record<string, unknown>[])[0].routingCategories = ['nope'];
			}, '未知のカテゴリ');
		});

		it('候補が課レベルでなければ拒否する', () => {
			// 係で割ると Choice の確率が分散する。
			expectFail((d) => {
				(d.organizations as Record<string, unknown>[])[0].routingCandidateId = 'sec.unit';
			}, '課レベル');
		});

		it('同じ候補に複数の section が紐づいていたら拒否する', () => {
			expectFail((d) => {
				const orgs = d.organizations as Record<string, unknown>[];
				orgs.push({ ...orgs[0], organizationUnitId: 'sec.u2', section: '別の課' });
			}, 'section');
		});

		it('係が文字列でも null でもなければ拒否する', () => {
			expectFail((d) => {
				(d.organizations as Record<string, unknown>[])[0].unit = 123;
			}, 'unit');
		});

		it('係が null なのは許す（未確認を推測で埋めない）', () => {
			const d = valid();
			(d.organizations as Record<string, unknown>[])[0].unit = null;
			expect(() => validateDirectory(d, NO_HOSTS)).not.toThrow();
		});

		it('active でないレコードは必須項目を問わない', () => {
			const d = valid();
			const orgs = d.organizations as Record<string, unknown>[];
			orgs.push({ organizationUnitId: 'old.u1', active: false });
			expect(() => validateDirectory(d, NO_HOSTS)).not.toThrow();
		});

		it('活きている組織が1件も無ければ拒否する', () => {
			expectFail((d) => {
				(d.organizations as Record<string, unknown>[])[0].active = false;
			}, '1件も無い');
		});

		it('分掌の出典参照も検証する', () => {
			expectFail((d) => {
				const org = (d.organizations as Record<string, unknown>[])[0];
				(org.responsibilities as Record<string, unknown>[])[0].sourceRefs = ['s9'];
			}, '未知の出典');
		});
	});
});

describe('parseAllowedHosts', () => {
	it('未設定なら空（URL を持つ出典を許さない）', () => {
		expect(parseAllowedHosts(undefined)).toEqual([]);
		expect(parseAllowedHosts('')).toEqual([]);
	});

	it('カンマ区切りを読み、空白を落とす', () => {
		expect(parseAllowedHosts(' a.test , b.test ')).toEqual(['a.test', 'b.test']);
	});
});
