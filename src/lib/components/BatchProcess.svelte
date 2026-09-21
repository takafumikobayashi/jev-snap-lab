<script lang="ts">
	import type { BatchJudgeResponse } from '$lib/types/batch';

	/**
	 * 何が起きたかを段階で見せる。
	 *
	 * **数値はすべてレスポンスの実測値である。** 判定中は「これから何をするか」を
	 * 出し、終わったら実際の値へ差し替える。件数と質問数を伏せると、1回の
	 * リクエストで全件を評価していることが伝わらない
	 * （docs/BATCH_JUDGE_DESIGN.md §6）。
	 */
	let {
		response,
		pending,
		caseCount
	}: { response: BatchJudgeResponse | null; pending: boolean; caseCount: number } = $props();

	const perCase = $derived(
		response ? Math.round(response.questionCount / response.caseCount) : null
	);

	type Step = { label: string; detail: string };

	const steps = $derived<Step[]>(
		response
			? [
					{
						label: '1. 入力を事例へ整える',
						detail: `${response.caseCount}件・本文 ${response.stateChars.toLocaleString()}字。state にはIDと本文だけを入れる`
					},
					{
						label: '2. 質問を組み立てる',
						detail: `${response.questionCount}問（1件あたり${perCase}問）。事例はオブジェクトのキーで参照し、並びは本文の内容で決める`
					},
					{
						label: '3. Jev へ送る',
						detail: `${response.upstreamCalls}リクエスト。分割しない。入力 ${response.usage.inputTokens.toLocaleString()} tokens / ${response.model}`
					},
					{
						label: '4. 答えを事例へ戻す',
						detail: `${response.questionCount}問すべてに回答あり。1問でも欠けたらこの画面は出ない`
					},
					{
						label: '5. アプリが結論を決める',
						detail: 'しきい値・順位・表示はアプリ側のコード。Jevがするのは意味の判断だけ'
					}
				]
			: [
					{ label: '1. 入力を事例へ整える', detail: `${caseCount}件を1件ずつのIDに割り当てる` },
					{ label: '2. 質問を組み立てる', detail: '1件あたりの質問数はテーマで決まる' },
					{ label: '3. Jev へ送る', detail: '1リクエストにまとめる。分割しない' },
					{ label: '4. 答えを事例へ戻す', detail: '欠けていれば結果を出さない' },
					{ label: '5. アプリが結論を決める', detail: 'しきい値と表示はアプリ側' }
				]
	);
</script>

<section class="mt-8">
	<h2 class="text-xs font-semibold tracking-wide text-neutral-500">処理の流れ</h2>
	<ol class="mt-2 space-y-1.5">
		{#each steps as step, index (step.label)}
			<li class="flex gap-3 text-xs">
				<span
					class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full
					{response
						? 'bg-neutral-500'
						: pending
							? 'animate-pulse bg-neutral-400'
							: 'bg-neutral-300 dark:bg-neutral-700'}"
					aria-hidden="true"
				></span>
				<span>
					<span class="font-medium">{step.label}</span>
					<span class="text-neutral-500"> — {step.detail}</span>
				</span>
				{#if pending && index === 2}
					<span class="text-neutral-400">送信中…</span>
				{/if}
			</li>
		{/each}
	</ol>
</section>
