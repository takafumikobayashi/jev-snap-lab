import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '$lib/types/error';
import { errorBody, errorStatus, mapUpstreamStatus } from './errors.server';

describe('errorBody', () => {
	it('クライアント向けの4フィールドだけを返す', () => {
		const body = errorBody('UPSTREAM_TIMEOUT', 'req_test');
		expect(Object.keys(body)).toEqual(['error']);
		expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId', 'retryable']);
	});

	it('timeout は再試行可能として返す', () => {
		expect(errorBody('UPSTREAM_TIMEOUT', 'req_test').error.retryable).toBe(true);
	});

	it('入力不正とアプリ側のバグは再試行を促さない', () => {
		expect(errorBody('INVALID_INPUT', 'req_test').error.retryable).toBe(false);
		expect(errorBody('QUESTION_DEFINITION_ERROR', 'req_test').error.retryable).toBe(false);
	});

	it('すべてのコードに日本語メッセージがある', () => {
		for (const code of ERROR_CODES) {
			expect(errorBody(code, 'req_test').error.message.length).toBeGreaterThan(0);
		}
	});
});

describe('mapUpstreamStatus', () => {
	it('401 は設定エラーとして扱い、利用者へ詳細を出さない', () => {
		expect(mapUpstreamStatus(401)).toBe('CONFIGURATION_ERROR');
		expect(errorStatus(mapUpstreamStatus(401))).toBe(500);
	});

	it('422 は質問定義のバグとして扱う', () => {
		expect(mapUpstreamStatus(422)).toBe('QUESTION_DEFINITION_ERROR');
	});

	it('429 はレート制限として素通しする', () => {
		expect(mapUpstreamStatus(429)).toBe('RATE_LIMITED');
		expect(errorStatus(mapUpstreamStatus(429))).toBe(429);
	});

	it('上流の 529 を 529 のまま返さず 503 にする', () => {
		expect(mapUpstreamStatus(529)).toBe('UPSTREAM_UNAVAILABLE');
		expect(errorStatus(mapUpstreamStatus(529))).toBe(503);
	});

	it('未知の 5xx も上流障害として安全側に倒す', () => {
		expect(mapUpstreamStatus(500)).toBe('UPSTREAM_UNAVAILABLE');
		expect(mapUpstreamStatus(599)).toBe('UPSTREAM_UNAVAILABLE');
	});
});
