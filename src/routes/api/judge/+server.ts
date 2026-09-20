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
import { resolveUnit, sourcesFor } from '$lib/server/city-directory.server';
import { createRateLimiter, DEFAULT_OPTIONS } from '$lib/server/rate-limit.server';
import { describeFailure, validateJudgeInput } from '$lib/validation/judge-input';
import { env } from '$env/dynamic/private';

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

function jsonResponse(
	body: unknown,
	status: number,
	extraHeaders?: Record<string, string>
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...JSON_HEADERS, ...extraHeaders }
	});
}

function failure(
	code: ErrorCode,
	requestId: string,
	extraHeaders?: Record<string, string>
): Response {
	return jsonResponse(errorBody(code, requestId), errorStatus(code), extraHeaders);
}

/**
 * 送信元ごとのレート制限。
 *
 * モジュールスコープに置くので、同じインスタンスが再利用される間だけ
 * 有効な best-effort である。serverless ではインスタンスを跨がない
 * （docs/ARCHITECTURE.md §9）。
 */
const perMinute = Number(env.APP_RATE_LIMIT_PER_MINUTE);
const rateLimiter = createRateLimiter({
	limit: Number.isFinite(perMinute) && perMinute > 0 ? perMinute : DEFAULT_OPTIONS.limit
});

/**
 * 構造化されたサーバーログ。
 *
 * 入力本文、API キー、上流のレスポンス本文は決して含めない
 * （docs/ARCHITECTURE.md §8）。
 */
function log(fields: Record<string, unknown>): void {
	console.info(JSON.stringify({ route: 'api/judge', ...fields }));
}

/**
 * CITY の根拠ブロック。
 *
 * Jev が選んだ課の ID で静的データへ join する。係はローカルの
 * キーワード一致で解決し、決められない場合は課までに留める
 * （docs/CITY_DATA.md §5）。Jev に係を判定させない。
 */
function buildCityBlock(results: JudgeResponse['results'], text: string): JudgeResponse['city'] {
	const routeTo = results.find((card) => card.id === 'route_to');
	const candidateId = routeTo?.kind === 'choice' ? routeTo.selected : null;

	const resolved = candidateId ? resolveUnit(candidateId, text) : null;

	return {
		directoryVersion: CITY_DIRECTORY_VERSION,
		provisional: CITY_DIRECTORY_IS_PROVISIONAL,
		sources: candidateId ? sourcesFor(candidateId) : [],
		...(resolved
			? {
					resolvedUnit: {
						// 係まで絞れた場合だけ係を含む名称になる。絞れなければ課まで。
						officialName: resolved.unit?.officialName ?? resolved.sectionOfficialName,
						section: resolved.section,
						unit: resolved.unit?.name ?? null,
						// 一致した分掌事務。空なら課までしか絞れていない。
						matchedResponsibilities: resolved.matched.map((responsibility) => ({
							officialText: responsibility.officialText,
							responsibilityId: responsibility.responsibilityId
						}))
					}
				}
			: {})
	};
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	// requestId は入力本文から生成しない（docs/ARCHITECTURE.md §3）。
	const requestId = `req_${crypto.randomUUID()}`;
	const startedAt = performance.now();

	// 入力検証より先に見る。上流を呼ばないリクエストでも枠を消費させ、
	// 壊れたリクエストの連打でサーバーを回させない。
	const decision = rateLimiter.check(getClientAddress(), Date.now());
	if (!decision.allowed) {
		log({ requestId, status: 429, code: 'RATE_LIMITED', retryAfter: decision.retryAfterSeconds });
		return failure('RATE_LIMITED', requestId, {
			'Retry-After': String(decision.retryAfterSeconds)
		});
	}

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
			...(mode === 'city' ? { city: buildCityBlock(results, text) } : {})
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
