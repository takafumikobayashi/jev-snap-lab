/**
 * デプロイ先の受入確認。
 *
 *   node scripts/check-deployment.mjs https://<デプロイ先>
 *   node scripts/check-deployment.mjs https://<デプロイ先> --smoke
 *
 * `--smoke` を付けると実際に判定を1回だけ実行する。上流に課金が発生する
 * ため既定では行わない（1回あたり $0.0001 未満）。
 *
 * 確認項目は docs/ARCHITECTURE.md の §11 と docs/DEPLOY.md に対応する。
 */

import { cityChecks } from './lib/city-smoke.mjs';
import { statusDetail, withRateLimitRetry } from './lib/rate-limit-retry.mjs';

const [, , rawUrl, ...flags] = process.argv;
if (!rawUrl) {
	console.error('usage: check-deployment.mjs <url> [--smoke]');
	process.exit(1);
}
const base = rawUrl.replace(/\/$/, '');
const runSmoke = flags.includes('--smoke');

const results = [];
const check = (name, ok, detail = '') => {
	results.push({ name, ok, detail });
	console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

/**
 * `/api/judge` を叩く。レート制限は入力検証より先に評価されるため、
 * 不正リクエストの確認も枠を消費する。上限の低いデプロイで自分自身を
 * 締め出さないよう、429 は Retry-After を待って一度だけやり直す。
 */
const judge = (body) =>
	withRateLimitRetry(
		() =>
			fetch(`${base}/api/judge`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
		{ log: (message) => console.log(`  ..   ${message}`) }
	);

async function main() {
	console.log(`対象: ${base}\n`);

	// --- トップページとヘッダー ---
	const top = await fetch(base);
	check('トップページが 200', top.status === 200, `status=${top.status}`);

	const csp = top.headers.get('content-security-policy') ?? '';
	for (const directive of [
		"default-src 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'"
	]) {
		check(`CSP に ${directive}`, csp.includes(directive));
	}
	check('CSP の script-src が nonce 付き', /script-src[^;]*'nonce-/.test(csp));
	check("CSP に style-src 'unsafe-inline'", /style-src[^;]*'unsafe-inline'/.test(csp));

	check('nosniff', top.headers.get('x-content-type-options') === 'nosniff');
	check(
		'Referrer-Policy',
		top.headers.get('referrer-policy') === 'strict-origin-when-cross-origin'
	);

	const html = await top.text();

	// --- OGP ---
	const ogImage = html.match(/property="og:image" content="([^"]+)"/)?.[1];
	check('og:image が絶対 URL', !!ogImage && /^https?:\/\//.test(ogImage), ogImage ?? '(無し)');
	check('og:image が自サイトを指す', !!ogImage && ogImage.startsWith(base), ogImage ?? '');
	check('og:url がある', /property="og:url"/.test(html));
	check('twitter:card が summary_large_image', html.includes('content="summary_large_image"'));

	// --- 静的ファイル ---
	for (const [path, type] of [
		['/og-image.jpg', 'image/jpeg'],
		['/favicon.svg', 'image/svg'],
		['/favicon.png', 'image/png']
	]) {
		const res = await fetch(`${base}${path}`);
		check(
			`${path} が配信される`,
			res.status === 200 && (res.headers.get('content-type') ?? '').includes(type),
			`status=${res.status} type=${res.headers.get('content-type')}`
		);
	}

	// --- robots.txt ---
	const robots = await (await fetch(`${base}/robots.txt`)).text();
	check('robots が検索を拒否', /User-agent:\s*\*\s*\nDisallow:\s*\//.test(robots));
	check('robots が Twitterbot を許可', /User-agent:\s*Twitterbot\s*\nAllow:\s*\//.test(robots));
	check(
		'robots が facebookexternalhit を許可',
		/User-agent:\s*facebookexternalhit\s*\nAllow:\s*\//.test(robots)
	);

	// --- API（上流を呼ばない経路） ---
	const badRequest = await judge({ mode: 'love', text: '   ' });
	check('入力不正が 400', badRequest.status === 400, statusDetail(badRequest));
	check('判定 API が no-store', badRequest.headers.get('cache-control') === 'no-store');
	const badBody = await badRequest.json();
	check('エラーに内部情報を含めない', !JSON.stringify(badBody).includes('TYPESAFE'));

	const tooLarge = await judge({ mode: 'love', text: 'あ'.repeat(20_000) });
	check('巨大なボディが 400', tooLarge.status === 400, statusDetail(tooLarge));

	// --- 判定の1往復（任意） ---
	if (runSmoke) {
		const smoke = await judge({ mode: 'city', text: '家の前の防犯灯が切れてます' });
		const body = await smoke.json();
		check('判定が 200', smoke.status === 200, statusDetail(smoke));
		if (smoke.status === 200) {
			check('カードが返る', body.results?.length > 0, `${body.results?.length} 枚`);
			check('model が返る', typeof body.model === 'string', body.model);
			check(
				'usage が返る',
				typeof body.usage?.inputTokens === 'number',
				`${body.usage?.inputTokens} tok`
			);
			// CITY の確認は cityChecks() に切り出してある。そこだけ単体テストで
			// 「壊れたレスポンスを落とせること」を固定している。
			for (const result of cityChecks(body)) {
				check(result.name, result.ok, result.detail);
			}
		} else {
			check('判定のエラー内容', false, JSON.stringify(body).slice(0, 160));
		}
	} else {
		console.log('\n  (判定の1往復は --smoke で実行。上流に課金が発生する)');
	}

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} 件 OK`);
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error('確認に失敗:', error.message);
	process.exit(1);
});
