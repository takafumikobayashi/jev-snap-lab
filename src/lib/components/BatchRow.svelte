<script lang="ts">
	import { toPercent } from '$lib/display';
	import { decidingProbability } from '$lib/batch-display';
	import type { BatchJudgeResult, BatchTheme } from '$lib/types/batch';

	let {
		result,
		index,
		label,
		theme
	}: { result: BatchJudgeResult; index: number; label: string; theme: BatchTheme } = $props();

	/** 判定に効いた確率。判定に使わない軸を混ぜない。 */
	const top = $derived(decidingProbability(theme, result.signals));
</script>

<li class="grid grid-cols-[2.5rem_1fr] gap-x-3 py-2 sm:grid-cols-[2.5rem_1fr_7rem_5rem_3.5rem]">
	<span class="font-mono text-xs text-neutral-500 tabular-nums"
		>{String(index + 1).padStart(2, '0')}</span
	>
	<p class="text-sm break-words">{result.text}</p>

	<span class="col-start-2 mt-1 text-xs font-medium sm:col-start-3 sm:mt-0">{label}</span>

	<!--
		バーは確率の視覚化であって、正しさの度合いではない。数値も併記して
		色と長さだけに意味を持たせない。
	-->
	<span class="col-start-2 sm:col-start-4" aria-hidden="true">
		<span class="flex items-center gap-1">
			<span class="h-1.5 w-10 rounded-full bg-neutral-200 dark:bg-neutral-800">
				<span
					class="block h-1.5 rounded-full bg-neutral-500"
					style="width: {Math.max(2, toPercent(top))}%"
				></span>
			</span>
			<span class="font-mono text-xs text-neutral-500 tabular-nums">{toPercent(top)}%</span>
		</span>
	</span>

	<!--
		「不一致」は3文字ある。列が狭いと折り返す。実際に折り返した。

		**正解ラベルが無いときは何も出さない。** `agrees` が undefined のとき
		else へ落として「不一致」と出していた。利用者が書いた文章に正解は無い。
	-->
	<span class="col-start-2 text-xs whitespace-nowrap sm:col-start-5">
		{#if result.agrees === true}
			<span class="text-neutral-500">一致</span>
		{:else if result.agrees === false}
			<span class="font-medium text-amber-700 dark:text-amber-500">不一致</span>
		{/if}
	</span>
</li>
