import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { errorBody, judgeResponse, stubJudge } from './fixtures';

/**
 * 判定 UI の E2E。受入テストは docs/IMPLEMENTATION_PLAN.md の §4 に対応する。
 *
 * 上流の Jev は呼ばない。ブラウザ側で `/api/judge` を差し替えるため、
 * API キーもコストも不要で、結果が毎回同じになる。
 */

const judge = (page: Page) => page.getByRole('button', { name: 'JUDGE' });
const textarea = (page: Page) => page.getByRole('textbox');

/** コンソールのエラーと警告を集める。CSP 違反もここへ出る。 */
function collectConsole(page: Page): ConsoleMessage[] {
	const messages: ConsoleMessage[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') messages.push(message);
	});
	page.on('pageerror', (error) => {
		throw new Error(`ページで例外が発生した: ${error.message}`);
	});
	return messages;
}

test.describe('判定フロー', () => {
	test('C-02 入力して送信すると結果が出る', async ({ page }) => {
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.goto('/');

		await textarea(page).fill('もう君のことは忘れたはずなのに');
		await judge(page).click();

		await expect(page.getByText('恋愛的な読み')).toBeVisible();
		await expect(page.getByText('未練', { exact: true }).first()).toBeVisible();
		await expect(page.getByText('Model: jev-1.13.0')).toBeVisible();
	});

	test('3 種類の判定が見た目で区別できる', async ({ page }) => {
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();

		// 色だけに識別を頼らないので、種類が文字でも出る。
		await expect(page.getByText('選択肢')).toBeVisible();
		await expect(page.getByText('段階')).toBeVisible();
		await expect(page.getByText('YES / NO')).toBeVisible();
	});

	test('バーの幅と色が実際に適用される', async ({ page }) => {
		// 幅と色は style 属性で与えている。CSP が style-src を許していないと
		// 本番だけ無視され、テキストは正しいのに描画だけ壊れる。
		// コンソールの違反メッセージだけを見ていると気付けないため、
		// 計算後のスタイルを直接確かめる。
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();
		await expect(page.getByText('恋愛的な読み')).toBeVisible();

		const bar = page.locator('li', { hasText: '未練' }).locator('div > div').first();
		const box = await bar.boundingBox();
		const track = await bar.locator('xpath=..').boundingBox();
		expect(box).not.toBeNull();
		expect(track).not.toBeNull();

		// 72% のバーなので、トラックの半分より広く、全幅より狭い。
		expect(box!.width).toBeGreaterThan(track!.width * 0.5);
		expect(box!.width).toBeLessThan(track!.width * 0.95);

		// 背景色が中立色のままでないこと。
		const background = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(background).not.toBe('rgba(0, 0, 0, 0)');
	});

	test('低確度のとき注意を出す', async ({ page }) => {
		// score カードの confidence は 0.55 で、閾値 0.60 を下回る。
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();

		await expect(page.getByText('判断が割れています')).toBeVisible();
	});

	test('Choice は上位 3 件を出し、残りを畳む', async ({ page }) => {
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();

		const more = page.getByRole('button', { name: /残り 1 件を表示/ });
		await expect(more).toBeVisible();
		await expect(page.getByText('片思い')).toBeHidden();
		await more.click();
		await expect(page.getByText('片思い')).toBeVisible();
	});
});

test.describe('入力の検証', () => {
	test('C-04 空のままでは送信できない', async ({ page }) => {
		await page.goto('/');
		await expect(judge(page)).toBeDisabled();
		await textarea(page).fill('   ');
		await expect(judge(page)).toBeDisabled();
	});

	test('C-03 280 code points を超えると送信できない', async ({ page }) => {
		await page.goto('/');
		await textarea(page).fill('あ'.repeat(281));
		await expect(page.getByText('281 / 280')).toBeVisible();
		await expect(page.getByText('280文字以内にしてください')).toBeVisible();
		await expect(judge(page)).toBeDisabled();
	});

	test('絵文字は code point で数える', async ({ page }) => {
		// UTF-16 の length なら 560 で超過扱いになる。
		await page.goto('/');
		await textarea(page).fill('👍'.repeat(280));
		await expect(page.getByText('280 / 280')).toBeVisible();
		await expect(judge(page)).toBeEnabled();
	});
});

test.describe('エラー処理', () => {
	test('C-06 timeout は再試行できる', async ({ page }) => {
		await stubJudge(page, (call) =>
			call === 1
				? { status: 504, body: errorBody('UPSTREAM_TIMEOUT', '判定に時間がかかっています。', true) }
				: { status: 200, body: judgeResponse() }
		);
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();

		const retry = page.getByRole('button', { name: '再試行' });
		await expect(retry).toBeVisible();
		// 入力は保持される。
		await expect(textarea(page)).toHaveValue('テスト入力');

		await retry.click();
		await expect(page.getByText('恋愛的な読み')).toBeVisible();
	});

	test('再試行できないエラーではボタンを出さない', async ({ page }) => {
		await stubJudge(page, () => ({
			status: 500,
			body: errorBody('CONFIGURATION_ERROR', '現在ご利用いただけません。', false)
		}));
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();

		await expect(page.getByText('現在ご利用いただけません。')).toBeVisible();
		await expect(page.getByRole('button', { name: '再試行' })).toBeHidden();
	});
});

test.describe('モード切替と競合', () => {
	test('C-01 モードを切り替えても入力は残り、結果は消える', async ({ page }) => {
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();
		await expect(page.getByText('恋愛的な読み')).toBeVisible();

		await page.getByRole('tab', { name: 'city' }).click();
		await expect(textarea(page)).toHaveValue('テスト入力');
		await expect(page.getByText('恋愛的な読み')).toBeHidden();
		await expect(page.getByText('技術検証・デモ')).toBeVisible();
	});

	test('判定中にモードを切り替えても古い結果が出ない', async ({ page }) => {
		// abort が間に合わずレスポンスが先に解決する状況を、遅延で作る。
		await stubJudge(page, () => ({ status: 200, body: judgeResponse(), delayMs: 600 }));
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();

		await page.getByRole('tab', { name: 'social' }).click();
		await page.waitForTimeout(1200);

		// LOVE の結果が SOCIAL の画面へ出てはいけない。
		await expect(page.getByText('恋愛的な読み')).toBeHidden();
	});

	test('判定中に入力を変えたら結果を捨てる', async ({ page }) => {
		await stubJudge(page, () => ({ status: 200, body: judgeResponse(), delayMs: 600 }));
		await page.goto('/');
		await textarea(page).fill('最初の入力');
		await judge(page).click();

		await textarea(page).fill('書き換えた入力');
		await page.waitForTimeout(1200);

		// 表示中の入力文と一致しない結果を出さない。
		await expect(page.getByText('恋愛的な読み')).toBeHidden();
	});

	test('キーボードでモードを移動できる', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('tab', { name: 'love' }).focus();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByRole('tab', { name: 'social' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
	});
});

test.describe('セキュリティ', () => {
	test('CSP 違反とコンソールエラーが出ない', async ({ page }) => {
		const messages = collectConsole(page);
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));

		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();
		await expect(page.getByText('恋愛的な読み')).toBeVisible();
		await page.getByRole('tab', { name: 'city' }).click();

		const problems = messages.map((m) => m.text());
		expect(problems.filter((t) => /Content Security Policy|Refused to/i.test(t))).toEqual([]);
		expect(problems).toEqual([]);
	});

	test('CSP ヘッダーが付与される', async ({ page }) => {
		const response = await page.goto('/');
		const csp = response?.headers()['content-security-policy'];
		expect(csp).toBeTruthy();
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("object-src 'none'");
	});

	test('C-09 XSS 文字列がスクリプトとして実行されない', async ({ page }) => {
		collectConsole(page);
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.goto('/');

		const payload = '<img src=x onerror="window.__xss = true">';
		await textarea(page).fill(payload);
		await judge(page).click();
		await expect(page.getByText('恋愛的な読み')).toBeVisible();

		expect(await page.evaluate(() => '__xss' in window)).toBe(false);
		await expect(textarea(page)).toHaveValue(payload);
	});

	test('クライアントバンドルに API キーが現れない', async ({ page }) => {
		const scripts: string[] = [];
		page.on('response', async (response) => {
			if (!response.url().includes('/_app/')) return;
			if (!response.headers()['content-type']?.includes('javascript')) return;
			scripts.push(await response.text());
		});
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		expect(scripts.length).toBeGreaterThan(0);
		for (const source of scripts) {
			expect(source).not.toContain('TYPESAFE_API_KEY');
			expect(source).not.toMatch(/api-[A-Za-z0-9_-]{40,}/);
		}
	});
});
