import type { Handle } from '@sveltejs/kit';

/**
 * 全レスポンス共通のセキュリティヘッダー。出所は docs/ARCHITECTURE.md の §8。
 *
 * 入力本文を保存しないアプリなので、判定結果を含むレスポンスは
 * 中間キャッシュにも履歴にも残さない。
 */
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);

	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

	// 判定 API は常に no-store。静的アセットは SvelteKit / Vercel の既定に任せる。
	if (event.url.pathname.startsWith('/api/')) {
		response.headers.set('Cache-Control', 'no-store');
	}

	return response;
};
