/**
 * Jev クライアントの設定値の解釈。
 *
 * `$env` を読まない純粋関数にしてあるので、SvelteKit の外でもテストできる。
 * 既定値の根拠は docs/ARCHITECTURE.md の §5 / §6。
 */

import { JudgeError } from './errors.server';

export type JevConfig = {
	apiKey: string;
	defaultModel: string;
	baseURL: string | undefined;
	/** SDK へ渡す 1 試行あたりの timeout。 */
	timeoutMs: number;
	/** AbortController で強制する総予算。SDK に総予算の概念は無い。 */
	totalTimeoutMs: number;
	/** コスト推計の単価（USD / 1M input tokens）。 */
	inputPricePerMillionTokens: number;
};

export const DEFAULTS = {
	defaultModel: 'jev-latest',
	/** SDK 既定の 10,000ms から短縮する。§6 の算出根拠を参照。 */
	timeoutMs: 3500,
	totalTimeoutMs: 12000,
	inputPricePerMillionTokens: 0.042
} as const;

function readNumber(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new JudgeError('CONFIGURATION_ERROR', `${name} が正の数ではない`);
	}
	return value;
}

/**
 * 環境変数から設定を組み立てる。
 *
 * API キーが無い場合は `CONFIGURATION_ERROR` を投げる。キーの値そのものは
 * 例外メッセージにもログにも含めない。
 */
export function parseJevConfig(source: Record<string, string | undefined>): JevConfig {
	const apiKey = source.TYPESAFE_API_KEY?.trim();
	if (!apiKey) {
		throw new JudgeError('CONFIGURATION_ERROR', 'TYPESAFE_API_KEY が未設定');
	}

	const timeoutMs = readNumber(source.JEV_TIMEOUT_MS, DEFAULTS.timeoutMs, 'JEV_TIMEOUT_MS');
	const totalTimeoutMs = readNumber(
		source.JEV_TOTAL_TIMEOUT_MS,
		DEFAULTS.totalTimeoutMs,
		'JEV_TOTAL_TIMEOUT_MS'
	);

	if (totalTimeoutMs < timeoutMs) {
		// 総予算が 1 試行より短いと、retry どころか初回すら完走できない。
		throw new JudgeError(
			'CONFIGURATION_ERROR',
			`JEV_TOTAL_TIMEOUT_MS (${totalTimeoutMs}) が JEV_TIMEOUT_MS (${timeoutMs}) より短い`
		);
	}

	const baseURL = source.TYPESAFE_BASE_URL?.trim();

	return {
		apiKey,
		defaultModel: source.TYPESAFE_DEFAULT_MODEL?.trim() || DEFAULTS.defaultModel,
		baseURL: baseURL || undefined,
		timeoutMs,
		totalTimeoutMs,
		inputPricePerMillionTokens: readNumber(
			source.JEV_INPUT_PRICE_PER_MILLION_TOKENS,
			DEFAULTS.inputPricePerMillionTokens,
			'JEV_INPUT_PRICE_PER_MILLION_TOKENS'
		)
	};
}

/** input tokens からコストを推計する。output tokens は課金対象外。 */
export function estimateCostUsd(inputTokens: number, pricePerMillion: number): number {
	return (inputTokens / 1_000_000) * pricePerMillion;
}
