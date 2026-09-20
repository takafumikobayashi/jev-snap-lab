import { describe, expect, it } from 'vitest';
import { cityChecks } from './city-smoke.mjs';

/** 架空データの正常なレスポンス。 */
function ok() {
	return {
		city: {
			directoryVersion: 'mcity-2026-04-01',
			fictional: true,
			candidates: [
				{
					kind: 'unit',
					candidateId: 'c1',
					probability: 0.6,
					selected: true,
					officialName: 'M市 A部 B課',
					section: 'B課',
					unit: null,
					matchedResponsibilities: [],
					sources: [{ sourceId: 's1', title: '出典', url: null, locator: '第3条' }]
				},
				{
					kind: 'unroutable',
					candidateId: 'other_or_unclear',
					probability: 0.4,
					selected: false,
					label: '絞り込めない'
				}
			]
		}
	};
}

const verdict = (body) => Object.fromEntries(cityChecks(body).map((r) => [r.name, r.ok]));

describe('cityChecks', () => {
	it('正常なレスポンスは全て通る', () => {
		expect(Object.values(verdict(ok()))).toEqual([true, true, true, true]);
	});

	it('実データなら落とす', () => {
		const body = ok();
		body.city.fictional = false;
		expect(verdict(body)['CITY が架空データ']).toBe(false);
	});

	it('出典に URL があれば落とす', () => {
		// これを見逃すと、実在の自治体を特定できる URL が公開デプロイに載る。
		const body = ok();
		body.city.candidates[0].sources[0].url = 'https://example.test/soshiki';
		expect(verdict(body)['出典に URL を持たない']).toBe(false);
	});

	it('city ブロックが無ければ落とす', () => {
		expect(Object.values(verdict({}))).toEqual([false, false, false, false]);
	});

	it('candidates が無ければ落とす（空振りにしない）', () => {
		// 以前は body.city.sources を見ており、フィールド名が変わった後も
		// `?? []` の既定値で `.every()` が true になり常に合格していた。
		const body = ok();
		delete body.city.candidates;
		const v = verdict(body);
		expect(v['CITY の候補が返る']).toBe(false);
		expect(v['出典に URL を持たない']).toBe(false);
	});

	it('出典が1件も無ければ落とす', () => {
		const body = ok();
		body.city.candidates[0].sources = [];
		const v = verdict(body);
		expect(v['候補に出典が付く']).toBe(false);
		// 空集合を「全て url=null」として合格にしない。
		expect(v['出典に URL を持たない']).toBe(false);
	});

	it('unroutable だけなら出典が無いので落とす', () => {
		const body = ok();
		body.city.candidates = [body.city.candidates[1]];
		expect(verdict(body)['候補に出典が付く']).toBe(false);
	});

	it('sources が配列でなくても落ちない', () => {
		const body = ok();
		body.city.candidates[0].sources = 'なにか';
		expect(() => cityChecks(body)).not.toThrow();
		expect(verdict(body)['出典に URL を持たない']).toBe(false);
	});
});
