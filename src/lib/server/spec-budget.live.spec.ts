/**
 * 配布コーパスが `state` で占めるトークン数の実測。
 *
 * 既定ではスキップする。実行すると上流を呼び、課金が発生する。
 *
 *   LIVE_JEV=1 node --env-file=.env node_modules/vitest/vitest.mjs run \
 *     --project server --reporter=verbose src/lib/server/spec-budget.live.spec.ts
 *
 * `MAX_CORPUS_CHARS` の根拠は「文字あたり何 state token か」である。コーパスを
 * 作り直すと文字数が変わるため、**根拠の数値だけが古くなる**ことが実際に起きた
 * （15,317字と書いたまま15,612字になっていた）。測り直す手順をここへ置く。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { noul } from '@typesafe-ai/sdk';
import { stateCharsOf, validateCorpus } from './spec-corpus.server';

vi.mock('$env/dynamic/private', () => ({
	env: { ...process.env, JEV_TIMEOUT_MS: '120000', JEV_TOTAL_TIMEOUT_MS: '120000' }
}));
const { evaluate } = await import('./jev-client.server');

const LIVE = process.env.LIVE_JEV === '1';

describe.runIf(LIVE)('配布コーパスの state 予算', () => {
	it('文字あたりの state token を測る', { timeout: 600_000 }, async () => {
		const corpus = validateCorpus(
			JSON.parse(readFileSync('data/spec/common-feature-2.7.json', 'utf8')),
			{ allowedHosts: ['www.digital.go.jp'] }
		);
		const chars = corpus.passages.reduce((sum, passage) => sum + stateCharsOf(passage), 0);

		// state 全体 + 質問1問。`state` と最長の質問で 32k tokens が上限。
		const state = {
			mode: 'spec',
			text: 'x',
			passages: Object.fromEntries(
				corpus.passages.map((passage, at) => [
					`c${at}`,
					{ text: passage.text, context: passage.headingPath.join(' / ') }
				])
			)
		};
		const { result } = await evaluate(state, {
			fit: noul('Does `passages.c0.text` answer `text`?', {
				true: 'It does.',
				false: 'It does not.'
			})
		});

		const tokens = result.usage.input_tokens;
		console.log(
			`\nコーパス ${chars} 字 / state + 質問1問 ${tokens} tokens ` +
				`/ 文字あたり ${(tokens / chars).toFixed(3)} / 32k の ${((tokens / 32_768) * 100).toFixed(0)}%\n`
		);
		expect(tokens).toBeGreaterThan(0);
	});
});
