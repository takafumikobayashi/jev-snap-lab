import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeResponse } from '$lib/types/judge';
import type { JudgeErrorBody } from '$lib/types/error';
import { DISPLAYED_CHOICE_OPTIONS, MODES, type Mode } from '$lib/types/judge';
import { JudgeError } from '$lib/server/errors.server';
import { buildCatalog, type QuestionCatalog } from '$lib/server/question-catalog.server';

/** 質問カタログを持つモード。SPEC FIND は持たない。 */
const CATALOG_MODES = MODES.filter((mode): mode is Exclude<Mode, 'spec'> => mode !== 'spec');

// Jev への実通信を差し替える。ルート側の責務（Content-Type、JSON parse、
// 入力検証、レスポンス組み立て、エラー変換）だけを検証する。
const evaluate = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/jev-client.server', () => ({ evaluate }));

const { POST } = await import('./+server');

/** 実カタログの質問すべてに、契約を満たす答えを機械的に作る。 */
function synthesizeAnswers(catalog: QuestionCatalog): Record<string, unknown> {
	const answers: Record<string, unknown> = {};
	for (const [id, question] of Object.entries(catalog.questions)) {
		if (question.type === 'choice') {
			const keys = Object.keys(question.criteria);
			const probabilities = Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 : 0]));
			answers[id] = { type: 'choice', choice: keys[0], probabilities, confidence: 0.8 };
		} else if (question.type === 'score') {
			const levels = question.criteria.length;
			const indices = Array.from({ length: levels }, (_, i) => i);
			answers[id] = {
				type: 'score',
				score: 0,
				legend: Object.fromEntries(indices.map((i) => [i, String(question.criteria[i])])),
				probabilities: Object.fromEntries(indices.map((i) => [i, i === 0 ? 1 : 0])),
				confidence: 0.9
			};
		} else {
			answers[id] = { type: 'noul', noul: 0.42 };
		}
	}
	return answers;
}

function mockSuccess(mode: 'love' | 'social' | 'city') {
	evaluate.mockResolvedValue({
		result: {
			model: 'jev-1.13.0',
			answers: synthesizeAnswers(buildCatalog(mode)),
			usage: { input_tokens: 392, output_tokens: 65 }
		},
		latencyMs: 148,
		config: { inputPricePerMillionTokens: 0.042 }
	});
}

/** テストごとに別アドレスにして、レート制限の枠を共有しないようにする。 */
let clientAddress = '127.0.0.1';

function post(body: unknown, contentType: string | null = 'application/json'): Promise<Response> {
	const headers = new Headers();
	if (contentType !== null) headers.set('content-type', contentType);
	const request = new Request('http://localhost/api/judge', {
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
	// ハンドラが使うのは request と getClientAddress だけ。RequestEvent の
	// 全体を組み立てず、必要な部分だけを渡す。
	return POST({
		request,
		getClientAddress: () => clientAddress
	} as Parameters<typeof POST>[0]) as Promise<Response>;
}

let addressCounter = 0;

beforeEach(() => {
	evaluate.mockReset();
	vi.spyOn(console, 'info').mockImplementation(() => {});
	addressCounter += 1;
	clientAddress = `10.0.0.${addressCounter}`;
});

describe('POST /api/judge', () => {
	it('正常系で 200 と結果を返す', async () => {
		mockSuccess('love');
		const response = await post({ mode: 'love', text: 'もう君のことは忘れたはずなのに' });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

		const body = (await response.json()) as JudgeResponse;
		expect(body.mode).toBe('love');
		expect(body.model).toBe('jev-1.13.0');
		expect(body.requestId).toMatch(/^req_/);
		expect(body.results).toHaveLength(7);
		expect(typeof body.latencyMs).toBe('number');
	});

	it('カタログを持つ3モードすべて実カタログで正規化できる', async () => {
		// SPEC FIND は質問カタログを持たない。passage ごとの独立 Noul を
		// その場で組み立てるため、この検査の対象外になる。
		for (const mode of CATALOG_MODES) {
			mockSuccess(mode);
			const response = await post({ mode, text: 'テスト入力' });
			expect(response.status, mode).toBe(200);
			const body = (await response.json()) as JudgeResponse;
			const kinds = new Set(body.results.map((card) => card.kind));
			expect(kinds, mode).toEqual(new Set(['choice', 'score', 'noul']));
		}
	});

	it('usage とコスト推計を載せる', async () => {
		mockSuccess('love');
		const body = (await (await post({ mode: 'love', text: 'x' })).json()) as JudgeResponse;
		expect(body.usage?.inputTokens).toBe(392);
		expect(body.usage?.outputTokens).toBe(65);
		expect(body.usage?.estimatedCostUsd).toBeCloseTo(0.000016464, 12);
	});

	it('requestId が入力本文から導出されていない', async () => {
		mockSuccess('love');
		const a = (await (await post({ mode: 'love', text: '同じ入力' })).json()) as JudgeResponse;
		mockSuccess('love');
		const b = (await (await post({ mode: 'love', text: '同じ入力' })).json()) as JudgeResponse;
		expect(a.requestId).not.toBe(b.requestId);
	});

	describe('CITY の暫定データ', () => {
		it('公式データのバージョンと出典を返す', async () => {
			mockSuccess('city');
			const body = (await (
				await post({ mode: 'city', text: '家の前の防犯灯が切れてます' })
			).json()) as JudgeResponse;
			// 架空データを公式根拠として扱わない。固定値ではなくデータセットから導く。
			expect(body.city?.fictional).toBe(true);
			expect(body.city?.directoryVersion).toBe('mcity-2026-04-01');
			expect(body.city?.candidates.length).toBeGreaterThan(0);
			for (const candidate of body.city?.candidates ?? []) {
				if (candidate.kind !== 'unit') continue;
				expect(candidate.sources.length).toBeGreaterThan(0);
				for (const source of candidate.sources) {
					// 架空データの出典は URL を持たない。
					expect(source.url).toBeNull();
					expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				}
			}
		});

		it('入力文から係と分掌事務を join する', async () => {
			// synthesizeAnswers は criteria の先頭候補を選ぶ。先頭が
			// 危機管理課である前提に依存しないよう、解決結果の有無だけ見る。
			mockSuccess('city');
			const body = (await (
				await post({ mode: 'city', text: '家の前の防犯灯が切れてます' })
			).json()) as JudgeResponse;
			const [top] = body.city?.candidates ?? [];
			expect(top).toBeDefined();
			expect(top.kind).toBe('unit');
			if (top.kind === 'unit') expect(top.officialName).toContain('M市');
		});

		it('画面に出る上位候補すべてに根拠を付ける', async () => {
			// 選ばれた1件だけに根拠を付けると、候補が割れた入力ほど
			// 2位・3位と比べる材料が無くなる。
			mockSuccess('city');
			const body = (await (
				await post({ mode: 'city', text: '家の前の防犯灯が切れてます' })
			).json()) as JudgeResponse;

			const routeTo = body.results.find((card) => card.id === 'route_to');
			expect(routeTo?.kind).toBe('choice');
			const displayed =
				routeTo?.kind === 'choice' ? routeTo.options.slice(0, DISPLAYED_CHOICE_OPTIONS) : [];

			expect(body.city?.candidates.map((candidate) => candidate.candidateId)).toEqual(
				displayed.map((option) => option.key)
			);
			for (const candidate of body.city?.candidates ?? []) {
				// unroutable（絞り込めない）でも行としては必ず返す。
				if (candidate.kind !== 'unit') {
					expect(candidate.label).not.toBe('');
					continue;
				}
				expect(candidate.officialName).not.toBe('');
				expect(candidate.sources.length).toBeGreaterThan(0);
			}
		});

		it('選ばれた候補に印を付け、確率はカードと一致させる', async () => {
			mockSuccess('city');
			const body = (await (
				await post({ mode: 'city', text: '家の前の防犯灯が切れてます' })
			).json()) as JudgeResponse;

			const routeTo = body.results.find((card) => card.id === 'route_to');
			const selected = routeTo?.kind === 'choice' ? routeTo.selected : null;
			const marked = body.city?.candidates.filter((candidate) => candidate.selected) ?? [];
			expect(marked).toHaveLength(1);
			expect(marked[0].candidateId).toBe(selected);

			for (const candidate of body.city?.candidates ?? []) {
				const option =
					routeTo?.kind === 'choice'
						? routeTo.options.find((o) => o.key === candidate.candidateId)
						: undefined;
				expect(candidate.probability).toBe(option?.probability);
			}
		});

		it('CITY Semantic Fit は既定で無効なので追加呼び出しをしない', async () => {
			// 実験機能。CITY_SEMANTIC_EXPERIMENT が真のときだけ動かす。
			mockSuccess('city');
			const response = await post({ mode: 'city', text: '家の前の防犯灯が切れてます' });
			expect(response.status).toBe(200);
			// Stage 1 の1回だけ。
			expect(evaluate).toHaveBeenCalledTimes(1);
		});

		it('SPEC FIND は既定で無効なので 400 を返す', async () => {
			// 実験機能。SPEC_FIND_ENABLED が真のときだけ受け付ける。
			const response = await post({ mode: 'spec', text: 'Excelにデータを出したい' });
			expect(response.status).toBe(400);
			// 無効なのに上流を呼ばない。
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('LOVE / SOCIAL には city ブロックを付けない', async () => {
			for (const mode of ['love', 'social'] as const) {
				mockSuccess(mode);
				const body = (await (await post({ mode, text: 'x' })).json()) as JudgeResponse;
				expect(body.city, mode).toBeUndefined();
			}
		});
	});

	describe('リクエストの形', () => {
		it('Content-Type が JSON でなければ 400', async () => {
			const response = await post({ mode: 'love', text: 'x' }, 'text/plain');
			expect(response.status).toBe(400);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('Content-Type が無ければ 400', async () => {
			expect((await post({ mode: 'love', text: 'x' }, null)).status).toBe(400);
		});

		it('charset 付きの Content-Type を受け付ける', async () => {
			mockSuccess('love');
			const response = await post({ mode: 'love', text: 'x' }, 'application/json; charset=utf-8');
			expect(response.status).toBe(200);
		});

		it('JSON として壊れていれば 400', async () => {
			const response = await post('{ broken', 'application/json');
			expect(response.status).toBe(400);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('上限を超えるボディを Jev を呼ばずに拒否する', async () => {
			// 文字数検証の前に打ち切る。巨大なボディを読み込ませない。
			const huge = 'あ'.repeat(20_000);
			const response = await post({ mode: 'love', text: huge });
			expect(response.status).toBe(400);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('入力検証に落ちれば 400 で、Jev を呼ばない', async () => {
			for (const body of [
				{ mode: 'unknown', text: 'x' },
				{ mode: 'love', text: '   ' },
				{ mode: 'love', text: 'あ'.repeat(281) },
				{ mode: 'love', text: 'x', state: { injected: true } }
			]) {
				const response = await post(body);
				expect(response.status, JSON.stringify(body)).toBe(400);
			}
			expect(evaluate).not.toHaveBeenCalled();
		});
	});

	describe('エラー変換', () => {
		const cases = [
			['UPSTREAM_TIMEOUT', 504, true],
			['RATE_LIMITED', 429, true],
			['UPSTREAM_UNAVAILABLE', 503, true],
			['CONFIGURATION_ERROR', 500, false],
			['QUESTION_DEFINITION_ERROR', 500, false]
		] as const;

		it.each(cases)('%s を %i で返す', async (code, status, retryable) => {
			evaluate.mockRejectedValue(new JudgeError(code, '内部の詳細'));
			const response = await post({ mode: 'love', text: 'x' });
			expect(response.status).toBe(status);
			const body = (await response.json()) as JudgeErrorBody;
			expect(body.error.code).toBe(code);
			expect(body.error.retryable).toBe(retryable);
		});

		it('想定外の例外を INTERNAL_ERROR にする', async () => {
			evaluate.mockRejectedValue(new Error('boom'));
			const response = await post({ mode: 'love', text: 'x' });
			expect(response.status).toBe(500);
			expect(((await response.json()) as JudgeErrorBody).error.code).toBe('INTERNAL_ERROR');
		});

		it('エラー応答に内部情報を含めない', async () => {
			evaluate.mockRejectedValue(
				new JudgeError('CONFIGURATION_ERROR', 'TYPESAFE_API_KEY が未設定')
			);
			const raw = await (await post({ mode: 'love', text: '秘密の入力文' })).text();
			expect(raw).not.toContain('TYPESAFE_API_KEY');
			expect(raw).not.toContain('秘密の入力文');
			expect(raw).not.toContain('stack');
		});
	});

	describe('レート制限', () => {
		it('既定の上限を超えると 429 と Retry-After を返す', async () => {
			mockSuccess('love');
			// 既定は 10 requests / 分。
			for (let i = 0; i < 10; i += 1) {
				mockSuccess('love');
				expect((await post({ mode: 'love', text: 'x' })).status, `${i + 1}回目`).toBe(200);
			}
			const limited = await post({ mode: 'love', text: 'x' });
			expect(limited.status).toBe(429);
			expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
			expect(((await limited.json()) as JudgeErrorBody).error.code).toBe('RATE_LIMITED');
		});

		it('入力が壊れていても枠を消費する', async () => {
			// 壊れたリクエストの連打でサーバーを回させない。
			for (let i = 0; i < 10; i += 1) {
				expect((await post({ mode: 'bad', text: 'x' })).status).toBe(400);
			}
			expect((await post({ mode: 'love', text: 'x' })).status).toBe(429);
			expect(evaluate).not.toHaveBeenCalled();
		});

		it('送信元が違えば独立して数える', async () => {
			for (let i = 0; i < 10; i += 1) await post({ mode: 'bad', text: 'x' });
			expect((await post({ mode: 'bad', text: 'x' })).status).toBe(429);

			clientAddress = '10.9.9.9';
			expect((await post({ mode: 'bad', text: 'x' })).status).toBe(400);
		});
	});

	describe('観測ログ', () => {
		const logged = async (run: () => Promise<unknown>) => {
			const info = vi.spyOn(console, 'info').mockImplementation(() => {});
			// beforeEach で張ったスパイと同一オブジェクトなので、呼び出し履歴が
			// 前のテストから持ち越される。単独実行では通るが全体実行で壊れる。
			info.mockClear();
			await run();
			return info.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
		};

		it('成功時に p50 / p95 を出せる項目が揃う', async () => {
			// docs/ARCHITECTURE.md §12 の監視項目。
			mockSuccess('love');
			const [entry] = await logged(() => post({ mode: 'love', text: 'x' }));
			expect(entry.route).toBe('api/judge');
			expect(entry.requestId).toMatch(/^req_/);
			expect(entry.mode).toBe('love');
			expect(entry.status).toBe(200);
			expect(entry.model).toBe('jev-1.13.0');
			expect(typeof entry.latencyMs).toBe('number');
			expect(typeof entry.upstreamLatencyMs).toBe('number');
			expect(entry.inputTokens).toBe(392);
		});

		it('上流エラーを種別で数えられる', async () => {
			evaluate.mockRejectedValue(new JudgeError('RATE_LIMITED', '上流 429'));
			const [entry] = await logged(() => post({ mode: 'love', text: 'x' }));
			expect(entry.status).toBe(429);
			expect(entry.code).toBe('RATE_LIMITED');
			expect(typeof entry.latencyMs).toBe('number');
		});

		it('入力不正も種別で数えられる', async () => {
			const [entry] = await logged(() => post({ mode: 'bad', text: 'x' }));
			expect(entry.status).toBe(400);
			expect(entry.code).toBe('INVALID_INPUT');
			expect(entry.detail).toBe('INVALID_MODE');
		});

		it('ログ行が1リクエスト1行の JSON である', async () => {
			// 集計しやすさのため、複数行に分けない。
			mockSuccess('city');
			const entries = await logged(() => post({ mode: 'city', text: 'x' }));
			expect(entries).toHaveLength(1);
		});
	});

	it('ログに入力本文を出さない', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		mockSuccess('love');
		await post({ mode: 'love', text: 'ログに出てはいけない文' });
		const logged = info.mock.calls.map((call) => String(call[0])).join('\n');
		expect(logged).not.toContain('ログに出てはいけない文');
		expect(logged).toContain('req_');
	});
});
