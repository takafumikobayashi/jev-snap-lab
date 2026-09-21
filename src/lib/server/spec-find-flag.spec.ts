import { describe, expect, it, vi } from 'vitest';

/**
 * 実験機能の有効化条件を固定する。
 *
 * 値の取り違えで本番へ出ないよう、明示的な `true` だけを有効とする。
 */
async function enabledWith(value: string | undefined): Promise<boolean> {
	vi.resetModules();
	vi.doMock('$env/dynamic/private', () => ({
		env: value === undefined ? {} : { SPEC_FIND_ENABLED: value }
	}));
	const { isSpecFindEnabled } = await import('./spec-find.server');
	return isSpecFindEnabled();
}

describe('isSpecFindEnabled', () => {
	it('未設定なら無効', async () => {
		expect(await enabledWith(undefined)).toBe(false);
	});

	it('"true" のときだけ有効', async () => {
		expect(await enabledWith('true')).toBe(true);
		expect(await enabledWith(' true ')).toBe(true);
	});

	it('紛らわしい値をすべて無効にする', async () => {
		// "1" や "TRUE" を有効にすると、意図しない設定で実験機能が本番へ出る。
		for (const value of ['1', 'TRUE', 'True', 'yes', 'on', 'false', '']) {
			expect(await enabledWith(value), value).toBe(false);
		}
	});
});
