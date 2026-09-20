import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { errorBody, judgeResponse, stubJudge } from './fixtures';

/**
 * 判定 UI の E2E。受入テストは docs/IMPLEMENTATION_PLAN.md の §4 に対応する。
 *
 * 上流の Jev は呼ばない。ブラウザ側で `/api/judge` を差し替えるため、
 * API キーもコストも不要で、結果が毎回同じになる。
 */

/**
 * JPEG の幅と高さを読む。
 *
 * SOF マーカー（0xFFC0〜0xFFCF のうち C4 / C8 / CC を除く）の直後に
 * 高さと幅が 2 バイトずつ並ぶ。PNG と違って固定位置ではないため、
 * セグメントを辿って探す。
 */
function jpegSize(buffer: Buffer): { width: number; height: number } {
	let offset = 2;
	while (offset < buffer.length - 9) {
		if (buffer[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = buffer[offset + 1];
		const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
		if (isStartOfFrame) {
			return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
		}
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		offset += 2 + buffer.readUInt16BE(offset + 2);
	}
	throw new Error('JPEG の SOF マーカーが見つからない');
}

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

	test('モードごとの注意文が出し分けられる', async ({ page }) => {
		await page.goto('/');
		// LOVE は著作物の入力がありうるので注意を常時出す。
		const loveNotice = page.getByText('著作物の取り扱いにはご注意ください');
		const cityNotice = page.getByText('技術検証・デモ');

		await expect(loveNotice).toBeVisible();
		await expect(cityNotice).toBeHidden();

		await page.getByRole('tab', { name: 'city' }).click();
		await expect(cityNotice).toBeVisible();
		await expect(loveNotice).toBeHidden();

		await page.getByRole('tab', { name: 'social' }).click();
		await expect(loveNotice).toBeHidden();
		await expect(cityNotice).toBeHidden();
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

	test('判定 API のレスポンスをキャッシュさせない', async ({ page }) => {
		// 入力と判定結果を中間キャッシュにも履歴にも残さない。
		await page.goto('/');
		const response = await page.request.post('/api/judge', {
			headers: { 'Content-Type': 'application/json' },
			data: { mode: 'love', text: '   ' }
		});
		expect(response.status()).toBe(400);
		expect(response.headers()['cache-control']).toBe('no-store');
		expect(response.headers()['x-content-type-options']).toBe('nosniff');
		expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
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

test.describe('アクセシビリティとレスポンシブ', () => {
	test('結果の更新が支援技術へ通知される', async ({ page }) => {
		// aria-live="polite" の領域に結果が入ること。
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.goto('/');

		const live = page.locator('[aria-live="polite"]');
		await expect(live).toHaveAttribute('aria-busy', 'false');

		await textarea(page).fill('テスト入力');
		await judge(page).click();
		await expect(live.getByText('恋愛的な読み')).toBeVisible();
	});

	test('判定中は aria-busy が立つ', async ({ page }) => {
		await stubJudge(page, () => ({ status: 200, body: judgeResponse(), delayMs: 600 }));
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();
		await expect(page.locator('[aria-live="polite"]')).toHaveAttribute('aria-busy', 'true');
	});

	test('モバイル幅で横スクロールが出ない', async ({ page }) => {
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.setViewportSize({ width: 375, height: 700 });
		await page.goto('/');
		await textarea(page).fill('もう君のことは忘れたはずなのに');
		await judge(page).click();
		await expect(page.getByText('恋愛的な読み')).toBeVisible();

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});

	test('モバイル幅では結果が1列になる', async ({ page }) => {
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.setViewportSize({ width: 375, height: 700 });
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();
		await expect(page.getByText('恋愛的な読み')).toBeVisible();

		// 先頭2枚のカードの左端が揃っていれば縦並び。
		const cards = page.locator('[aria-live="polite"] .grid > div');
		const first = await cards.nth(0).boundingBox();
		const second = await cards.nth(1).boundingBox();
		expect(first!.x).toBe(second!.x);
	});

	test('デスクトップ幅では結果が2列になる', async ({ page }) => {
		await stubJudge(page, () => ({ status: 200, body: judgeResponse() }));
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/');
		await textarea(page).fill('テスト入力');
		await judge(page).click();
		await expect(page.getByText('恋愛的な読み')).toBeVisible();

		const cards = page.locator('[aria-live="polite"] .grid > div');
		const first = await cards.nth(0).boundingBox();
		const second = await cards.nth(1).boundingBox();
		expect(second!.x).toBeGreaterThan(first!.x);
	});
});

test.describe('開示', () => {
	test('CITY の根拠表示が架空であることを明示する', async ({ page }) => {
		// 公開用データセットは架空。公式の根拠として見せてはならない。
		await stubJudge(page, () => ({
			status: 200,
			body: judgeResponse({
				mode: 'city',
				city: {
					directoryVersion: 'mcity-2026-04-01',
					fictional: true,
					candidates: [
						{
							kind: 'unit',
							candidateId: 'c1',
							probability: 0.7,
							selected: true,
							officialName: 'M市 A部 B課',
							section: 'B課',
							unit: null,
							matchedResponsibilities: [],
							sources: [
								{
									sourceId: 's1',
									title: 'M市組織一覧（架空）',
									url: null,
									locator: '架空の規程',
									retrievedAt: '2026-09-20',
									effectiveFrom: '2026-04-01'
								}
							]
						}
					]
				}
			})
		}));
		await page.goto('/');
		await page.getByRole('tab', { name: 'city' }).click();
		await textarea(page).fill('防犯灯が切れてます');
		await judge(page).click();

		await expect(page.getByText('根拠データ（架空）')).toBeVisible();
		await expect(page.getByText('実在の自治体の出典ではありません')).toBeVisible();
	});

	test('実データのときは架空の注記を出さない', async ({ page }) => {
		await stubJudge(page, () => ({
			status: 200,
			body: judgeResponse({
				mode: 'city',
				city: {
					directoryVersion: 'real-2026-04-01',
					fictional: false,
					candidates: [
						{
							kind: 'unit',
							candidateId: 'c1',
							probability: 0.7,
							selected: true,
							officialName: 'X市 A部 B課',
							section: 'B課',
							unit: null,
							matchedResponsibilities: [],
							sources: []
						}
					]
				}
			})
		}));
		await page.goto('/');
		await page.getByRole('tab', { name: 'city' }).click();
		await textarea(page).fill('防犯灯が切れてます');
		await judge(page).click();

		await expect(page.getByText('根拠データ', { exact: true })).toBeVisible();
		await expect(page.getByText('根拠データ（架空）')).toBeHidden();
	});

	test('表示している上位候補すべてに根拠が出る', async ({ page }) => {
		// 選ばれた1件だけに根拠を付けると、候補が割れた入力ほど
		// 2位・3位と比べる材料が無くなる。
		const candidate = (n: number, probability: number, selected: boolean) => ({
			kind: 'unit',
			candidateId: `c${n}`,
			probability,
			selected,
			officialName: `M市 A部 B${n}課`,
			section: `B${n}課`,
			unit: null,
			matchedResponsibilities: [],
			sources: [
				{
					sourceId: `s${n}`,
					title: `出典${n}（架空）`,
					url: null,
					locator: '架空の規程',
					retrievedAt: '2026-09-20',
					effectiveFrom: '2026-04-01'
				}
			]
		});

		await stubJudge(page, () => ({
			status: 200,
			body: judgeResponse({
				mode: 'city',
				city: {
					directoryVersion: 'mcity-2026-04-01',
					fictional: true,
					candidates: [candidate(1, 0.5, true), candidate(2, 0.3, false), candidate(3, 0.2, false)]
				}
			})
		}));
		await page.goto('/');
		await page.getByRole('tab', { name: 'city' }).click();
		await textarea(page).fill('防犯灯が切れてます');
		await judge(page).click();

		for (const [n, percent] of [
			[1, '50'],
			[2, '30'],
			[3, '20']
		] as const) {
			await expect(page.getByText(`M市 A部 B${n}課`)).toBeVisible();
			await expect(page.getByText(`出典${n}（架空）`)).toBeVisible();
			await expect(page.getByText(`${percent}%`).first()).toBeVisible();
		}
	});

	test('絞り込み不能と出典未登録を区別する', async ({ page }) => {
		// other_or_unclear は「絞り込めない」を表す正規の候補で、組織データに
		// 対応する課を持たない。出典が無いのはデータ欠落ではない。
		await stubJudge(page, () => ({
			status: 200,
			body: judgeResponse({
				mode: 'city',
				city: {
					directoryVersion: 'mcity-2026-04-01',
					fictional: true,
					candidates: [
						{
							kind: 'unroutable',
							candidateId: 'other_or_unclear',
							probability: 0.6,
							selected: true,
							label: '絞り込めない'
						},
						{
							kind: 'unit',
							candidateId: 'c9',
							probability: 0.4,
							selected: false,
							officialName: 'M市 A部 B9課',
							section: 'B9課',
							unit: null,
							matchedResponsibilities: [],
							sources: []
						}
					]
				}
			})
		}));
		await page.goto('/');
		await page.getByRole('tab', { name: 'city' }).click();
		await textarea(page).fill('よく分からない問い合わせ');
		await judge(page).click();

		// 絞り込めない候補は理由を説明し、未登録扱いにしない。
		await expect(page.getByText('絞り込めない')).toBeVisible();
		await expect(page.getByText('担当課を絞り切れませんでした')).toBeVisible();
		// 実在の課で出典が空のときだけ未登録と出す。1件だけ。
		await expect(page.getByText('出典データ未登録')).toHaveCount(1);
	});

	test('全モードで外部送信と非保存を明示する', async ({ page }) => {
		// 保存しないことと、外部へ送らないことは別。入力は Jev へ送られる。
		await page.goto('/');
		for (const mode of ['love', 'social', 'city']) {
			await page.getByRole('tab', { name: mode }).click();
			await expect(page.getByText('Jev へ送信します')).toBeVisible();
			await expect(page.getByText('保存・収集しません')).toBeVisible();
		}
	});
});

test.describe('メタ情報', () => {
	test('OGP の画像が絶対 URL になる', async ({ page }) => {
		// 相対 URL だとクローラーが解決できず、カードに画像が出ない。
		// PUBLIC_SITE_URL の設定漏れはローカルでは踏めないので、CI で見る。
		await page.goto('/');
		const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
		expect(ogImage).toMatch(/^https?:\/\//);
		expect(ogImage).toContain('/og-image.jpg');

		const twitterImage = await page.locator('meta[name="twitter:image"]').getAttribute('content');
		expect(twitterImage).toBe(ogImage);
	});

	test('OGP の必須プロパティが揃う', async ({ page }) => {
		await page.goto('/');
		for (const property of ['og:type', 'og:title', 'og:description', 'og:url']) {
			const content = await page.locator(`meta[property="${property}"]`).getAttribute('content');
			expect(content, property).toBeTruthy();
		}
		expect(await page.locator('meta[name="twitter:card"]').getAttribute('content')).toBe(
			'summary_large_image'
		);
	});

	test('og:image の宣言サイズと形式が実画像と一致する', async ({ page, request }) => {
		// 宣言と実物がずれるとカードの描画が崩れる。
		await page.goto('/');
		const width = await page.locator('meta[property="og:image:width"]').getAttribute('content');
		const height = await page.locator('meta[property="og:image:height"]').getAttribute('content');
		const declaredType = await page
			.locator('meta[property="og:image:type"]')
			.getAttribute('content');

		const response = await request.get('/og-image.jpg');
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toBe(declaredType);

		const size = jpegSize(await response.body());
		expect(String(size.width)).toBe(width);
		expect(String(size.height)).toBe(height);
	});

	test('favicon が宣言どおり配信される', async ({ page, request }) => {
		// 宣言した href がすべて実在すること。SVG 非対応環境のために
		// PNG をフォールバックとして残している。
		await page.goto('/');
		const icons = await page.locator('link[rel~="icon"]').evaluateAll((links) =>
			links.map((link) => ({
				href: (link as HTMLLinkElement).getAttribute('href'),
				type: (link as HTMLLinkElement).getAttribute('type')
			}))
		);
		expect(icons.length).toBeGreaterThanOrEqual(1);

		for (const icon of icons) {
			const response = await request.get(icon.href as string);
			expect(response.status(), icon.href as string).toBe(200);
			expect(response.headers()['content-type'], icon.href as string).toContain(
				(icon.type as string).replace('image/svg+xml', 'image/svg')
			);
		}
	});

	test('robots.txt は検索を拒否しつつ SNS を通す', async ({ request }) => {
		// 全拒否のままだと OGP のカードが表示されない。
		const body = await (await request.get('/robots.txt')).text();
		expect(body).toMatch(/User-agent:\s*Twitterbot\s*\nAllow:\s*\//);
		expect(body).toMatch(/User-agent:\s*facebookexternalhit\s*\nAllow:\s*\//);
		expect(body).toMatch(/User-agent:\s*\*\s*\nDisallow:\s*\//);
	});
});
