/**
 * TypeSafe 公式 SDK の server-only ラッパー。
 *
 * このモジュールだけが API キーに触れる。`$lib/server` 配下は SvelteKit が
 * クライアントバンドルへの取り込みを禁止するため、キーがブラウザへ出ない。
 * `dangerouslyAllowBrowser` は使わない。
 */

import { env } from '$env/dynamic/private';
import { TypeSafeClient, type Questions, type SystemOneResult } from '@typesafe-ai/sdk';
import { JudgeError, mapSdkError } from './errors.server';
import { parseJevConfig, type JevConfig } from './jev-config.server';
import { findQuestionDefects } from './question-validation.server';
import type { JudgeState } from './question-catalog.server';
import type { JsonValue } from '$lib/types/semantic';

/**
 * 上流へ送る state。
 *
 * LOVE / SOCIAL / CITY は `JudgeState`、SPEC FIND は候補passageを含む
 * 別の形を送る。どちらもJSONへ直列化できることだけを共通の制約とする。
 */
export type EvaluateState = JudgeState | Record<string, JsonValue>;

let cached: { client: TypeSafeClient; config: JevConfig } | null = null;

/**
 * クライアントを一度だけ生成して使い回す。
 *
 * ログレベルは既定の `warn` のまま。SDK は `debug` でリクエストボディも
 * 出力するため、本番で有効にしない（docs/ARCHITECTURE.md §8）。
 */
function getClient(): { client: TypeSafeClient; config: JevConfig } {
	if (cached) return cached;

	const config = parseJevConfig(env);
	const client = new TypeSafeClient({
		apiKey: config.apiKey,
		defaultModel: config.defaultModel,
		...(config.baseURL ? { baseURL: config.baseURL } : {}),
		// 1 試行あたり。SDK 既定の 10,000ms から短縮する。
		timeout: config.timeoutMs
		// retry は SDK 既定のまま（maxRetries: 2、408/429/5xx、Retry-After 尊重）。
		// アプリ側で同じ retry を二重実装しない。
	});

	cached = { client, config };
	return cached;
}

/** テスト用。モジュールキャッシュを跨いで設定を読み直す。 */
export function resetJevClient(): void {
	cached = null;
}

export type EvaluateResult = {
	result: SystemOneResult<Questions>;
	latencyMs: number;
	config: JevConfig;
};

/**
 * 1 回の判定を実行する。
 *
 * SDK に総 retry 予算は無いため、`AbortSignal` で総時間の上限を強制する。
 * この signal は送信中のリクエストだけでなく**待機中の retry も中断する**
 * ため、`Retry-After` による長い待機もここで打ち切られる。
 */
export async function evaluate(
	state: EvaluateState,
	questions: Questions
): Promise<EvaluateResult> {
	const { client, config } = getClient();

	// 送信前に criteria の形を確認する。ここで弾けば 422 を往復せずに済む。
	const defects = findQuestionDefects(questions);
	if (defects.length > 0) {
		throw new JudgeError(
			'QUESTION_DEFINITION_ERROR',
			defects.map((defect) => `${defect.questionId}: ${defect.reason}`).join(' / ')
		);
	}

	const controller = new AbortController();
	const budget = setTimeout(() => controller.abort(), config.totalTimeoutMs);
	const startedAt = performance.now();

	try {
		const result = await client.systemOne({ state, questions }, { signal: controller.signal });
		return { result, latencyMs: performance.now() - startedAt, config };
	} catch (error) {
		throw new JudgeError(mapSdkError(error), describeForLog(error));
	} finally {
		clearTimeout(budget);
	}
}

/**
 * サーバーログ用の短い説明。
 *
 * 入力本文、API キー、上流のレスポンス本文を含めない。status と例外名だけ
 * 残せば、requestId と突き合わせて原因を追える。
 */
function describeForLog(error: unknown): string {
	if (error instanceof Error) {
		const status = (error as { status?: unknown }).status;
		return typeof status === 'number' ? `${error.name} (status ${status})` : error.name;
	}
	return 'unknown error';
}
