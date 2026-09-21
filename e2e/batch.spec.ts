import { expect, test, type Page } from '@playwright/test';
import { batchResponse, errorBody, stubBatch } from './fixtures';

/**
 * 画面の文言を空白を潰して読む。
 *
 * `getByText` は**正規表現のときだけ空白を正規化しない。** prettier が
 * 折り返した箇所で、正しい実装でも一致しなくなる。実際に踏んだ。
 */
async function screenText(page: Page): Promise<string> {
	return (await page.locator('main').innerText()).replace(/\s+/g, '');
}

/**
 * 判定を走らせ、結果が出るまで待つ。
 *
 * **待たずに本文を読むと、並列実行のときだけ落ちる。** 実際に踏んだ。
 */
async function runAndWait(page: Page, cases = 3) {
	await page.getByRole('button', { name: /件をまとめて判定/ }).click();
	await expect(page.getByRole('heading', { name: `${cases} CASES` })).toBeVisible();
}

/**
 * BATCH JUDGE の E2E。
 *
 * 上流の Jev は呼ばない。ブラウザ側で `/api/batch` を差し替える。
 * 受入条件は docs/BATCH_JUDGE_DESIGN.md の §11。
 */

test.describe('BATCH JUDGE', () => {
	test('件数ぶんの結果と実測値を出す', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await page.getByRole('button', { name: /件をまとめて判定/ }).click();

		await expect(page.getByRole('heading', { name: '3 CASES' })).toBeVisible();
		await expect(page.getByText('令和8年度の粗大ごみ収集')).toBeVisible();
		await expect(page.getByText('要確認シグナルなし', { exact: true }).first()).toBeVisible();

		// 数値はすべて実測値。設計段階の見本を出さない（§6）。
		await expect(page.getByText('1024 ms')).toBeVisible();
		await expect(page.getByText('18,125')).toBeVisible();
		await expect(page.getByText('jev-1.13.0')).toBeVisible();
	});

	test('画面に「安全」と出さない', async ({ page }) => {
		// `no_signal` は安全の保証ではない（§3.1）。
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await runAndWait(page);

		const body = await screenText(page);
		for (const forbidden of ['安全', 'SAFE', 'そのまま入力']) {
			expect(body, `${forbidden} が画面に出ている`).not.toContain(forbidden);
		}
	});

	test('一致率を「精度」と呼ばず、暫定ラベルであることを出す', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await runAndWait(page);

		const body = await screenText(page);
		expect(body).toContain('2/3');
		expect(body).toContain('暫定ラベル（人手確認前）');
		expect(body).toContain('Jevの精度ではありません');
		// 同じ入力で結果が揺れることも伝える（§4.6）。
		expect(body).toContain('同じ入力でも毎回同じとは限りません');
	});

	test('1件あたりの時間が参考値であることを注記する', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await runAndWait(page);
		expect(await screenText(page)).toContain('逐次実行された意味ではありません');
	});

	test('入力欄を出さず、送信することを先に伝える', async ({ page }) => {
		// このモード自身が例文をJevへ送る（§3.1）。
		await page.goto('/batch');
		await expect(page.locator('textarea')).toHaveCount(0);
		expect(await screenText(page)).toContain('TypeSafeAIへ送信されます');
	});

	test('PRIVACY の注意文を常時出す', async ({ page }) => {
		await page.goto('/batch');
		const body = await screenText(page);
		expect(body).toContain('個人情報に該当しないという判定でも');
		expect(body).toContain('Jevを唯一の制御にしないでください');
	});

	test('不一致の中身を確認できる', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await runAndWait(page);

		await page.getByText('不一致の 1 件を見る').click();
		const body = await screenText(page);
		expect(body).toContain('判定要確認/ラベル要確認シグナルなし');
		// 判定に使わない sensitive も理由として出す。
		expect(body).toContain('慎重に扱う情報37%');
	});

	test('失敗したら再試行できる', async ({ page }) => {
		await stubBatch(page, (call) =>
			call === 1
				? { status: 503, body: errorBody('UPSTREAM_UNAVAILABLE', '判定に失敗しました。', true) }
				: { status: 200, body: batchResponse() }
		);
		await page.goto('/batch');
		await page.getByRole('button', { name: /件をまとめて判定/ }).click();

		await expect(page.getByText('判定に失敗しました。')).toBeVisible();
		await page.getByRole('button', { name: '再試行' }).click();
		await expect(page.getByRole('heading', { name: '3 CASES' })).toBeVisible();
	});

	test('テーマを切り替えると前の結果を捨てる', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await runAndWait(page);

		await page.getByRole('tab', { name: 'いつまでに対応が必要？' }).click();
		await expect(page.getByRole('heading', { name: '3 CASES' })).toHaveCount(0);
	});
});
