import { describe, expect, it, vi } from 'vitest';

/** feature flag が無効なら画面ごと出さない。押すとエラー、という見せ方はしない。 */
async function loadWith(value: string | undefined) {
	vi.resetModules();
	vi.doMock('$env/dynamic/private', () => ({
		env: value === undefined ? {} : { BATCH_JUDGE_ENABLED: value }
	}));
	const { load } = await import('./+page.server');
	return load({} as never);
}

describe('/batch の load', () => {
	it('無効なら 404 にする', async () => {
		await expect(async () => await loadWith(undefined)).rejects.toMatchObject({ status: 404 });
		await expect(async () => await loadWith('1')).rejects.toMatchObject({ status: 404 });
	});

	it('有効ならテーマ一覧を返す', async () => {
		const data = (await loadWith('true')) as { themes: { theme: string; cases: number }[] };
		expect(data.themes.map((entry) => entry.theme)).toEqual(['privacy', 'deadline', 'dx']);
		// 件数はデータから作る。画面に手で書かない。
		expect(data.themes.every((entry) => entry.cases === 50)).toBe(true);
	});
});
