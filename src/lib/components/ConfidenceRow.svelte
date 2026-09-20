<script lang="ts">
	import { confidenceBand, confidenceNote, toPercent } from '$lib/display';

	let { confidence }: { confidence: number } = $props();

	const band = $derived(confidenceBand(confidence));
	const note = $derived(confidenceNote(confidence));
</script>

<!--
	confidence は probability とは意味が違うため、必ず別行に置く。
	分布のまとまりであって正答率ではない（docs/JEV_DESIGN.md §3）。
-->
<p class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
	<span>判定のまとまり {toPercent(confidence)}%</span>
	{#if note}
		<span
			class="rounded border border-amber-500 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400"
		>
			{note}
		</span>
	{:else}
		<span class="text-neutral-400">
			{band === 'high' ? 'まとまっている' : 'やや分かれている'}
		</span>
	{/if}
</p>
