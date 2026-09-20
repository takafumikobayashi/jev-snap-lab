<script lang="ts">
	import { MODES, type Mode } from '$lib/types/judge';

	let { value, onchange }: { value: Mode; onchange: (mode: Mode) => void } = $props();

	const DESCRIPTIONS: Record<Mode, string> = {
		love: '恋愛ソングや詩など、文中の含意',
		social: 'SNS投稿としての読み',
		city: '行政問い合わせの担当候補'
	};

	/**
	 * 矢印キーでタブ間を移動する。WAI-ARIA の tablist の作法に合わせ、
	 * フォーカスの移動と選択を同時に行う。
	 */
	function onkeydown(event: KeyboardEvent, index: number) {
		const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (delta === 0) return;
		event.preventDefault();
		const next = MODES[(index + delta + MODES.length) % MODES.length];
		onchange(next);
		document.getElementById(`mode-tab-${next}`)?.focus();
	}
</script>

<div role="tablist" aria-label="判定モード" class="flex flex-wrap gap-2">
	{#each MODES as mode, index (mode)}
		<button
			id="mode-tab-{mode}"
			role="tab"
			type="button"
			aria-selected={value === mode}
			aria-controls="mode-panel"
			tabindex={value === mode ? 0 : -1}
			class="rounded-md border px-4 py-2 text-sm font-semibold tracking-wide uppercase transition
				{value === mode
				? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
				: 'border-neutral-300 text-neutral-600 hover:border-neutral-500 dark:border-neutral-700 dark:text-neutral-300'}"
			onclick={() => onchange(mode)}
			onkeydown={(event) => onkeydown(event, index)}
		>
			{mode}
		</button>
	{/each}
</div>

<p class="mt-2 text-sm text-neutral-500">{DESCRIPTIONS[value]}</p>
