<script lang="ts">
	import { DISPLAYED_CHOICE_OPTIONS, type ChoiceCard } from '$lib/types/judge';
	import { toPercent } from '$lib/display';
	import CardHeader from './CardHeader.svelte';
	import ConfidenceRow from './ConfidenceRow.svelte';

	let { card }: { card: ChoiceCard } = $props();

	// 初期表示の件数。実機の分布は尖るため、残りは畳んでおく。
	// サーバーが根拠を返す件数と同じ定数を使う（ずれると根拠の無い候補が出る）。
	const INITIAL = DISPLAYED_CHOICE_OPTIONS;
	let expanded = $state(false);

	const visible = $derived(expanded ? card.options : card.options.slice(0, INITIAL));
	const hidden = $derived(card.options.length - INITIAL);
	const selectedLabel = $derived(
		card.options.find((option) => option.key === card.selected)?.label ?? card.selected
	);
</script>

<CardHeader {card} />

<p class="mt-2">
	<!-- 選択された候補は淡い色面に ink で置く。文字自体は系列色にしない。 -->
	<span
		class="inline-block rounded-full px-3 py-1 text-sm font-semibold"
		style="background-color: var(--viz-tint)"
	>
		{selectedLabel}
	</span>
</p>

<ul class="mt-3 space-y-2">
	{#each visible as option (option.key)}
		<li>
			<div class="flex items-baseline justify-between gap-2 text-sm">
				<span class="min-w-0 break-words">{option.label}</span>
				<!-- 色だけに頼らず数値を必ず併記する（docs/PRODUCT_SPEC.md §10）。 -->
				<span class="shrink-0 text-neutral-500 tabular-nums">{toPercent(option.probability)}%</span>
			</div>
			<div
				class="mt-1 h-1.5 w-full rounded-full"
				style="background-color: var(--viz-track)"
				title="{option.label} {(option.probability * 100).toFixed(1)}%"
			>
				<!--
					候補ごとに色相を変えない。同一の問いの分布なので1色で描き、
					選ばれた候補だけ濃い段で強調する。
				-->
				<div
					class="h-1.5 rounded-full"
					style="width: {toPercent(option.probability)}%; background-color: {option.key ===
					card.selected
						? 'var(--viz-choice)'
						: 'var(--viz-choice-soft)'}"
				></div>
			</div>
		</li>
	{/each}
</ul>

{#if hidden > 0}
	<button
		type="button"
		class="mt-2 text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-900 dark:hover:text-neutral-100"
		aria-expanded={expanded}
		onclick={() => (expanded = !expanded)}
	>
		{expanded ? '候補を畳む' : `残り ${hidden} 件を表示`}
	</button>
{/if}

<ConfidenceRow confidence={card.confidence} />
