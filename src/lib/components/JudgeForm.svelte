<script lang="ts">
	import { countCodePoints, MAX_INPUT_CODE_POINTS } from '$lib/types/judge';

	let {
		text = $bindable(),
		busy,
		onsubmit
	}: { text: string; busy: boolean; onsubmit: () => void } = $props();

	// maxlength は UTF-16 の code unit 基準で絵文字を過大に数えるため使わない。
	// 表示もサーバー検証も code point で数える。
	const count = $derived(countCodePoints(text));
	const tooLong = $derived(count > MAX_INPUT_CODE_POINTS);
	const blank = $derived(text.trim().length === 0);
	const canSubmit = $derived(!busy && !blank && !tooLong);
</script>

<form
	onsubmit={(event) => {
		event.preventDefault();
		if (canSubmit) onsubmit();
	}}
>
	<label for="judge-text" class="block text-sm text-neutral-500">
		短い文章を入力してください
	</label>

	<textarea
		id="judge-text"
		bind:value={text}
		rows="3"
		aria-describedby="judge-count"
		aria-invalid={tooLong}
		class="mt-2 w-full resize-y rounded-md border px-3 py-2 text-base
			{tooLong ? 'border-amber-600' : 'border-neutral-300 dark:border-neutral-700'}
			bg-transparent focus:outline-2 focus:outline-offset-2 focus:outline-neutral-900
			dark:focus:outline-neutral-100"></textarea>

	<div class="mt-2 flex flex-wrap items-center justify-between gap-3">
		<p id="judge-count" class="text-sm tabular-nums">
			<span
				class={tooLong ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-neutral-500'}
			>
				{count} / {MAX_INPUT_CODE_POINTS}
			</span>
			{#if tooLong}
				<span class="ml-2 text-amber-700 dark:text-amber-400">
					{MAX_INPUT_CODE_POINTS}文字以内にしてください
				</span>
			{/if}
		</p>

		<button
			type="submit"
			disabled={!canSubmit}
			class="rounded-md bg-neutral-900 px-6 py-2 text-sm font-semibold tracking-wide text-white
				transition focus:outline-2 focus:outline-offset-2
				focus:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-40
				dark:bg-neutral-100 dark:text-neutral-900 dark:focus:outline-neutral-100"
		>
			{busy ? 'JUDGING...' : 'JUDGE'}
		</button>
	</div>
</form>
