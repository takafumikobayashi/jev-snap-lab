import { describe, expect, it } from 'vitest';
import {
	APIConnectionError,
	APIError,
	APITimeoutError,
	APIUserAbortError,
	AuthenticationError,
	RateLimitError,
	TypeSafeError,
	UnprocessableEntityError
} from '@typesafe-ai/sdk';
import { JudgeError, mapSdkError } from './errors.server';
import { DEFAULTS, estimateCostUsd, parseJevConfig } from './jev-config.server';

const withKey = (extra: Record<string, string | undefined> = {}) =>
	parseJevConfig({ TYPESAFE_API_KEY: 'sk-test', ...extra });

describe('parseJevConfig', () => {
	it('API キーだけで既定値が埋まる', () => {
		const config = withKey();
		expect(config.defaultModel).toBe(DEFAULTS.defaultModel);
		expect(config.timeoutMs).toBe(DEFAULTS.timeoutMs);
		expect(config.totalTimeoutMs).toBe(DEFAULTS.totalTimeoutMs);
		expect(config.inputPricePerMillionTokens).toBe(DEFAULTS.inputPricePerMillionTokens);
		expect(config.baseURL).toBeUndefined();
	});

	it('1 試行の既定値が SDK 既定の 10000 より短い', () => {
		// 3 試行 + backoff が総予算に収まるようにするため（§6）。
		expect(DEFAULTS.timeoutMs).toBeLessThan(10000);
	});

	it('API キーが無ければ設定エラー', () => {
		for (const value of [undefined, '', '   ']) {
			try {
				parseJevConfig({ TYPESAFE_API_KEY: value });
			} catch (error) {
				expect((error as JudgeError).code).toBe('CONFIGURATION_ERROR');
				continue;
			}
			throw new Error('エラーが投げられなかった');
		}
	});

	it('例外メッセージに API キーの値を含めない', () => {
		try {
			parseJevConfig({ TYPESAFE_API_KEY: '  ', JEV_TIMEOUT_MS: 'abc' });
		} catch (error) {
			expect((error as Error).message).not.toContain('sk-');
		}
	});

	it('総予算が 1 試行より短い設定を拒否する', () => {
		// retry どころか初回すら完走できない。
		try {
			withKey({ JEV_TIMEOUT_MS: '8000', JEV_TOTAL_TIMEOUT_MS: '3000' });
		} catch (error) {
			expect((error as JudgeError).code).toBe('CONFIGURATION_ERROR');
			expect((error as Error).message).toContain('より短い');
			return;
		}
		throw new Error('エラーが投げられなかった');
	});

	it('数値でない値や 0 以下を拒否する', () => {
		for (const raw of ['abc', '0', '-1']) {
			expect(() => withKey({ JEV_TIMEOUT_MS: raw })).toThrow(JudgeError);
		}
	});

	it('空文字は未設定として既定値を使う', () => {
		expect(withKey({ JEV_TIMEOUT_MS: '' }).timeoutMs).toBe(DEFAULTS.timeoutMs);
		expect(withKey({ TYPESAFE_DEFAULT_MODEL: '  ' }).defaultModel).toBe(DEFAULTS.defaultModel);
	});

	it('明示した値で上書きできる', () => {
		const config = withKey({
			TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0',
			TYPESAFE_BASE_URL: 'https://example.test',
			JEV_TIMEOUT_MS: '5000',
			JEV_TOTAL_TIMEOUT_MS: '18000'
		});
		expect(config.defaultModel).toBe('jev-1.13.0');
		expect(config.baseURL).toBe('https://example.test');
		expect(config.timeoutMs).toBe(5000);
		expect(config.totalTimeoutMs).toBe(18000);
	});
});

describe('estimateCostUsd', () => {
	it('設計書の例と一致する', () => {
		// 392 / 1_000_000 * 0.042
		expect(estimateCostUsd(392, 0.042)).toBeCloseTo(0.000016464, 12);
	});

	it('0 トークンなら 0', () => {
		expect(estimateCostUsd(0, 0.042)).toBe(0);
	});
});

describe('mapSdkError', () => {
	const headers = new Headers();

	it('総予算の abort を timeout として扱う', () => {
		expect(mapSdkError(new APIUserAbortError())).toBe('UPSTREAM_TIMEOUT');
	});

	it('SDK の timeout を timeout として扱う', () => {
		expect(mapSdkError(new APITimeoutError(3500))).toBe('UPSTREAM_TIMEOUT');
	});

	it('接続失敗を上流障害として扱う', () => {
		// APITimeoutError は APIConnectionError のサブクラスなので、
		// 判定順を間違えると timeout が障害に化ける。
		expect(mapSdkError(new APIConnectionError('dns'))).toBe('UPSTREAM_UNAVAILABLE');
	});

	it('401 を設定エラーとして扱う', () => {
		expect(mapSdkError(new AuthenticationError(401, undefined, headers))).toBe(
			'CONFIGURATION_ERROR'
		);
	});

	it('422 を質問定義のバグとして扱う', () => {
		expect(mapSdkError(new UnprocessableEntityError(422, undefined, headers))).toBe(
			'QUESTION_DEFINITION_ERROR'
		);
	});

	it('429 をレート制限として扱う', () => {
		expect(mapSdkError(new RateLimitError(429, undefined, headers))).toBe('RATE_LIMITED');
	});

	it('529 を上流障害として扱う', () => {
		expect(mapSdkError(new APIError(529, undefined, headers))).toBe('UPSTREAM_UNAVAILABLE');
	});

	it('408 を timeout として扱う', () => {
		expect(mapSdkError(new APIError(408, undefined, headers))).toBe('UPSTREAM_TIMEOUT');
	});

	it('送信前の SDK 検証エラーをアプリ側のバグとして扱う', () => {
		expect(mapSdkError(new TypeSafeError('questions must not be empty'))).toBe(
			'QUESTION_DEFINITION_ERROR'
		);
	});

	it('未知の例外を内部エラーとして扱う', () => {
		expect(mapSdkError(new Error('boom'))).toBe('INTERNAL_ERROR');
		expect(mapSdkError('string')).toBe('INTERNAL_ERROR');
	});
});
