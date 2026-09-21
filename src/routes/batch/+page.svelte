<script lang="ts">
	import { untrack } from 'svelte';
	import { requestBatch } from '$lib/client/batch-api';
	import { formatCostUsd, toPercent } from '$lib/display';
	import { THEME_NOTES, verdictLabel, signalLabel } from '$lib/batch-display';
	import BatchRow from '$lib/components/BatchRow.svelte';
	import BatchProcess from '$lib/components/BatchProcess.svelte';
	import BatchSummary from '$lib/components/BatchSummary.svelte';
	import { MAX_BATCH_CASES, MAX_BATCH_CASE_CHARS } from '$lib/types/batch';
	import { countCodePoints } from '$lib/types/judge';
	import type { BatchJudgeResponse, BatchTheme } from '$lib/types/batch';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Status = 'idle' | 'judging' | 'success' | 'error';

	const themes = $derived(data.themes);

	let theme = $state<BatchTheme>(untrack(() => data.themes[0].theme));
	let input = $state('');
	let status = $state<Status>('idle');
	let response = $state<BatchJudgeResponse | null>(null);
	let errorMessage = $state('');
	let errorRetryable = $state(false);

	let inFlight: AbortController | null = null;
	let latestSubmission = 0;

	const current = $derived(themes.find((entry) => entry.theme === theme) ?? themes[0]);

	/** 1行1件。空行は捨てる。 */
	const cases = $derived(
		input
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
	);
	const tooLong = $derived(cases.filter((line) => countCodePoints(line) > MAX_BATCH_CASE_CHARS));
	const tooMany = $derived(cases.length > MAX_BATCH_CASES);
	const ready = $derived(cases.length > 0 && !tooMany && tooLong.length === 0);

	const perCaseMs = $derived(response ? response.latencyMs / response.caseCount : 0);

	function cancelInFlight() {
		inFlight?.abort();
		inFlight = null;
		latestSubmission += 1;
	}

	function switchTheme(next: BatchTheme) {
		if (next === theme) return;
		cancelInFlight();
		theme = next;
		status = 'idle';
		response = null;
		// 例文を入れていたテーマの文章を残すと、別テーマの判定に見えてしまう。
		input = '';
	}

	/** デモ用の例文。自分の文章を貼らなくても動きを確認できるようにする（§11）。 */
	function fillSamples() {
		cancelInFlight();
		status = 'idle';
		response = null;
		input = current.samples.join('\n');
	}

	function clearInput() {
		cancelInFlight();
		status = 'idle';
		response = null;
		input = '';
	}

	async function run() {
		if (!ready) return;
		cancelInFlight();
		const controller = new AbortController();
		inFlight = controller;
		const submitted = { id: latestSubmission, theme, cases };

		status = 'judging';
		errorMessage = '';

		try {
			const outcome = await requestBatch(submitted.theme, submitted.cases, controller.signal);
			// テーマ切替や再入力で追い越された結果を捨てる。
			if (submitted.id !== latestSubmission || submitted.theme !== theme) {
				if (status === 'judging') status = 'idle';
				return;
			}
			if (outcome.ok) {
				response = outcome.response;
				status = 'success';
			} else {
				errorMessage = outcome.message;
				errorRetryable = outcome.retryable;
				status = 'error';
			}
		} catch {
			// AbortError。新しい送信かテーマ切替が引き継ぐ。
		} finally {
			if (inFlight === controller) inFlight = null;
		}
	}
</script>

<svelte:head>
	<title>BATCH JUDGE — Jev Snap Lab</title>
	<meta name="description" content="短文を数十件まとめて判定する実験" />
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-10 sm:py-16">
	<header class="flex flex-wrap items-baseline justify-between gap-2">
		<h1 class="text-2xl font-bold tracking-tight sm:text-3xl">BATCH JUDGE</h1>
		<a class="text-sm text-neutral-500 underline underline-offset-4" href="/">Jev Snap Lab へ戻る</a
		>
	</header>

	<p class="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
		短い文章を<strong>最大{MAX_BATCH_CASES}件まとめて</strong
		>判定します。1件ずつ送るのではなく、1回のリクエストで全件を評価します。
	</p>

	<div class="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="判定テーマ">
		{#each themes as entry (entry.theme)}
			<button
				type="button"
				role="tab"
				aria-selected={entry.theme === theme}
				class="rounded-md border px-3 py-1.5 text-sm focus:outline-2 focus:outline-offset-2
				focus:outline-neutral-900 dark:focus:outline-neutral-100
				{entry.theme === theme
					? 'border-neutral-900 font-medium dark:border-neutral-100'
					: 'border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400'}"
				onclick={() => switchTheme(entry.theme)}
			>
				{entry.label}
			</button>
		{/each}
	</div>

	{#each THEME_NOTES[theme] as note (note)}
		<p
			class="mt-3 rounded-md border border-neutral-300 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
		>
			{note}
		</p>
	{/each}

	<!--
		**入力欄の手前に出す。** 判定結果と一緒では遅い。このモードは
		「AIにそのまま入れてよい？」を判定するために入力文をAIへ送るため、
		実際の個人情報を貼られると判定より先に送信が起きる
		（docs/BATCH_JUDGE_DESIGN.md §3.1）。
	-->
	<p
		class="mt-3 rounded-md border border-amber-600/60 px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300"
	>
		入力した文章は判定のため <strong>TypeSafe AI へ送信されます</strong
		>。実際の個人情報は入力しないでください。試すだけなら下の「例文を入れる」をお使いください。
	</p>

	<div class="mt-4 flex flex-wrap items-center gap-2">
		<button
			type="button"
			class="rounded-md border border-neutral-300 px-3 py-1.5 text-xs focus:outline-2
			focus:outline-offset-2 focus:outline-neutral-900 dark:border-neutral-700
			dark:focus:outline-neutral-100"
			onclick={fillSamples}
		>
			例文を入れる（{current.cases}件）
		</button>
		<button
			type="button"
			class="rounded-md border border-neutral-300 px-3 py-1.5 text-xs focus:outline-2
			focus:outline-offset-2 focus:outline-neutral-900 dark:border-neutral-700
			dark:focus:outline-neutral-100"
			onclick={clearInput}
			disabled={input.length === 0}
		>
			消す
		</button>
	</div>

	<label class="mt-3 block" for="batch-input">
		<span class="text-xs text-neutral-500">1行に1件。空行は無視します。</span>
	</label>
	<textarea
		id="batch-input"
		bind:value={input}
		rows="10"
		spellcheck="false"
		placeholder="明日の会議室を予約したい&#10;窓口の待ち時間が長い"
		class="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono
		text-sm focus:outline-2 focus:outline-offset-2 focus:outline-neutral-900
		dark:border-neutral-700 dark:focus:outline-neutral-100"></textarea>

	<div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
		<span
			class="font-mono tabular-nums {tooMany
				? 'text-amber-700 dark:text-amber-500'
				: 'text-neutral-500'}"
		>
			{cases.length} / {MAX_BATCH_CASES} 件
		</span>
		{#if tooMany}
			<span class="text-amber-700 dark:text-amber-500">
				{MAX_BATCH_CASES}件までです。{cases.length - MAX_BATCH_CASES}行減らしてください。
			</span>
		{/if}
		{#if tooLong.length > 0}
			<span class="text-amber-700 dark:text-amber-500">
				{MAX_BATCH_CASE_CHARS}文字を超える行が {tooLong.length} 件あります。
			</span>
		{/if}
	</div>

	<button
		type="button"
		class="mt-4 rounded-md border border-neutral-900 px-4 py-2 text-sm font-medium
		focus:outline-2 focus:outline-offset-2 focus:outline-neutral-900
		disabled:opacity-40 dark:border-neutral-100 dark:focus:outline-neutral-100"
		disabled={status === 'judging' || !ready}
		onclick={run}
	>
		{status === 'judging' ? '判定中…' : `${cases.length}件をまとめて判定`}
	</button>

	{#if status === 'judging' || response}
		<BatchProcess {response} pending={status === 'judging'} caseCount={cases.length} />
	{/if}

	<section class="mt-8" aria-live="polite" aria-busy={status === 'judging'}>
		{#if status === 'error'}
			<div class="rounded-lg border border-amber-500 p-4">
				<p class="text-sm">{errorMessage}</p>
				{#if errorRetryable}
					<button
						type="button"
						class="mt-3 rounded-md border border-neutral-400 px-4 py-1.5 text-sm font-medium
						focus:outline-2 focus:outline-offset-2 focus:outline-neutral-900
						dark:focus:outline-neutral-100"
						onclick={run}>再試行</button
					>
				{/if}
			</div>
		{:else if response}
			<BatchSummary {response} />

			<h2 class="mt-8 text-sm font-semibold tracking-wide text-neutral-500">
				{response.caseCount} CASES
			</h2>

			<ul
				class="mt-3 divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
			>
				{#each response.results as result, index (result.caseId)}
					<BatchRow {result} {index} theme={response.theme} label={verdictLabel(result.verdict)} />
				{/each}
			</ul>

			<!-- 数値はすべて実測値。設計段階の見本を出さない（§6）。 -->
			<dl class="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
				<div>
					<dt class="text-xs text-neutral-500">判定した件数</dt>
					<dd class="font-mono tabular-nums">{response.caseCount}</dd>
				</div>
				<div>
					<dt class="text-xs text-neutral-500">質問数</dt>
					<dd class="font-mono tabular-nums">{response.questionCount}</dd>
				</div>
				<div>
					<dt class="text-xs text-neutral-500">所要時間</dt>
					<dd class="font-mono tabular-nums">{response.latencyMs} ms</dd>
				</div>
				<div>
					<dt class="text-xs text-neutral-500">入力トークン</dt>
					<dd class="font-mono tabular-nums">{response.usage.inputTokens.toLocaleString()}</dd>
				</div>
				<div>
					<dt class="text-xs text-neutral-500">推計コスト</dt>
					<dd class="font-mono tabular-nums">{formatCostUsd(response.usage.estimatedCostUsd)}</dd>
				</div>
				<div>
					<dt class="text-xs text-neutral-500">モデル</dt>
					<dd class="font-mono text-xs">{response.model}</dd>
				</div>
				<div>
					<dt class="text-xs text-neutral-500">リクエスト数</dt>
					<dd class="font-mono tabular-nums">{response.upstreamCalls}</dd>
				</div>
				<div>
					<dt class="text-xs text-neutral-500">1件あたり</dt>
					<dd class="font-mono tabular-nums">{perCaseMs.toFixed(0)} ms</dd>
				</div>
			</dl>

			<p class="mt-4 text-xs text-neutral-500">
				1件あたり約 {perCaseMs.toFixed(0)} ms は、<strong
					>並列に評価されたリクエスト全体の時間を件数で割った参考値</strong
				>であり、各判断が逐次実行された意味ではありません。
			</p>

			<!--
				`draft` のあいだ「精度」と呼ばない。人が確認していないラベルに
				対する値を性能として見せることになる（§7）。
			-->
			<p class="mt-2 text-xs text-neutral-500">
				{#if response.results.some((result) => result.gold !== undefined)}
					一致率は、{response.labelStatus === 'draft' ? '暫定ラベル（人手確認前）' : '正解ラベル'}
					との一致です。Jevの精度ではありません。
				{/if}
				判定は<strong>同じ入力でも毎回同じとは限りません</strong
				>。実測では50件中0〜1件が変わりました。
			</p>

			{#if response.results.some((result) => result.agrees === false)}
				<details class="mt-4">
					<summary class="cursor-pointer text-xs text-neutral-500">
						不一致の {response.results.filter((result) => result.agrees === false).length} 件を見る
					</summary>
					<ul class="mt-2 space-y-2">
						{#each response.results.filter((result) => result.agrees === false) as result (result.caseId)}
							<li class="text-xs text-neutral-600 dark:text-neutral-400">
								<p>{result.text}</p>
								<p class="mt-0.5 font-mono">
									判定 {verdictLabel(result.verdict)} / ラベル {verdictLabel(result.gold ?? '')}
									{#each result.signals as signal (signal.key)}
										<span class="ml-2"
											>{signalLabel(signal.key)} {toPercent(signal.probability)}%</span
										>
									{/each}
								</p>
							</li>
						{/each}
					</ul>
				</details>
			{/if}

			<!--
				指紋は例文データセットのものである。利用者の文章にはデータセットが
				無いので、ラベルを使ったときだけ出す。
			-->
			<p class="mt-4 font-mono text-[10px] break-all text-neutral-400">
				{#if response.results.some((result) => result.gold !== undefined)}
					dataset {response.datasetFingerprint}
				{/if}
				{#if response.referenceDate}／基準日 {response.referenceDate}{/if}
			</p>
		{/if}
	</section>
</main>
