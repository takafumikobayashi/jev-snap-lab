<script lang="ts">
	import { requestJudge } from '$lib/client/api';
	import { formatCostUsd } from '$lib/display';
	import JudgeForm from '$lib/components/JudgeForm.svelte';
	import ModeTabs from '$lib/components/ModeTabs.svelte';
	import ResultCard from '$lib/components/ResultCard.svelte';
	import type { JudgeResponse, Mode } from '$lib/types/judge';

	type Status = 'idle' | 'judging' | 'success' | 'error';

	let mode = $state<Mode>('love');
	let text = $state('');
	let status = $state<Status>('idle');
	let response = $state<JudgeResponse | null>(null);
	let errorMessage = $state('');
	let errorRetryable = $state(false);

	/** 送信中のリクエスト。モード切替と再送信で中断する。 */
	let inFlight: AbortController | null = null;
	/** 最後に送った通し番号。古いレスポンスを表示しないために照合する。 */
	let latestSubmission = 0;

	function cancelInFlight() {
		inFlight?.abort();
		inFlight = null;
	}

	function switchMode(next: Mode) {
		if (next === mode) return;
		// 入力文は保持する。走っている判定だけ捨てる。
		cancelInFlight();
		mode = next;
		status = 'idle';
		response = null;
	}

	async function judge() {
		cancelInFlight();
		const controller = new AbortController();
		inFlight = controller;
		const submission = ++latestSubmission;

		status = 'judging';
		errorMessage = '';

		try {
			const outcome = await requestJudge(mode, text, controller.signal);
			// 中断せずに追い越された場合でも、古い結果は捨てる。
			if (submission !== latestSubmission) return;

			if (outcome.ok) {
				response = outcome.response;
				status = 'success';
			} else {
				errorMessage = outcome.message;
				errorRetryable = outcome.retryable;
				status = 'error';
			}
		} catch {
			// AbortError。新しい送信かモード切替が引き継ぐので何もしない。
		} finally {
			if (inFlight === controller) inFlight = null;
		}
	}
</script>

<svelte:head>
	<title>Jev Snap Lab</title>
	<meta name="description" content="Tiny inputs. Instant decisions." />
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-10 sm:py-16">
	<header class="flex flex-wrap items-baseline justify-between gap-2">
		<h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Jev Snap Lab</h1>
		<p class="text-sm text-neutral-500">Tiny inputs. Instant decisions.</p>
	</header>

	<div class="mt-8">
		<ModeTabs value={mode} onchange={switchMode} />
	</div>

	<div class="mt-6">
		<JudgeForm bind:text busy={status === 'judging'} onsubmit={judge} />
	</div>

	{#if mode === 'city'}
		<!-- CITY は常時表示。公式サービスと誤認させない（docs/PRODUCT_SPEC.md §8）。 -->
		<p
			class="mt-4 rounded-md border border-neutral-300 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
		>
			安芸高田市の公開情報をモデルケースにした<strong>技術検証・デモ</strong
			>です。正式な行政案内ではありません。最終確認は必ず公式窓口へ。
		</p>
	{/if}

	<!-- 結果の更新をスクリーンリーダーへ通知する。 -->
	<section class="mt-10" aria-live="polite" aria-busy={status === 'judging'}>
		{#if status === 'judging'}
			<p class="text-sm text-neutral-500">判定中です…</p>
		{:else if status === 'error'}
			<div class="rounded-lg border border-amber-500 p-4">
				<p class="text-sm">{errorMessage}</p>
				{#if errorRetryable}
					<button
						type="button"
						class="mt-3 rounded-md border border-neutral-400 px-4 py-1.5 text-sm font-medium
							focus:outline-2 focus:outline-offset-2 focus:outline-neutral-900
							dark:focus:outline-neutral-100"
						onclick={judge}
					>
						再試行
					</button>
				{/if}
			</div>
		{:else if status === 'success' && response}
			<h2 class="text-xs font-semibold tracking-widest text-neutral-400 uppercase">Results</h2>

			<!-- モバイルは1列、デスクトップは2列まで。 -->
			<div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
				{#each response.results as card (card.id)}
					<ResultCard {card} />
				{/each}
			</div>

			{#if response.city}
				<div class="mt-4 rounded-md border border-neutral-300 p-3 text-xs dark:border-neutral-700">
					{#if response.city.provisional}
						<p class="font-semibold text-amber-700 dark:text-amber-400">根拠データ未登録</p>
						<p class="mt-1 text-neutral-600 dark:text-neutral-400">
							この候補には公式の組織・事務分掌データがまだ紐付いていません。担当課の確定として扱わないでください。
						</p>
					{/if}
					<p class="mt-1 text-neutral-400">
						データバージョン: {response.city.directoryVersion}
					</p>
				</div>
			{/if}

			<p class="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-400 tabular-nums">
				<span>Response: {response.latencyMs}ms</span>
				<span>Model: {response.model}</span>
				{#if response.usage?.inputTokens !== undefined}
					<span>Input: {response.usage.inputTokens} tokens</span>
				{/if}
				{#if response.usage?.estimatedCostUsd !== undefined}
					<!-- output tokens は課金対象外なので、コストは input のみの推計。 -->
					<span>Cost (推計): {formatCostUsd(response.usage.estimatedCostUsd)}</span>
				{/if}
			</p>
		{/if}
	</section>

	<footer
		class="mt-12 border-t border-neutral-200 pt-4 text-xs text-neutral-400 dark:border-neutral-800"
	>
		<p>結果は確率的な判断であり、事実・公式判断・診断ではありません。入力は保存されません。</p>
	</footer>
</main>
