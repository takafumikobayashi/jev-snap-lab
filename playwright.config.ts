import { defineConfig, devices } from '@playwright/test';

/**
 * E2E は本番に近い形（build + preview）で動かす。CSP は prerender の有無で
 * nonce と hash を使い分けるため、dev サーバーでは本番と挙動が変わる。
 *
 * 上流の Jev は呼ばない。判定リクエストはブラウザ側で差し替えるので、
 * API キーもコストも要らない。サーバー側の判定ロジックはユニットテストで
 * 担保している。
 */
export default defineConfig({
	testDir: 'e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'list' : [['list']],
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'pnpm run build && pnpm run preview --port 4173 --strictPort',
		url: 'http://localhost:4173',
		reuseExistingServer: false,
		timeout: 120_000,
		env: {
			// 手元の .env に実データが指定されていても、E2E は架空データで走らせる。
			CITY_DIRECTORY: 'fictional-m-city'
		}
	}
});
