<script lang="ts">
	import type { NoulCard } from '$lib/types/judge';
	import { toPercent } from '$lib/display';

	let { card }: { card: NoulCard } = $props();

	const yes = $derived(toPercent(card.yesProbability));
	const no = $derived(100 - yes);
</script>

<h3 class="text-sm font-medium text-neutral-500">{card.label}</h3>

<!--
	Noul は yes の確率であって confidence ではない。Choice の分布とも
	意味が違うため、同じ見た目のバーで並べない（docs/PRODUCT_SPEC.md §6）。
-->
<div class="mt-1 flex items-baseline gap-3">
	<span class="text-lg font-semibold tabular-nums">YES {yes}%</span>
	<span class="text-sm text-neutral-400 tabular-nums">NO {no}%</span>
</div>

<div class="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
	<div class="bg-neutral-800 dark:bg-neutral-300" style="width: {yes}%"></div>
	<!-- NO 側は中立の灰色にする。低い確率を赤だけで表さない。 -->
	<div class="bg-neutral-300 dark:bg-neutral-600" style="width: {no}%"></div>
</div>
