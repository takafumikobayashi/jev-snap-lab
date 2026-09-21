import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { batchCatalog, isBatchJudgeEnabled } from '$lib/server/batch-judge.server';

/**
 * BATCH JUDGE の画面。
 *
 * 実験機能なので、無効なら 404 にする。タブだけ出して押すとエラー、という
 * 見せ方はしない（SPEC FIND と同じ方針）。
 */
export const load: PageServerLoad = () => {
	if (!isBatchJudgeEnabled()) error(404, 'Not Found');
	return { themes: batchCatalog() };
};
