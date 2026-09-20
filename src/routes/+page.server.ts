import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/public';
import { isFictional } from '$lib/server/city-directory.server';

/**
 * CITY の注意文をデータセットに合わせるため、架空データかどうかを渡す。
 *
 * 実データを表示しているのに「架空の市」と書くと、注意文が事実と食い違う。
 * 逆方向の誤解（架空データを実在の自治体と思わせる）と同じくらい良くない。
 */
export const load: PageServerLoad = () => {
	return {
		cityFictional: isFictional(),
		siteUrl: env.PUBLIC_SITE_URL?.trim().replace(/\/$/, '') ?? ''
	};
};
