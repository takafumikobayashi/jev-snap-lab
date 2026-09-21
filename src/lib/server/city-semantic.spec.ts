import { describe, expect, it, vi } from 'vitest';
import type { JudgeResponse } from '$lib/types/judge';

vi.mock('$env/dynamic/private', () => ({ env: { CITY_SEMANTIC_EXPERIMENT: 'true' } }));

const { runCitySemanticShadow, isCitySemanticEnabled } = await import('./city-semantic.server');
const { responsibilityCandidates, routeCriteria } = await import('./city-directory.server');
const { JudgeError } = await import('./errors.server');

const candidateIds = Object.keys(routeCriteria()).filter((key) => key !== 'other_or_unclear');

/** Stage 1 の結果に相当するレスポンス。 */
function baseResponse(selected: string): JudgeResponse {
	return {
		requestId: 'req_test',
		mode: 'city',
		model: 'jev-1',
		latencyMs: 300,
		usage: { inputTokens: 2000 },
		results: [
			{
				id: 'route_to',
				kind: 'choice',
				label: '担当課候補',
				selected,
				confidence: 0.7,
				options: [{ key: selected, label: selected, probability: 0.7 }]
			}
		]
	};
}

/** 分掌テキストごとに確率を決める sender。 */
const sender = (byText: Record<string, number>, usage = 1500, output = 90) =>
	vi.fn(async (request: { state: Record<string, unknown>; questions: Record<string, unknown> }) => {
		const bag = request.state.responsibilities as Record<string, { text: string }>;
		return {
			answers: Object.fromEntries(
				Object.keys(request.questions).map((id) => {
					const position = Number(id.slice('fit_'.length));
					return [id, { type: 'noul', noul: byText[bag[`c${position}`].text] ?? 0.05 }];
				})
			),
			inputTokens: usage,
			outputTokens: output
		};
	});

describe('runCitySemanticShadow', () => {
	it('有効化されている', () => {
		expect(isCitySemanticEnabled()).toBe(true);
	});

	it('選ばれた課の分掌を最大12件送る', async () => {
		const send = sender({});
		const metrics = await runCitySemanticShadow(baseResponse('social_welfare'), 'x', 5000, send);

		expect(send).toHaveBeenCalledTimes(1);
		expect(metrics?.sent).toBe(12);
		expect(metrics?.candidateId).toBe('social_welfare');
	});

	it('同順位は条文順のまま切る', () => {
		// IDで並べ直すと `…u1.r10` が `…u1.r4` より前に来て、災害援護や
		// 戦傷病者の援護が上限で落ちる。Stage 1 の候補説明と選ばれる分掌が
		// ずれ、実験が別物を測ることになる。
		const picked = responsibilityCandidates('social_welfare', 12);
		const numbers = picked.map((candidate) =>
			Number(candidate.responsibilityId.match(/r(\d+)$/)?.[1])
		);

		// 条文順＝番号の昇順。抽象的な分掌（計画・統計）は後回しになるため飛ぶ。
		expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
		expect(picked.some((candidate) => candidate.officialText.includes('災害援護'))).toBe(true);
	});

	it('上限を外せば後回しにした分掌も入る', () => {
		// 落ちているのは「計画」「統計」のような抽象的な分掌で、順序の
		// 取りこぼしではない。
		const all = responsibilityCandidates('social_welfare', 999);
		expect(all.some((candidate) => candidate.officialText.includes('地域福祉計画'))).toBe(true);
		expect(all.some((candidate) => candidate.officialText.includes('福祉統計'))).toBe(true);
	});

	it('同じ入力なら毎回同じ並びになる', () => {
		// 実験の比較が読めなくなるため、並びを揺らさない。
		const first = responsibilityCandidates('social_welfare', 12);
		const second = responsibilityCandidates('social_welfare', 12);
		expect(first.map((c) => c.responsibilityId)).toEqual(second.map((c) => c.responsibilityId));
	});

	it('条文を送る（要約ではない）', async () => {
		// Stage 2 は分掌そのものとの適合を測る。
		const send = sender({});
		await runCitySemanticShadow(baseResponse(candidateIds[0]), 'x', 5000, send);

		const [request] = send.mock.calls[0];
		const bag = request.state.responsibilities as Record<string, { text: string }>;
		const expected = responsibilityCandidates(candidateIds[0], 12)[0].officialText;
		expect(bag.c0.text).toBe(expected);
	});

	it('state に mode と jurisdiction を入れる', async () => {
		const send = sender({});
		await runCitySemanticShadow(baseResponse(candidateIds[0]), '防犯灯が切れている', 5000, send);
		const [request] = send.mock.calls[0];
		expect(request.state.mode).toBe('city');
		expect(request.state.text).toBe('防犯灯が切れている');
		expect(request.state.jurisdiction).toBe('M市');
	});

	it('適合した分掌のIDを返す', async () => {
		const target = responsibilityCandidates(candidateIds[0], 12)[0];
		const send = sender({ [target.officialText]: 0.93 });
		const metrics = await runCitySemanticShadow(baseResponse(candidateIds[0]), 'x', 5000, send);

		expect(metrics?.hits).toEqual([target.responsibilityId]);
		expect(metrics?.topFit).toBe(0.93);
		expect(metrics?.abstained).toBe(false);
		expect(metrics?.inputTokens).toBe(1500);
		expect(metrics?.outputTokens).toBe(90);
	});

	it('全部が閾値未満なら abstain を記録する', async () => {
		const send = sender({});
		const metrics = await runCitySemanticShadow(baseResponse(candidateIds[0]), 'x', 5000, send);
		expect(metrics?.abstained).toBe(true);
		expect(metrics?.hits).toEqual([]);
		expect(metrics?.topFit).toBeNull();
	});

	it('観測値に入力本文を含めない', async () => {
		const send = sender({});
		const metrics = await runCitySemanticShadow(
			baseResponse(candidateIds[0]),
			'秘密の相談',
			5000,
			send
		);
		expect(JSON.stringify(metrics)).not.toContain('秘密の相談');
	});

	describe('走らせない条件', () => {
		it('予算が残っていなければ上流を呼ばない', async () => {
			// Stage 1 で時間を使い切っていれば、既定の結果を優先する。
			const send = sender({});
			expect(await runCitySemanticShadow(baseResponse(candidateIds[0]), 'x', 0, send)).toBeNull();
			expect(send).not.toHaveBeenCalled();
		});

		it('組織に紐づかない候補では呼ばない', async () => {
			// other_or_unclear は分掌を持たない。
			const send = sender({});
			expect(
				await runCitySemanticShadow(baseResponse('other_or_unclear'), 'x', 5000, send)
			).toBeNull();
			expect(send).not.toHaveBeenCalled();
		});

		it('route_to が無ければ呼ばない', async () => {
			const send = sender({});
			const response = { ...baseResponse(candidateIds[0]), results: [] };
			expect(await runCitySemanticShadow(response, 'x', 5000, send)).toBeNull();
			expect(send).not.toHaveBeenCalled();
		});
	});

	it('上流の契約違反を握りつぶさない', async () => {
		// 呼び出し側が既定の結果へ fallback できるよう、例外は投げる。
		await expect(
			runCitySemanticShadow(baseResponse(candidateIds[0]), 'x', 5000, async () => ({
				answers: {},
				inputTokens: 0,
				outputTokens: 0
			}))
		).rejects.toThrow(JudgeError);
	});
});
