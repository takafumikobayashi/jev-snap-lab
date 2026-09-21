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
async function runAndWait(page: Page, cases = 4) {
	await page.getByRole('button', { name: /件をまとめて判定/ }).click();
	await expect(page.getByRole('heading', { name: `${cases} CASES` })).toBeVisible();
	// 1件ずつ開示する。**途中で本文を読むと数字が揃っていない。** 実際に踏んだ。
	await expect(page.getByText(`${cases} / ${cases}`, { exact: true })).toBeVisible();
}

/** 例文を入れてから判定する。入力欄がある画面の既定の入り口。 */
async function fillAndRun(page: Page, cases = 4) {
	await page.getByRole('button', { name: /例文を入れる/ }).click();
	await runAndWait(page, cases);
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
		await fillAndRun(page);

		await expect(page.getByText('令和8年度の粗大ごみ収集')).toBeVisible();
		await expect(page.getByText('要確認シグナルなし', { exact: true }).first()).toBeVisible();

		// 数値はすべて実測値。設計段階の見本を出さない（§6）。
		await expect(page.getByText('1024 ms')).toBeVisible();
		await expect(page.getByText('18,125', { exact: true })).toBeVisible();
		await expect(page.getByText('jev-1.13.0', { exact: true })).toBeVisible();
	});

	test('画面に「安全」と出さない', async ({ page }) => {
		// `no_signal` は安全の保証ではない（§3.1）。
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await fillAndRun(page);

		const body = await screenText(page);
		for (const forbidden of ['安全', 'SAFE', 'そのまま入力']) {
			expect(body, `${forbidden} が画面に出ている`).not.toContain(forbidden);
		}
	});

	test('一致率を「精度」と呼ばず、暫定ラベルであることを出す', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await fillAndRun(page);

		const body = await screenText(page);
		expect(body).toContain('3/4');
		expect(body).toContain('暫定ラベル（人手確認前）');
		expect(body).toContain('Jevの精度ではありません');
		// 同じ入力で結果が揺れることも伝える（§4.6）。
		expect(body).toContain('同じ入力でも毎回同じとは限りません');
	});

	test('判定に使わない軸をバーの数値にしない', async ({ page }) => {
		// 「要確認シグナルなし 97%」と出すと、シグナルが無いことの確信度に
		// 見える。97% は判定に使わない sensitive の値である（§3.1）。
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await fillAndRun(page);

		const row = page.getByRole('listitem').filter({ hasText: '生活保護受給世帯の一覧' });
		await expect(row).toContainText('要確認シグナルなし');
		await expect(row).toContainText('8%');
		await expect(row).not.toContainText('97%');
	});

	test('1件あたりの時間が参考値であることを注記する', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await fillAndRun(page);
		expect(await screenText(page)).toContain('逐次実行された意味ではありません');
	});

	test('入力欄の手前に、送信することを出す', async ({ page }) => {
		// **判定結果と一緒では遅い。** このモードは入力文をAIへ送る（§3.1）。
		await page.goto('/batch');
		const notice = page.getByText(/TypeSafe AI へ送信されます/);
		await expect(notice).toBeVisible();

		const noticeBottom = (await notice.boundingBox())?.y ?? 0;
		const inputTop = (await page.locator('#batch-input').boundingBox())?.y ?? 0;
		expect(noticeBottom).toBeLessThan(inputTop);
		expect(await screenText(page)).toContain('実際の個人情報は入力しないでください');
	});

	test('例文を入れれば自分の文章を貼らずに試せる', async ({ page }) => {
		await page.goto('/batch');
		await expect(page.locator('#batch-input')).toHaveValue('');
		await page.getByRole('button', { name: /例文を入れる/ }).click();

		const value = await page.locator('#batch-input').inputValue();
		expect(value.split('\n').length).toBe(50);
		await expect(page.getByRole('button', { name: '50件をまとめて判定' })).toBeEnabled();
	});

	test('自分で書いた文章を判定できる', async ({ page }) => {
		let sent: unknown;
		await page.route('**/api/batch', async (route) => {
			sent = route.request().postDataJSON();
			await route.fulfill({
				status: 200,
				contentType: 'application/json; charset=utf-8',
				body: JSON.stringify(batchResponse())
			});
		});
		await page.goto('/batch');
		await page.locator('#batch-input').fill('明日の会議室を予約したい\n\n窓口の待ち時間が長い');
		// 空行は捨てる。
		await expect(page.getByRole('button', { name: '2件をまとめて判定' })).toBeEnabled();
		await page.getByRole('button', { name: '2件をまとめて判定' }).click();

		await expect(page.getByRole('heading', { name: '4 CASES' })).toBeVisible();
		expect(sent).toEqual({
			theme: 'privacy',
			cases: ['明日の会議室を予約したい', '窓口の待ち時間が長い']
		});
	});

	test('件数の上限を超えたら判定させない', async ({ page }) => {
		await page.goto('/batch');
		await page
			.locator('#batch-input')
			.fill(Array.from({ length: 51 }, (_, at) => `件 ${at}`).join('\n'));
		await expect(page.getByRole('button', { name: /件をまとめて判定/ })).toBeDisabled();
		expect(await screenText(page)).toContain('50件までです');
	});

	test('入力が空なら判定させない', async ({ page }) => {
		await page.goto('/batch');
		await expect(page.getByRole('button', { name: /件をまとめて判定/ })).toBeDisabled();
	});

	test('受信後に1件ずつ開示し、進捗のふりをしない', async ({ page }) => {
		// 全件は1回のリクエストで同時に評価されている（§6）。逐次処理している
		// ように見せない。
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await page.getByRole('button', { name: /例文を入れる/ }).click();
		await page.getByRole('button', { name: /件をまとめて判定/ }).click();

		await expect(page.getByRole('heading', { name: '4 CASES' })).toBeVisible();
		// 数字が最終値まで動く。
		await expect(page.getByText('4 / 4', { exact: true })).toBeVisible();

		const body = await screenText(page);
		expect(body).toContain('1回のリクエストで同時に評価');
		expect(body).toContain('処理の進捗ではありません');
	});

	test('処理の流れを実測値で出す', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await fillAndRun(page);

		const body = await screenText(page);
		expect(body).toContain('処理の流れ');
		// 件数・本文の長さ・質問数・リクエスト数はすべてレスポンスの値。
		expect(body).toContain('4件・本文92字');
		expect(body).toContain('12問（1件あたり3問）');
		expect(body).toContain('1リクエスト。分割しない');
		expect(body).toContain('12問すべてに回答あり');
	});

	test('結果のまとめを出す', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await fillAndRun(page);

		const body = await screenText(page);
		expect(body).toContain('結果のまとめ');
		// 結論の内訳
		expect(body).toContain('要確認2件');
		// 揺れやすい帯を出す（§4.6）。
		expect(body).toContain('0.4〜0.7（揺れやすい）');
		// 混同の中身
		expect(body).toContain('要確認シグナルなし→要確認1件');
	});

	test('正解の無い文章に一致率を出さない', async ({ page }) => {
		await stubBatch(page, () => ({
			status: 200,
			body: batchResponse({
				results: [
					{
						caseId: 'privacy_input_001',
						text: '自分で書いた文章',
						verdict: 'no_signal',
						signals: [
							{ key: 'identifies', probability: 0.04 },
							{ key: 'personal', probability: 0.04 },
							{ key: 'sensitive', probability: 0.04 }
						]
					}
				],
				caseCount: 1,
				questionCount: 3,
				stateChars: 8,
				userProvided: true
			})
		}));
		await page.goto('/batch');
		await page.locator('#batch-input').fill('自分で書いた文章');
		await runAndWait(page, 1);

		const body = await screenText(page);
		expect(body).toContain('正解ラベルがないため、一致率は出していません');
		// 指紋は例文データセットのもの。利用者の文章には出さない。
		expect(body).not.toContain('dataset sha256');

		// **正解が無いのに「不一致」と出さない。** 実際に出ていた。行だけを見る。
		// 全文で見ると「一致率は出していません」に当たって空振りする。
		const row = page.getByRole('listitem').filter({ hasText: '自分で書いた文章' });
		await expect(row).toContainText('要確認シグナルなし');
		await expect(row).not.toContainText('一致');
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
		await fillAndRun(page);

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
		await page.getByRole('button', { name: /例文を入れる/ }).click();
		await page.getByRole('button', { name: /件をまとめて判定/ }).click();

		await expect(page.getByText('判定に失敗しました。')).toBeVisible();
		await page.getByRole('button', { name: '再試行' }).click();
		await expect(page.getByRole('heading', { name: '4 CASES' })).toBeVisible();
	});

	test('テーマを切り替えると前の結果を捨てる', async ({ page }) => {
		await stubBatch(page, () => ({ status: 200, body: batchResponse() }));
		await page.goto('/batch');
		await fillAndRun(page);

		await page.getByRole('tab', { name: 'いつまでに対応が必要？' }).click();
		await expect(page.getByRole('heading', { name: '4 CASES' })).toHaveCount(0);
	});
});
