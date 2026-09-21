import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: { BATCH_JUDGE_ENABLED: 'true' } }));

const { isBatchJudgeEnabled, runBatchJudge, loadDataset, batchCatalog } =
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
/** 例文の本文。API は渡された文章だけを判定する。 */
const samplesOf = (theme: 'privacy' | 'deadline' | 'dx') =>
	loadDataset(theme).cases.map((item) => item.text);
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
		const outcome = await runBatchJudge('privacy', send, samplesOf('privacy'));

		expect(send).toHaveBeenCalledTimes(1);
		expect(outcome.caseCount).toBe(50);
		expect(outcome.questionCount).toBe(150);
	});

	it('PRIVACY は identifies か personal で要確認にする', async () => {
		// sensitive だけが高くても要確認にしない（§3.1）。
		const send = sender((id) => noul(id.endsWith('__sensitive') ? 0.96 : 0.05));
		const outcome = await runBatchJudge('privacy', send, samplesOf('privacy'));

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
		const outcome = await runBatchJudge('deadline', send, samplesOf('deadline'));
		expect(outcome.results.every((result) => result.verdict === 'soon')).toBe(true);
		expect(outcome.referenceDate).toBe('2026-09-21');
	});

	it('本文をそのまま返す', async () => {
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send, ['貼った文章']);
		expect(outcome.results[0].text).toBe('貼った文章');
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
		await expect(runBatchJudge('privacy', send, samplesOf('privacy'))).rejects.toThrow(JudgeError);
	});

	it('上流が gold を知らされていない', async () => {
		// 送ったものを直接見る。型だけでは守れない。
		const send = sender(() => noul(0.1));
		await runBatchJudge('privacy', send, samplesOf('privacy'));
		const sent = JSON.stringify(send.mock.calls[0][0]);
		expect(sent).not.toContain('"gold"');
		expect(sent).not.toContain('"note"');
	});
});

describe('評価の概念を持たない', () => {
	// **自由に貼った50件に正解は無い。** 以前は本文が例文と完全一致したときだけ
	// gold を付けていたが、「たまたま例文と同じだったときだけ一致率が出る」と
	// いう不可解な挙動になっていた。評価は benchmark の仕事である。
	it('結果に gold も一致も入れない', async () => {
		const sample = loadDataset('privacy').cases[0];
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send, [sample.text, '自分で書いた文章']);

		for (const result of outcome.results) {
			expect(result).not.toHaveProperty('gold');
			expect(result).not.toHaveProperty('agrees');
		}
	});

	it('例文と同じ本文でも扱いを変えない', async () => {
		const sample = loadDataset('dx').cases[0];
		const send = sender(() => choice('bpr'));
		const outcome = await runBatchJudge('dx', send, [sample.text, '別の文章']);
		expect(JSON.stringify(outcome.results[0])).toBe(JSON.stringify({ ...outcome.results[0] }));
		expect(Object.keys(outcome.results[0])).toEqual(Object.keys(outcome.results[1]));
	});

	it('レスポンスにラベルの状態を持たない', async () => {
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send, ['あ']);
		expect(outcome).not.toHaveProperty('labelStatus');
		expect(outcome).not.toHaveProperty('datasetFingerprint');
		expect(outcome).not.toHaveProperty('userProvided');
	});

	it('同じ文章を2度渡しても並びが決まる', async () => {
		// 本文のハッシュで並べるため、同じ本文はIDで決着させる。
		const send = sender(() => noul(0.1));
		await runBatchJudge('dx', send, ['同じ文', '同じ文', '別の文']);
		await runBatchJudge('dx', send, ['同じ文', '同じ文', '別の文']);
		const order = (request: { state: Record<string, unknown> }) =>
			Object.keys(request.state.cases as Record<string, unknown>);
		expect(order(send.mock.calls[1][0])).toEqual(order(send.mock.calls[0][0]));
	});

	it('処理の内訳を返す', async () => {
		// 画面の「処理の流れ」はこの値を出す。手で書かない。
		const send = sender(() => noul(0.1));
		const outcome = await runBatchJudge('privacy', send, ['あいう', 'かきくけこ']);
		expect(outcome.stateChars).toBe(8);
		expect(outcome.upstreamCalls).toBe(1);
		expect(outcome.stages.upstreamMs).toBeGreaterThanOrEqual(0);
	});
});
