<script lang="ts">
	import type { ResultCard } from '$lib/types/judge';
	import ChoiceResult from './ChoiceResult.svelte';
	import NoulResult from './NoulResult.svelte';
	import ScoreResult from './ScoreResult.svelte';

	let { card }: { card: ResultCard } = $props();
</script>

<div class="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
	{#if card.kind === 'choice'}
		<ChoiceResult {card} />
	{:else if card.kind === 'score'}
		<ScoreResult {card} />
	{:else}
		<NoulResult {card} />
	{/if}
</div>
