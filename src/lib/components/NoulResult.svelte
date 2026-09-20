<script lang="ts">
	import type { NoulCard } from '$lib/types/judge';
	import { toPercent } from '$lib/display';
	import CardHeader from './CardHeader.svelte';

	let { card }: { card: NoulCard } = $props();

	const yes = $derived(toPercent(card.yesProbability));
	const no = $derived(100 - yes);
</script>

<CardHeader {card} />

<!--
	Noul は yes の確率であって confidence ではない。Choice の分布とも
	意味が違うため、色も分割の見た目も変える（docs/PRODUCT_SPEC.md §6）。
	ライト時のコントラストが 3:1 未満のため、数値ラベルを必ず出す。
-->
<div class="mt-2 flex items-baseline gap-3">
	<span class="text-lg font-semibold tabular-nums">YES {yes}%</span>
	<span class="text-sm text-neutral-400 tabular-nums">NO {no}%</span>
</div>

<div
	class="mt-2 flex h-1.5 w-full gap-[2px] overflow-hidden"
	title="YES {(card.yesProbability * 100).toFixed(1)}%"
>
	<div class="rounded-full" style="width: {yes}%; background-color: var(--viz-noul)"></div>
	<!-- NO 側は中立色。低い確率を赤だけで表さない。 -->
	<div class="rounded-full" style="width: {no}%; background-color: var(--viz-track)"></div>
</div>
