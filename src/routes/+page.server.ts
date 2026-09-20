import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/public';
import { isFictional } from '$lib/server/city-directory.server';

/** 同じ警告を毎リクエスト出さないための印。 */
let warnedAboutSiteUrl = false;

/**
 * CITY の注意文をデータセットに合わせるため、架空データかどうかを渡す。
 *
 * 実データを表示しているのに「架空の市」と書くと、注意文が事実と食い違う。
 * 逆方向の誤解（架空データを実在の自治体と思わせる）と同じくらい良くない。
 */
export const load: PageServerLoad = () => {
	// OGP は絶対 URL を要求するため、サイトの起点を環境変数から受け取る。
	// 未設定なら画像系の meta を出さない（+page.svelte）。設定漏れは
	// ローカルでは踏めないので、起動時に警告を残す。
	const siteUrl = env.PUBLIC_SITE_URL?.trim().replace(/\/$/, '') ?? '';
	if (!siteUrl && !warnedAboutSiteUrl) {
		warnedAboutSiteUrl = true;
		console.warn(
			JSON.stringify({
				route: 'page',
				warning: 'PUBLIC_SITE_URL_MISSING',
				detail: 'OGP 画像の meta を出力しない。SNS のリンク展開でカードが表示されない。'
			})
		);
	}

	return { cityFictional: isFictional(), siteUrl };
};
