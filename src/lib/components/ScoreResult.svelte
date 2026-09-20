<script lang="ts">
	import type { ScoreCard } from '$lib/types/judge';
	import { scoreDisplayLabel, scoreEndLabels, scoreMeterPercent } from '$lib/display';
	import CardHeader from './CardHeader.svelte';
	import ConfidenceRow from './ConfidenceRow.svelte';

	let { card }: { card: ScoreCard } = $props();

	// 表示ラベルは probabilities の最大レベルから引く。score の丸めは使わない。
	const label = $derived(scoreDisplayLabel(card));
	const percent = $derived(scoreMeterPercent(card));
	const ends = $derived(scoreEndLabels(card));
</script>

<CardHeader {card} />

<p class="mt-2 text-lg font-semibold">{label}</p>

<div
	class="mt-3"
	role="meter"
	aria-valuemin={0}
	aria-valuemax={100}
	aria-valuenow={Math.round(percent)}
	aria-valuetext="{label}（{ends.low} から {ends.high} の尺度）"
	title="score {card.score.toFixed(2)}（0 〜 {Object.keys(card.legend).length - 1}）"
>
	<div class="relative h-1.5 w-full rounded-full" style="background-color: var(--viz-track)">
		<!-- 尺度の起点から現在位置までを塗り、「どこまで来ているか」を示す。 -->
		<div
			class="absolute top-0 left-0 h-1.5 rounded-full"
			style="width: {percent}%; background-color: var(--viz-score)"
		></div>
		<!-- 位置の印。重なるので 2px の地色リングで縁取る。 -->
		<div
			class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
			style="left: {percent}%; background-color: var(--viz-score); border-color: var(--page-bg)"
		></div>
	</div>
	<!-- 尺度の意味が分かるよう両端のラベルを常に出す。 -->
	<div class="mt-1.5 flex justify-between gap-2 text-xs text-neutral-400">
		<span class="min-w-0 break-words">{ends.low}</span>
		<span class="min-w-0 text-right break-words">{ends.high}</span>
	</div>
</div>

<ConfidenceRow confidence={card.confidence} />
