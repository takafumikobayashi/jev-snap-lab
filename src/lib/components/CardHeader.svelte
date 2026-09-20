<script lang="ts">
	import type { ResultCard } from '$lib/types/judge';

	let { card }: { card: ResultCard } = $props();

	/**
	 * 判断の種類。色だけに識別を頼らないよう、必ず文字でも示す
	 * （docs/PRODUCT_SPEC.md §10）。
	 */
	const KIND_LABEL: Record<ResultCard['kind'], string> = {
		choice: '選択肢',
		score: '段階',
		noul: 'YES / NO'
	};

	const color = $derived(`var(--viz-${card.kind})`);
</script>

<div class="flex items-center gap-2">
	<!-- 種類を示す印。文字は ink のまま（色は印が担う）。 -->
	<span class="h-2 w-2 shrink-0 rounded-full" style="background-color: {color}" aria-hidden="true"
	></span>
	<h3 class="min-w-0 text-sm font-medium break-words text-neutral-500">{card.label}</h3>
	<span class="ml-auto shrink-0 text-[10px] tracking-wider text-neutral-400 uppercase">
		{KIND_LABEL[card.kind]}
	</span>
</div>
