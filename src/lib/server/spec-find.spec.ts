import { describe, expect, it, vi } from 'vitest';
import { JudgeError } from './errors.server';

vi.mock('$env/dynamic/private', () => ({ env: { SPEC_FIND_ENABLED: 'true' } }));

const { findSpecPassages, isSpecFindEnabled } = await import('./spec-find.server');

/** 候補テキストごとに確率を決めるmock sender。 */
const sender = (byText: Record<string, number>) =>
	vi.fn(async (request: { state: Record<string, unknown>; questions: Record<string, unknown> }) => {
		const bag = request.state.passages as Record<string, { text: string }>;
		return Object.fromEntries(
			Object.keys(request.questions).map((id) => {
				const position = Number(id.slice('fit_'.length));
				return [id, { type: 'noul', noul: byText[bag[`c${position}`].text] ?? 0.02 }];
			})
		);
	});

/** 配布コーパスの実文の一部。EUC機能の節。 */
const EUC_PREFIX = 'EUC 機能とは、システムの利用者である職員自身が';

describe('findSpecPassages', () => {
	it('有効化されている', () => {
		expect(isSpecFindEnabled()).toBe(true);
	});

	it('state の mode は本番の文字列で固定する', async () => {
		// mode 文字列も Jev の判断入力になる。評価やテストで別の値を使うと、
		// 測っているものが本番と変わる。
		const send = sender({});
		await findSpecPassages('x', send);
		const [request] = send.mock.calls[0];
		expect(request.state.mode).toBe('spec');
		expect(request.state.text).toBe('x');
	});

	it('上流を1回だけ呼ぶ', async () => {
		// 配布コーパスは39件で、1リクエストの上限40件の内側にある。
		const send = sender({});
		await findSpecPassages('x', send);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('出典付きの結果を返す', async () => {
		const spec = await findSpecPassages('Excelにデータを出したい', (request) => {
			const passages = request.state.passages as Record<string, { text: string }>;
			const euc = Object.entries(passages).find(([, p]) => p.text.startsWith(EUC_PREFIX));
			expect(euc, 'EUC機能の節がコーパスに無い').toBeDefined();
			return Promise.resolve(
				Object.fromEntries(
					Object.keys(request.questions).map((id) => {
						const position = Number(id.slice('fit_'.length));
						const hit = `c${position}` === euc?.[0];
						return [id, { type: 'noul', noul: hit ? 0.95 : 0.02 }];
					})
				)
			);
		});

		expect(spec.abstained).toBe(false);
		expect(spec.hits).toHaveLength(1);
		expect(spec.hits[0].text).toContain('EUC');
		expect(spec.hits[0].sourceLocator).toMatch(/^§/);
		expect(spec.hits[0].attribution).toContain('デジタル庁');
		expect(spec.unresolved).toEqual([]);
	});

	it('版とタイトルをレスポンスへ残す', async () => {
		const spec = await findSpecPassages('x', sender({}));
		expect(spec.version).toBe('2.7');
		expect(spec.documentTitle).toContain('共通機能標準仕様書');
		expect(spec.sourceUrl).toContain('digital.go.jp');
	});

	it('全候補が閾値未満なら abstain する', async () => {
		// 無理に最上位を出して、関係の薄いpassageを回答のように見せない。
		const spec = await findSpecPassages('株式の売買手数料を知りたい', sender({}));
		expect(spec.abstained).toBe(true);
		expect(spec.hits).toEqual([]);
	});

	it('上流の契約違反を握りつぶさない', async () => {
		// answer が欠けた結果を、部分的な正解として表示しない。
		await expect(findSpecPassages('x', async () => ({}))).rejects.toThrow(JudgeError);
	});
});
