<script lang="ts">
	import { toPercent } from '$lib/display';
	import { decidingProbability, verdictStyle } from '$lib/batch-display';
	import type { BatchJudgeResult, BatchTheme } from '$lib/types/batch';

	let {
		result,
		index,
		label,
		theme
	}: { result: BatchJudgeResult; index: number; label: string; theme: BatchTheme } = $props();

	/** 判定に効いた確率。判定に使わない軸を混ぜない。 */
	const top = $derived(decidingProbability(theme, result.signals));
	const style = $derived(verdictStyle(result.verdict));
</script>

<li class="grid grid-cols-[2.5rem_1fr] gap-x-3 py-2 sm:grid-cols-[2.5rem_1fr_9rem_5rem]">
	<span class="font-mono text-xs text-neutral-500 tabular-nums"
		>{String(index + 1).padStart(2, '0')}</span
	>
	<p class="text-sm break-words">{result.text}</p>

	<!-- 色だけに意味を持たせない。結論は文字でも出す。 -->
	<span
		class="col-start-2 mt-1 flex items-center gap-1.5 text-xs font-medium sm:col-start-3 sm:mt-0"
	>
		<span class="h-2 w-2 shrink-0 rounded-full {style.bar}" aria-hidden="true"></span>
		<span class={style.text}>{label}</span>
	</span>

	<!--
		バーは確率の視覚化であって、正しさの度合いではない。数値も併記して
		色と長さだけに意味を持たせない。
	-->
	<span class="col-start-2 sm:col-start-4" aria-hidden="true">
		<span class="flex items-center gap-1">
			<span class="h-1.5 w-10 rounded-full bg-neutral-200 dark:bg-neutral-800">
				<span
					class="block h-1.5 rounded-full {style.bar}"
					style="width: {Math.max(2, toPercent(top))}%"
				></span>
			</span>
			<span class="font-mono text-xs text-neutral-500 tabular-nums">{toPercent(top)}%</span>
		</span>
	</span>
</li>
