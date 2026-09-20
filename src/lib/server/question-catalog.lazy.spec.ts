/**
 * CITY データセットの解決がモジュール初期化時に起きないことを固定する。
 *
 * 定数として `export const CITY_JURISDICTION = jurisdictionName()` のように
 * 書くと、import の時点で候補データを読む。`CITY_DIRECTORY` の設定ミスが
 * ルートモジュールの import 失敗になり、SvelteKit は JSON のエラー封筒では
 * なく HTML の 500 を返す。しかも CITY と無関係な LOVE / SOCIAL まで落ちる。
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { CITY_DIRECTORY: 'no-such-dataset' }
}));

const { buildCatalog, buildState } = await import('./question-catalog.server');

describe('CITY データセットの解決タイミング', () => {
	it('データセットが壊れていても import 自体は成功する', () => {
		// この spec がここまで到達している時点で import は通っている。
		expect(typeof buildCatalog).toBe('function');
		expect(typeof buildState).toBe('function');
	});

	it('CITY と無関係なモードは影響を受けない', () => {
		for (const mode of ['love', 'social'] as const) {
			expect(() => buildCatalog(mode)).not.toThrow();
			expect(buildState(mode, 'テスト')).toEqual({ mode, text: 'テスト' });
		}
	});

	it('CITY だけが呼び出し時に例外になる', () => {
		// 呼び出し時なら +server.ts の try が捕まえ、JSON のエラー封筒で返せる。
		expect(() => buildCatalog('city')).toThrow(/CITY_DIRECTORY/);
		expect(() => buildState('city', 'テスト')).toThrow(/CITY_DIRECTORY/);
	});
});
