/**
 * `POST /api/batch`
 *
 * 同梱した fixture を1テーマぶんまとめて判定する。API キーはこの経路の
 * サーバー側にしか存在しない。
 *
 * 利用者の文章は受け取らない。理由は
 * [batch-judge.server.ts](../../../lib/server/batch-judge.server.ts) にある。
 */

import type { Config } from '@sveltejs/adapter-vercel';
import type { RequestHandler } from './$types';
import type { ErrorCode } from '$lib/types/error';
import type { BatchJudgeResponse } from '$lib/types/batch';
import { errorBody, errorStatus, JudgeError } from '$lib/server/errors.server';
import { evaluate } from '$lib/server/jev-client.server';
import { estimateCostUsd } from '$lib/server/jev-config.server';
import { isBatchJudgeEnabled, runBatchJudge } from '$lib/server/batch-judge.server';
import { createRateLimiter, parseRateLimit } from '$lib/server/rate-limit.server';
import { readJsonBody } from '$lib/server/request-body.server';
import { validateBatchInput } from '$lib/validation/batch-input';
import { env } from '$env/dynamic/private';

/**
 * 実測では 50件 × 3軸（150問）で 1,000ms 前後、最大でも 1,400ms だった
 * （docs/BATCH_JUDGE_DESIGN.md §4.6）。それでも `/api/judge` と同じ
 * 20秒にしておく。上流の retry を含めた最悪値は判定1回ぶんと変わらない。
 */
export const config: Config = {
	maxDuration: 20,
	split: true
};

/** 1リクエスト全体で上流に使える時間。`/api/judge` と同じ根拠。 */
const REQUEST_BUDGET_MS = 16_000;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function jsonResponse(body: unknown, status: number, extraHeaders?: Record<string, string>) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...JSON_HEADERS, ...extraHeaders }
	});
}

function failure(code: ErrorCode, requestId: string, extraHeaders?: Record<string, string>) {
	return jsonResponse(errorBody(code, requestId), errorStatus(code), extraHeaders);
}

const rateLimit = parseRateLimit(env.APP_RATE_LIMIT_PER_MINUTE);
const rateLimiter = createRateLimiter({ limit: rateLimit.limit });

function log(fields: Record<string, unknown>): void {
	console.info(JSON.stringify({ route: 'api/batch', ...fields }));
}

function describeUnhandled(error: unknown): string {
	if (!(error instanceof Error)) return 'unknown error';
	return `${error.name}: ${error.message}`.slice(0, 200);
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();

	// 実験機能。無効なら経路そのものを見せない。
	if (!isBatchJudgeEnabled()) {
		log({ requestId, status: 404, code: 'NOT_FOUND', detail: 'BATCH_JUDGE_DISABLED' });
		return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
	}

	// 入力検証より先に見る。上流を呼ばないリクエストでも枠を消費させる。
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

	const parsed = await readJsonBody(request);
	if (!parsed.ok) {
		log({ requestId, status: 400, code: 'INVALID_INPUT', detail: parsed.reason });
		return failure('INVALID_INPUT', requestId);
	}

	const validated = validateBatchInput(parsed.value);
	if (!validated.ok) {
		log({ requestId, status: 400, code: 'INVALID_INPUT', detail: validated.failure });
		return failure('INVALID_INPUT', requestId);
	}

	try {
		let model = '';
		let pricePerMillion = 0;
		const outcome = await runBatchJudge(validated.value.theme, async (built) => {
			const { result, config: jevConfig } = await evaluate(
				built.state,
				built.questions,
				REQUEST_BUDGET_MS - (performance.now() - startedAt)
			);
			model = result.model;
			pricePerMillion = jevConfig.inputPricePerMillionTokens;
			return {
				answers: result.answers as Record<string, unknown>,
				inputTokens: result.usage.input_tokens,
				outputTokens: result.usage.output_tokens
			};
		});

		const { inputTokens, outputTokens, ...rest } = outcome;
		const response: BatchJudgeResponse = {
			requestId,
			model,
			latencyMs: Math.round(performance.now() - startedAt),
			usage: {
				inputTokens,
				outputTokens,
				estimatedCostUsd: estimateCostUsd(inputTokens, pricePerMillion)
			},
			...rest
		};

		log({
			requestId,
			theme: response.theme,
			status: 200,
			model,
			latencyMs: response.latencyMs,
			inputTokens,
			caseCount: response.caseCount,
			questionCount: response.questionCount,
			labelStatus: response.labelStatus
		});

		return jsonResponse(response, 200);
	} catch (error) {
		const code = error instanceof JudgeError ? error.code : 'INTERNAL_ERROR';
		log({
			requestId,
			theme: validated.value.theme,
			status: errorStatus(code),
			code,
			latencyMs: Math.round(performance.now() - startedAt),
			detail: error instanceof JudgeError ? error.logDetail : describeUnhandled(error)
		});
		return failure(code, requestId);
	}
};
