/**
 * `POST /api/judge`
 *
 * ブラウザから mode と text だけを受け取り、Jev を1回呼んで
 * 正規化済みの結果を返す。API キーはこの経路のサーバー側にしか存在しない。
 *
 * 契約は docs/ARCHITECTURE.md の §7。
 */

import type { Config } from '@sveltejs/adapter-vercel';
import type { RequestHandler } from './$types';
import type { JudgeResponse } from '$lib/types/judge';
import type { ErrorCode } from '$lib/types/error';
import { errorBody, errorStatus, JudgeError } from '$lib/server/errors.server';
import { evaluate } from '$lib/server/jev-client.server';
import { estimateCostUsd } from '$lib/server/jev-config.server';
import { normalizeAnswers } from '$lib/server/normalize-response.server';
import {
	buildCatalog,
	buildState,
	CITY_DIRECTORY_IS_PROVISIONAL,
	CITY_DIRECTORY_VERSION
} from '$lib/server/question-catalog.server';
import { describeFailure, validateJudgeInput } from '$lib/validation/judge-input';

/**
 * 判定は上流の retry を含めて最長 12 秒かかる。プラットフォーム側に
 * 先に切られるとアプリの 504 へ到達しないため、余裕を足して 20 秒にする。
 *
 * `split: true` が無いと、同じ config を持つ他ルートと Function を共有する。
 * 判定エンドポイントをページ SSR から隔離するため明示する。
 */
export const config: Config = {
	maxDuration: 20,
	split: true
};

const JSON_HEADERS = {
	'Content-Type': 'application/json; charset=utf-8'
};

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function failure(code: ErrorCode, requestId: string): Response {
	return jsonResponse(errorBody(code, requestId), errorStatus(code));
}

/**
 * 構造化されたサーバーログ。
 *
 * 入力本文、API キー、上流のレスポンス本文は決して含めない
 * （docs/ARCHITECTURE.md §8）。
 */
function log(fields: Record<string, unknown>): void {
	console.info(JSON.stringify({ route: 'api/judge', ...fields }));
}

export const POST: RequestHandler = async ({ request }) => {
	// requestId は入力本文から生成しない（docs/ARCHITECTURE.md §3）。
	const requestId = `req_${crypto.randomUUID()}`;
	const startedAt = performance.now();

	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().includes('application/json')) {
		log({ requestId, status: 400, code: 'INVALID_INPUT', detail: 'CONTENT_TYPE' });
		return failure('INVALID_INPUT', requestId);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		// parse 失敗。例外の内容はクライアントへ返さない。
		log({ requestId, status: 400, code: 'INVALID_INPUT', detail: 'NOT_JSON' });
		return failure('INVALID_INPUT', requestId);
	}

	const validated = validateJudgeInput(body);
	if (!validated.ok) {
		log({
			requestId,
			status: 400,
			code: 'INVALID_INPUT',
			detail: describeFailure(validated.failure, (body as { text?: unknown })?.text)
		});
		return failure('INVALID_INPUT', requestId);
	}

	const { mode, text } = validated.value;
	const catalog = buildCatalog(mode);

	try {
		const {
			result,
			latencyMs,
			config: jevConfig
		} = await evaluate(buildState(mode, text), catalog.questions);
		const results = normalizeAnswers(catalog, result);

		const response: JudgeResponse = {
			requestId,
			mode,
			model: result.model,
			// 入力検証後から正規化完了までのサーバー処理時間（§10）。
			latencyMs: Math.round(performance.now() - startedAt),
			usage: {
				inputTokens: result.usage.input_tokens,
				outputTokens: result.usage.output_tokens,
				estimatedCostUsd: estimateCostUsd(
					result.usage.input_tokens,
					jevConfig.inputPricePerMillionTokens
				)
			},
			results,
			...(mode === 'city'
				? {
						city: {
							directoryVersion: CITY_DIRECTORY_VERSION,
							provisional: CITY_DIRECTORY_IS_PROVISIONAL,
							// Phase 4 で公式データを join するまで出典は空。
							sources: []
						}
					}
				: {})
		};

		log({
			requestId,
			mode,
			status: 200,
			model: result.model,
			upstreamLatencyMs: Math.round(latencyMs),
			latencyMs: response.latencyMs,
			inputTokens: result.usage.input_tokens,
			questionCount: Object.keys(catalog.questions).length
		});

		return jsonResponse(response, 200);
	} catch (error) {
		const code = error instanceof JudgeError ? error.code : 'INTERNAL_ERROR';
		log({
			requestId,
			mode,
			status: errorStatus(code),
			code,
			latencyMs: Math.round(performance.now() - startedAt),
			detail: error instanceof JudgeError ? error.logDetail : 'unhandled'
		});
		return failure(code, requestId);
	}
};
