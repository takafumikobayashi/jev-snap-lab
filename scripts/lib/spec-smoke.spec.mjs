import { describe, expect, it } from 'vitest';
import { specChecks } from './spec-smoke.mjs';

/** 正常なレスポンス。 */
function ok() {
	return {
		spec: {
			documentTitle: '地方公共団体情報システム共通機能標準仕様書',
			version: '2.7',
			abstained: false,
			unresolved: [],
			hits: [
				{
					passageId: 'p1',
					fitProbability: 0.93,
					sourceLocator: '§2.5.1',
					attribution: '「…」（デジタル庁）（https://www.digital.go.jp/x.pdf）を加工して作成',
					sourceUrl: 'https://www.digital.go.jp/x.pdf',
					normalized: true
				}
			]
		}
	};
}

const verdict = (body) => Object.fromEntries(specChecks(body).map((r) => [r.name, r.ok]));

describe('specChecks', () => {
	it('正常なレスポンスは全て通る', () => {
		expect(Object.values(verdict(ok()))).toEqual([true, true, true, true, true, true]);
	});

	it('spec ブロックが無ければ落とす', () => {
		const v = verdict({});
		expect(v['SPEC の結果が返る']).toBe(false);
		expect(v['候補が見つかる']).toBe(false);
	});

	it('abstain したら「候補が見つかる」を落とす', () => {
		// 対象外でない入力で候補0件なら、コーパスか閾値の設定を疑う。
		const body = ok();
		body.spec.abstained = true;
		body.spec.hits = [];
		expect(verdict(body)['候補が見つかる']).toBe(false);
	});

	it('locator が欠けたら落とす', () => {
		const body = ok();
		delete body.spec.hits[0].sourceLocator;
		expect(verdict(body)['出典の位置が付く']).toBe(false);
	});

	it('出典表示が欠けたら落とす', () => {
		// PDL 1.0 の要求。欠けた状態で公開しない。
		const body = ok();
		body.spec.hits[0].attribution = '';
		expect(verdict(body)['PDL 1.0 の出典表示が付く']).toBe(false);
	});

	it('解決できない候補があれば落とす', () => {
		const body = ok();
		body.spec.unresolved = ['p.missing'];
		expect(verdict(body)['解決できない候補が無い']).toBe(false);
	});

	it('版が無ければ落とす', () => {
		const body = ok();
		delete body.spec.version;
		expect(verdict(body)['データセットの版が残る']).toBe(false);
	});

	it('hits が配列でなくても落ちない', () => {
		const body = ok();
		body.spec.hits = 'なにか';
		expect(() => specChecks(body)).not.toThrow();
		expect(verdict(body)['SPEC の結果が返る']).toBe(false);
	});

	it('空集合を合格にしない', () => {
		// 候補0件のとき、locator も出典表示も「全件にあり」で通してはいけない。
		const body = ok();
		body.spec.hits = [];
		const v = verdict(body);
		expect(v['出典の位置が付く']).toBe(false);
		expect(v['PDL 1.0 の出典表示が付く']).toBe(false);
	});
});
