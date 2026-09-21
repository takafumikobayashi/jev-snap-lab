import { describe, expect, it, vi } from 'vitest';

/**
 * 実験機能の有効化条件を固定する。
 *
 * 値の取り違えで本番へ出ないよう、明示的な `true` だけを有効とする。
 * SPEC FIND と同じ扱い（[spec-find-flag.spec.ts](spec-find-flag.spec.ts)）。
 */
async function enabledWith(value: string | undefined): Promise<boolean> {
	vi.resetModules();
	vi.doMock('$env/dynamic/private', () => ({
		env: value === undefined ? {} : { BATCH_JUDGE_ENABLED: value }
	}));
	const { isBatchJudgeEnabled } = await import('./batch-judge.server');
	return isBatchJudgeEnabled();
}

describe('isBatchJudgeEnabled', () => {
	it('未設定なら無効', async () => {
		expect(await enabledWith(undefined)).toBe(false);
	});

	it('"true" のときだけ有効', async () => {
		expect(await enabledWith('true')).toBe(true);
		expect(await enabledWith(' true ')).toBe(true);
	});

	it('紛らわしい値をすべて無効にする', async () => {
		for (const value of ['1', 'TRUE', 'True', 'yes', 'on', 'false', '']) {
			expect(await enabledWith(value), value).toBe(false);
		}
	});
});
