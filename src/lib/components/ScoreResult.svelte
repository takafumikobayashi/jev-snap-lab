<script lang="ts">
	import type { ScoreCard } from '$lib/types/judge';
	import { scoreDisplayLabel, scoreEndLabels, scoreMeterPercent } from '$lib/display';
	import ConfidenceRow from './ConfidenceRow.svelte';

	let { card }: { card: ScoreCard } = $props();

	// 表示ラベルは probabilities の最大レベルから引く。score の丸めは使わない。
	const label = $derived(scoreDisplayLabel(card));
	const percent = $derived(scoreMeterPercent(card));
	const ends = $derived(scoreEndLabels(card));
</script>

<h3 class="text-sm font-medium text-neutral-500">{card.label}</h3>

<p class="mt-1 text-lg font-semibold">{label}</p>

<div
	class="mt-3"
	role="meter"
	aria-valuemin={0}
	aria-valuemax={100}
	aria-valuenow={Math.round(percent)}
	aria-valuetext="{label}（{ends.low} から {ends.high} の尺度）"
>
	<div class="relative h-1.5 w-full rounded-full bg-neutral-200 dark:bg-neutral-700">
		<div
			class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-neutral-900 dark:border-neutral-900 dark:bg-neutral-100"
			style="left: {percent}%"
		></div>
	</div>
	<!-- 尺度の意味が分かるよう両端のラベルを常に出す。 -->
	<div class="mt-1.5 flex justify-between gap-2 text-xs text-neutral-400">
		<span class="min-w-0 break-words">{ends.low}</span>
		<span class="min-w-0 text-right break-words">{ends.high}</span>
	</div>
</div>

<ConfidenceRow confidence={card.confidence} />
