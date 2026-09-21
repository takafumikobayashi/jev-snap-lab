import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: { BATCH_JUDGE_ENABLED: 'true' } }));

const { isBatchJudgeEnabled, runBatchJudge, loadDataset, batchCatalog, summarizeResults } =
	await import('./batch-judge.server');
const { JudgeError } = await import('./errors.server');

/** 契約どおりに答える上流。テストごとにここから1点だけ壊す。 */
function sender(answerFor: (questionId: string) => unknown) {
	return vi.fn(
		async (request: { state: Record<string, unknown>; questions: Record<string, unknown> }) => ({
			answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, answerFor(id)])),
			inputTokens: 18_000,
			outputTokens: 3_000
		})
	);
}

const noul = (value: number) => ({ type: 'noul', noul: value });
const choice = (value: string) => ({ type: 'choice', choice: value, confidence: 0.8 });

describe('isBatchJudgeEnabled', () => {
	it('明示的な true でだけ有効になる', () => {
		expect(isBatchJudgeEnabled()).toBe(true);
	});
});

describe('batchCatalog', () => {
	it('件数をデータから作る', () => {
		// 画面に出す件数を手で書かない。fixture を増減したら追随する。
		expect(
			batchCatalog().map(({ theme, cases, samples }) => ({
				theme,
				cases,
				samples: samples.length
			}))
		).toEqual([
			{ theme: 'privacy', cases: 50, samples: 50 },
			{ theme: 'deadline', cases: 50, samples: 50 },
			{ theme: 'dx', cases: 50, samples: 50 }
		]);
		// 例文そのものを渡す。自分の文章を貼らずに確認できるようにするため。
		expect(batchCatalog()[0].samples[0]).toBe(loadDataset('privacy').cases[0].text);
	});
});

describe('runBatchJudge', () => {
	it('1回の上流呼び出しで全件を評価する', async () => {
		// 分割しない。実測で入力tokenが増え、実時間も伸びた（§4.6）。
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send);

		expect(send).toHaveBeenCalledTimes(1);
		expect(outcome.caseCount).toBe(50);
		expect(outcome.questionCount).toBe(150);
	});

	it('PRIVACY は identifies か personal で要確認にする', async () => {
		// sensitive だけが高くても要確認にしない（§3.1）。
		const send = sender((id) => noul(id.endsWith('__sensitive') ? 0.96 : 0.05));
		const outcome = await runBatchJudge('privacy', send);

		expect(outcome.results.every((result) => result.verdict === 'no_signal')).toBe(true);
		// 判定に使わない軸も理由として返す。閾値を変えるのに再実行させない。
		expect(outcome.results[0].signals.map((signal) => signal.key)).toEqual([
			'identifies',
			'personal',
			'sensitive'
		]);
	});

	it('Choice のテーマは選ばれた値をそのまま結論にする', async () => {
		const send = sender(() => choice('soon'));
		const outcome = await runBatchJudge('deadline', send);
		expect(outcome.results.every((result) => result.verdict === 'soon')).toBe(true);
		expect(outcome.referenceDate).toBe('2026-09-21');
	});

	it('gold との一致を事例ごとに返す', async () => {
		const dataset = loadDataset('dx');
		const send = sender(() => choice('bpr'));
		const outcome = await runBatchJudge('dx', send);

		for (const [index, result] of outcome.results.entries()) {
			expect(result.agrees).toBe(dataset.cases[index].gold === 'bpr');
		}
	});

	it('本文を返し、ラベルの確認状態を一緒に返す', async () => {
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send);
		expect(outcome.results[0].text).toBe(loadDataset('privacy').cases[0].text);
		// 一致率を状態なしで画面へ出せないようにする。
		expect(outcome.labelStatus).toBe('draft');
	});

	it('指紋が fixture の内容で決まる', async () => {
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send);
		expect(outcome.datasetFingerprint).toMatch(/^sha256-[0-9a-f]{16}$/);
	});

	it('answer が欠けたら結果を返さない', async () => {
		// 一部だけ返すと、見ていない事例が「要確認シグナルなし」と並ぶ。
		const send = vi.fn(async (request: { questions: Record<string, unknown> }) => {
			const ids = Object.keys(request.questions).slice(1);
			return {
				answers: Object.fromEntries(ids.map((id) => [id, noul(0.1)])),
				inputTokens: 1,
				outputTokens: 1
			};
		});
		await expect(runBatchJudge('privacy', send)).rejects.toThrow(JudgeError);
	});

	it('上流が gold を知らされていない', async () => {
		// 送ったものを直接見る。型だけでは守れない。
		const send = sender(() => noul(0.1));
		await runBatchJudge('privacy', send);
		const sent = JSON.stringify(send.mock.calls[0][0]);
		expect(sent).not.toContain('"gold"');
		expect(sent).not.toContain('"note"');
	});
});

describe('利用者の文章を判定する', () => {
	it('渡した文章をそのまま事例にする', async () => {
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send, [
			'明日の会議室を予約したい',
			'来客用の駐車場'
		]);

		expect(outcome.caseCount).toBe(2);
		expect(outcome.questionCount).toBe(6);
		expect(outcome.userProvided).toBe(true);
		expect(outcome.results.map((result) => result.text)).toEqual([
			'明日の会議室を予約したい',
			'来客用の駐車場'
		]);
	});

	it('正解の無い文章に一致を出さない', async () => {
		// 無い gold をでっち上げない。
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send, ['これは例文ではない文章']);
		expect(outcome.results[0].gold).toBeUndefined();
		expect(outcome.results[0].agrees).toBeUndefined();
	});

	it('本文が例文と一致すれば gold を付ける', async () => {
		// 例文をそのまま貼れば一致率が出る。
		const sample = loadDataset('privacy').cases[0];
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send, [sample.text]);
		expect(outcome.results[0].gold).toBe(sample.gold);
		expect(outcome.results[0].agrees).toBe(true);
	});

	it('同じ文章を2度渡しても並びが決まる', async () => {
		// 本文のハッシュで並べるため、同じ本文はIDで決着させる。
		const send = sender(() => noul(0.1));
		const first = await runBatchJudge('dx', send, ['同じ文', '同じ文', '別の文']);
		const second = await runBatchJudge('dx', send, ['同じ文', '同じ文', '別の文']);
		const order = (request: { state: Record<string, unknown> }) =>
			Object.keys(request.state.cases as Record<string, unknown>);
		expect(order(send.mock.calls[send.mock.calls.length - 1][0])).toEqual(
			order(send.mock.calls[send.mock.calls.length - 2][0])
		);
		expect(first.caseCount).toBe(3);
		expect(second.caseCount).toBe(3);
	});

	it('利用者の文章でも gold を上流へ送らない', async () => {
		const sample = loadDataset('privacy').cases[1];
		const send = sender(() => noul(0.1));
		await runBatchJudge('privacy', send, [sample.text]);
		expect(JSON.stringify(send.mock.calls[0][0])).not.toContain('"gold"');
	});

	it('例文を判定したときは userProvided を立てない', async () => {
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send);
		expect(outcome.userProvided).toBe(false);
	});

	it('処理の内訳を返す', async () => {
		// 画面の「処理の流れ」はこの値を出す。手で書かない。
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send, ['あいう', 'かきくけこ']);
		expect(outcome.stateChars).toBe(8);
		expect(outcome.upstreamCalls).toBe(1);
	});
});

describe('summarizeResults', () => {
	it('確認状態を落とさずに要約する', async () => {
		const send = sender(() => choice('bpr'));
		const outcome = await runBatchJudge('dx', send);
		const summary = summarizeResults({
			requestId: 'r',
			model: 'jev-1',
			latencyMs: 1,
			usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
			...outcome
		});
		expect(summary.total).toBe(50);
		expect(summary.labelStatus).toBe('draft');
		expect(summary.perGold.bpr).toBeGreaterThan(0);
	});
});
