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
import { buildCatalog, buildState } from '$lib/server/question-catalog.server';
import { buildCityBlock } from '$lib/server/city-evidence.server';
import { findSpecPassages, isSpecFindEnabled } from '$lib/server/spec-find.server';
import { createRateLimiter, parseRateLimit } from '$lib/server/rate-limit.server';
import { describeFailure, validateJudgeInput } from '$lib/validation/judge-input';
import { readJsonBody } from '$lib/server/request-body.server';
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
const rateLimit = parseRateLimit(env.APP_RATE_LIMIT_PER_MINUTE);
if (rateLimit.invalid) {
	// 設定してあるのに読めない値は設定ミス。既定値へ戻ったことを残さないと、
	// 絞ったつもりのまま 10 件/分で走り続ける。値そのものは出さない。
	console.warn(
		JSON.stringify({
			route: 'api/judge',
			warning: 'RATE_LIMIT_INVALID',
			detail: `APP_RATE_LIMIT_PER_MINUTE を正の整数として読めない。既定の ${rateLimit.limit} 件/分を使う。`
		})
	);
}
const rateLimiter = createRateLimiter({ limit: rateLimit.limit });

/**
 * 構造化されたサーバーログ。
 *
 * 入力本文、API キー、上流のレスポンス本文は決して含めない
 * （docs/ARCHITECTURE.md §8）。
 */
/**
 * JudgeError 以外の例外をログ1行に収める。
 *
 * 捕まえずに投げると SvelteKit がスタックを出すが、そのぶん応答は HTML の
 * 500 になる。捕まえて JSON で返す以上、原因の手掛かりはここに残す。
 * 上流のレスポンス本文と入力本文は jev-client 側で JudgeError に包んである
 * ため、ここへ来るのは設定ミスや実装バグで、入力文字列は含まない。
 */
function describeUnhandled(error: unknown): string {
	if (!(error instanceof Error)) return 'unknown error';
	return `${error.name}: ${error.message}`.slice(0, 200);
}

function log(fields: Record<string, unknown>): void {
	console.info(JSON.stringify({ route: 'api/judge', ...fields }));
}

/**
 * SPEC FIND の応答。
 *
 * 典型的な質問は1回で収まるが、候補数が上限を超えると engine が分割する。
 * usage は呼び出し回数ぶん合算する（docs/IMPLEMENTATION_PLAN.md §8.0）。
 */
async function respondSpecFind(
	text: string,
	requestId: string,
	startedAt: number
): Promise<Response> {
	let inputTokens = 0;
	let outputTokens = 0;
	let model = '';
	let upstreamLatencyMs = 0;
	let calls = 0;
	let pricePerMillion = 0;

	try {
		const spec = await findSpecPassages(text, async ({ state, questions }) => {
			const { result, latencyMs, config } = await evaluate(state, questions);
			calls += 1;
			inputTokens += result.usage.input_tokens;
			outputTokens += result.usage.output_tokens;
			upstreamLatencyMs += latencyMs;
			model = result.model;
			pricePerMillion = config.inputPricePerMillionTokens;
			return result.answers as Record<string, unknown>;
		});

		const response: JudgeResponse = {
			requestId,
			mode: 'spec',
			model,
			latencyMs: Math.round(performance.now() - startedAt),
			usage: {
				inputTokens,
				outputTokens,
				estimatedCostUsd: estimateCostUsd(inputTokens, pricePerMillion)
			},
			// SPEC FIND は typed judgment のカードを出さない。判定は passage ごとの
			// 独立 Noul で、結果は spec.hits に入る。
			results: [],
			spec
		};

		log({
			requestId,
			mode: 'spec',
			status: 200,
			model,
			calls,
			upstreamLatencyMs: Math.round(upstreamLatencyMs),
			latencyMs: response.latencyMs,
			inputTokens,
			hits: spec.hits.length,
			abstained: spec.abstained,
			// 出典を解決できなかった候補は画面に出さず、件数だけ残す。
			unresolved: spec.unresolved.length
		});

		return jsonResponse(response, 200);
	} catch (error) {
		const code = error instanceof JudgeError ? error.code : 'INTERNAL_ERROR';
		log({
			requestId,
			mode: 'spec',
			status: errorStatus(code),
			code,
			latencyMs: Math.round(performance.now() - startedAt),
			detail: error instanceof JudgeError ? error.logDetail : describeUnhandled(error)
		});
		return failure(code, requestId);
	}
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

	// 上限つきで読む。request.json() は本文全体を先にメモリへ展開するため、
	// 文字数を検証する前に巨大なボディを読み込んでしまう。
	const parsed = await readJsonBody(request);
	if (!parsed.ok) {
		log({ requestId, status: 400, code: 'INVALID_INPUT', detail: parsed.reason });
		return failure('INVALID_INPUT', requestId);
	}

	const validated = validateJudgeInput(parsed.value);
	if (!validated.ok) {
		log({
			requestId,
			status: 400,
			code: 'INVALID_INPUT',
			detail: describeFailure(validated.failure, (parsed.value as { text?: unknown })?.text)
		});
		return failure('INVALID_INPUT', requestId);
	}

	const { mode, text } = validated.value;

	// SPEC FIND は実験機能。無効なら未知のモードと同じ扱いにする。
	if (mode === 'spec' && !isSpecFindEnabled()) {
		log({ requestId, status: 400, code: 'INVALID_INPUT', detail: 'SPEC_FIND_DISABLED' });
		return failure('INVALID_INPUT', requestId);
	}

	if (mode === 'spec') return await respondSpecFind(text, requestId, startedAt);

	// catalog の生成は try の中で行う。CITY は候補データを読むため、
	// データセットの設定ミスがここで例外になる。外に出すと未捕捉になり、
	// クライアントが待っている JSON ではなく HTML の 500 が返る。
	try {
		const catalog = buildCatalog(mode);
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
			detail: error instanceof JudgeError ? error.logDetail : describeUnhandled(error)
		});
		return failure(code, requestId);
	}
};
