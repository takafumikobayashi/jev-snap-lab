<script lang="ts">
	import type { BatchJudgeResponse } from '$lib/types/batch';

	/**
	 * 何が起きたかを段階で見せる。
	 *
	 * **段階も所要時間もサーバーの実測値である。** 段階の名前だけを並べて
	 * 進み方を演出すると、1件あたりの時間を参考値だと注記しているのと矛盾する
	 * （docs/BATCH_JUDGE_DESIGN.md §6）。
	 *
	 * 判定中は**どの段階にいるかを出さない。** ブラウザはリクエストを1回投げて
	 * 待つだけで、サーバーがどこにいるかを知らない。知らないものを光らせない。
	 */
	let {
		response,
		pending,
		caseCount
	}: { response: BatchJudgeResponse | null; pending: boolean; caseCount: number } = $props();

	const perCase = $derived(
		response ? Math.round(response.questionCount / response.caseCount) : null
	);

	/** 段階の幅は実測時間の比。上流がほぼ全部であることが見て分かる。 */
	const steps = $derived(
		response
			? [
					{
						key: 'build',
						label: '組み立て',
						ms: response.stages.buildMs,
						detail: `${response.caseCount}件 / 本文 ${response.stateChars.toLocaleString()}字 → ${response.questionCount}問（1件あたり${perCase}問）`
					},
					{
						key: 'upstream',
						label: 'Jev へ送る',
						ms: response.stages.upstreamMs,
						detail: `${response.upstreamCalls}リクエスト・分割なし / 入力 ${response.usage.inputTokens.toLocaleString()} tokens / ${response.model}`
					},
					{
						key: 'read',
						label: '答えを戻す',
						ms: response.stages.readMs,
						detail: `${response.questionCount}問すべてに回答あり。1問でも欠けたら結果を出さない`
					},
					{
						key: 'decide',
						label: '結論を決める',
						ms: response.stages.decideMs,
						detail: 'しきい値・順位・表示はアプリ側のコード。Jevがするのは意味の判断だけ'
					}
				]
			: []
	);

	const total = $derived(steps.reduce((sum, step) => sum + step.ms, 0));
</script>

<section
	class="rounded-lg border border-neutral-300 px-4 py-3 dark:border-neutral-700"
	aria-busy={pending}
>
	<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
		<h2 class="text-xs font-semibold tracking-wide text-neutral-500">処理の流れ</h2>
		{#if response}
			<p class="font-mono text-xs text-neutral-500 tabular-nums">
				サーバー内 {total.toFixed(1)} ms
			</p>
		{:else if pending}
			<p class="text-xs text-neutral-400">
				判定中… <span class="text-neutral-500">サーバーの段階は完了後に実測値で出ます</span>
			</p>
		{/if}
	</div>

	{#if response}
		<!-- 幅は実測時間の比。上流がほぼ全部を占めることが見て分かる。 -->
		<div
			class="mt-2 flex h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
			aria-hidden="true"
		>
			{#each steps as step (step.key)}
				<span
					class="h-2 {step.key === 'upstream'
						? 'bg-sky-500'
						: 'bg-neutral-400 dark:bg-neutral-600'}"
					style="width: {Math.max(0.5, (step.ms / Math.max(total, 0.1)) * 100)}%"
				></span>
			{/each}
		</div>

		<ol class="mt-3 grid gap-2 sm:grid-cols-2">
			{#each steps as step, index (step.key)}
				<li class="text-xs">
					<span class="flex items-baseline gap-2">
						<span class="font-mono text-neutral-400 tabular-nums">{index + 1}</span>
						<span class="font-medium">{step.label}</span>
						<span class="font-mono text-neutral-500 tabular-nums">{step.ms.toFixed(1)} ms</span>
					</span>
					<span class="mt-0.5 block pl-5 text-neutral-500">{step.detail}</span>
				</li>
			{/each}
		</ol>
	{:else}
		<ol class="mt-2 grid gap-1 text-xs text-neutral-500 sm:grid-cols-2">
			<li>1. 組み立て — {caseCount}件を1件ずつのIDに割り当て、質問を作る</li>
			<li>2. Jev へ送る — 1リクエストにまとめる。分割しない</li>
			<li>3. 答えを戻す — 欠けていれば結果を出さない</li>
			<li>4. 結論を決める — しきい値と表示はアプリ側</li>
		</ol>
	{/if}
</section>
