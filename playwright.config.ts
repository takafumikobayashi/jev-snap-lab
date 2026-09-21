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
			CITY_DIRECTORY: 'fictional-m-city',
			// OGP は絶対 URL を要求する。設定した状態での出力を検証する。
			PUBLIC_SITE_URL: 'http://localhost:4173',
			// SPEC FIND は既定で無効。UI を検証するため E2E でだけ有効にする。
			// 既定が無効であることは spec-find-flag.spec.ts で固定している。
			SPEC_FIND_ENABLED: 'true',
			// BATCH JUDGE も既定で無効。UI を検証するため E2E でだけ有効にする。
			// 既定が無効であることは batch-judge-flag.spec.ts で固定している。
			BATCH_JUDGE_ENABLED: 'true'
		}
	}
});
