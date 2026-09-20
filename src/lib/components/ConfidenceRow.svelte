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
		<!--
			状態を示す色は系列色と別枠。ライトでは 3:1 未満なので、色だけに
			意味を持たせず印と文言を必ず添える。
		-->
		<span
			class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium"
			style="border-color: #fab219; color: inherit"
		>
			<span class="h-1.5 w-1.5 rounded-full" style="background-color: #fab219" aria-hidden="true"
			></span>
			{note}
		</span>
	{:else}
		<span class="text-neutral-400">
			{band === 'high' ? 'まとまっている' : 'やや分かれている'}
		</span>
	{/if}
</p>
