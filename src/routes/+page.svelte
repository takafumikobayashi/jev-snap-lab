<script lang="ts">
	import { requestJudge } from '$lib/client/api';
	import { shouldApplyResult, type Submission } from '$lib/client/submission';
	import { formatCostUsd, toPercent } from '$lib/display';
	import JudgeForm from '$lib/components/JudgeForm.svelte';
	import ModeTabs from '$lib/components/ModeTabs.svelte';
	import ResultCard from '$lib/components/ResultCard.svelte';
	import type { JudgeResponse, Mode } from '$lib/types/judge';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/**
	 * OGP は絶対 URL を要求する。`PUBLIC_SITE_URL` が未設定だと相対 URL に
	 * なってしまうため、その場合は画像系の meta を出さない。
	 *
	 * 壊れた相対 URL を出すくらいなら出さない方がよい。クローラーはどちらも
	 * 無視するが、出さなければ「設定漏れ」だと分かる。
	 */
	const ogImageUrl = $derived(data.siteUrl ? `${data.siteUrl}/og-image.jpg` : null);

	type Status = 'idle' | 'judging' | 'success' | 'error';

	let mode = $state<Mode>('love');
	let text = $state('');
	let status = $state<Status>('idle');
	let response = $state<JudgeResponse | null>(null);
	let errorMessage = $state('');
	let errorRetryable = $state(false);

	/** 送信中のリクエスト。モード切替と再送信で中断する。 */
	let inFlight: AbortController | null = null;
	/** 最後に送った通し番号。追い越された結果を捨てるために照合する。 */
	let latestSubmission = 0;

	/**
	 * 走っている判定を無効化する。
	 *
	 * abort だけでは足りない。fetch が既に解決していれば例外は飛ばず、
	 * そのまま結果が返る。通し番号も必ず進めて、解決済みのレスポンスを
	 * 確実に古いものとして扱う。
	 */
	function cancelInFlight() {
		inFlight?.abort();
		inFlight = null;
		latestSubmission += 1;
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
		const submission: Submission = { id: latestSubmission, mode, text };

		status = 'judging';
		errorMessage = '';

		try {
			const outcome = await requestJudge(submission.mode, submission.text, controller.signal);

			// 判定中もモード切替と textarea の編集ができる。通し番号に加えて
			// モードと入力文の一致も確認し、画面と食い違う結果を出さない。
			if (!shouldApplyResult(submission, { id: latestSubmission, mode, text })) {
				// 入力が変わっただけの場合は判定中のまま止まらないよう idle へ戻す。
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
			// AbortError。新しい送信かモード切替が引き継ぐので何もしない。
		} finally {
			if (inFlight === controller) inFlight = null;
		}
	}
</script>

<svelte:head>
	<title>Jev Snap Lab</title>
	<meta name="description" content="Tiny inputs. Instant decisions." />
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Jev Snap Lab" />
	<meta property="og:description" content="Tiny inputs. Instant decisions." />
	{#if data.siteUrl}
		<meta property="og:url" content={data.siteUrl} />
	{/if}
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="Jev Snap Lab" />
	<meta name="twitter:description" content="Tiny inputs. Instant decisions." />
	{#if ogImageUrl}
		<meta property="og:image" content={ogImageUrl} />
		<meta
			property="og:image:alt"
			content="短い入力から3系統の確率的な判断へ分岐するJev Snap Labのビジュアル"
		/>
		<meta property="og:image:type" content="image/jpeg" />
		<meta property="og:image:width" content="1200" />
		<meta property="og:image:height" content="630" />
		<meta name="twitter:image" content={ogImageUrl} />
	{/if}
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-10 sm:py-16">
	<header class="flex flex-wrap items-baseline justify-between gap-2">
		<h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Jev Snap Lab</h1>
		<p class="text-sm text-neutral-500">Tiny inputs. Instant decisions.</p>
	</header>

	<div class="mt-8">
		<ModeTabs value={mode} onchange={switchMode} />
	</div>

	<!--
		タブが制御する領域。モードによって質問群と結果が入れ替わるため、
		入力フォームから結果までをひとつの tabpanel にする。
	-->
	<div id="mode-panel" role="tabpanel" aria-labelledby="mode-tab-{mode}" tabindex="-1">
		<div class="mt-6">
			<JudgeForm bind:text busy={status === 'judging'} onsubmit={judge} />
		</div>

		{#if mode === 'love'}
			<!--
				LOVE は歌詞の入力を想定する。著作権の注意を常時表示し、アプリが
				歌詞を保存・収集・提供しないことを示す（docs/PRODUCT_SPEC.md §6）。
			-->
			<p
				class="mt-4 rounded-md border border-neutral-300 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
			>
				判定するのは<strong>文面がどう読めるか</strong
				>で、作品の評価ではありません。著作物の取り扱いにはご注意ください。
			</p>
		{/if}

		{#if mode === 'city'}
			<!-- CITY は常時表示。公式サービスと誤認させない（docs/PRODUCT_SPEC.md §8）。 -->
			<p
				class="mt-4 rounded-md border border-neutral-300 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
			>
				{#if data.cityFictional}
					<strong>架空の市</strong>をモデルにした<strong>技術検証・デモ</strong
					>です。実在の自治体の公式案内ではありません。組織名・分掌・条文はすべて架空のものです。
				{:else}
					実在する自治体の公開情報をモデルにした<strong>技術検証・デモ</strong
					>です。正式な行政案内ではありません。最終確認は必ず公式窓口へ。
				{/if}
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
					{@const city = response.city}
					<div
						class="mt-4 rounded-md border border-neutral-300 p-3 text-xs dark:border-neutral-700"
					>
						<!--
							架空データのときは「根拠」と言い切らない。出典も条文も実在
							しないため、公式の担当決定として見せてはならない
							（docs/CITY_DATA.md §9）。
						-->
						{#if city.fictional}
							<p class="font-semibold text-amber-700 dark:text-amber-400">根拠データ（架空）</p>
							<p class="mt-1 text-neutral-600 dark:text-neutral-400">
								以下は架空の組織・分掌です。実在の自治体の出典ではありません。
							</p>
						{:else}
							<p class="font-semibold">根拠データ</p>
						{/if}

						{#if city.candidates.length > 0}
							<!--
								画面に出ている上位候補すべてに根拠を付ける。候補が割れた
								入力ほど、2位・3位と比べる材料が要る
								（docs/JEV_DESIGN.md §9 / docs/PRODUCT_SPEC.md §8）。
							-->
							<ul class="mt-2 space-y-3">
								{#each city.candidates as candidate (candidate.candidateId)}
									<li
										class="border-l-2 pl-3"
										style="border-color: {candidate.selected
											? 'var(--viz-choice)'
											: 'var(--viz-choice-soft)'}"
									>
										<p>
											<span class:font-semibold={candidate.selected}>
												{candidate.officialName}
											</span>
											{#if candidate.unit === null}
												<!-- 係まで絞れていないことを名称の隣で示す。 -->
												<span class="text-neutral-500">（課まで）</span>
											{/if}
											<!-- 色だけに頼らず数値を併記する（docs/PRODUCT_SPEC.md §10）。 -->
											<span class="text-neutral-500 tabular-nums">
												{toPercent(candidate.probability)}%
											</span>
										</p>

										{#if candidate.matchedResponsibilities.length > 0}
											<ul class="mt-1 list-disc pl-4 text-neutral-600 dark:text-neutral-400">
												{#each candidate.matchedResponsibilities as responsibility (responsibility.responsibilityId)}
													<li>{responsibility.officialText}</li>
												{/each}
											</ul>
										{:else}
											<!-- 係を推測して名指ししない（docs/CITY_DATA.md §5）。 -->
											<p class="mt-1 text-neutral-500">
												文面からは係を特定できませんでした。課までの候補として扱ってください。
											</p>
										{/if}

										{#if candidate.sources.length > 0}
											<ul class="mt-1 space-y-1">
												{#each candidate.sources as source (source.sourceId)}
													<li>
														{#if source.url}
															<!--
																外部の公式サイトへの固定リンク。URL は静的データ由来で、
																許可ホストに限られることを contract test で固定している。
																架空データでは URL を持たないためリンクにしない。
															-->
															<a
																href={source.url}
																target="_blank"
																rel="noopener noreferrer"
																class="underline underline-offset-2"
															>
																{source.title}
															</a>
														{:else}
															<span>{source.title}</span>
														{/if}
														<span class="text-neutral-500">
															（{source.locator} / 取得日 {source.retrievedAt}{source.effectiveFrom
																? ` / 有効日 ${source.effectiveFrom}`
																: ''}）
														</span>
													</li>
												{/each}
											</ul>
										{:else}
											<p class="mt-1 text-amber-700 dark:text-amber-400">出典データ未登録</p>
										{/if}
									</li>
								{/each}
							</ul>
						{:else}
							<p class="mt-1 text-amber-700 dark:text-amber-400">根拠データ未登録</p>
						{/if}
						<!--
							根拠は画面に出ている上位候補ぶんだけ。候補を展開すると
							根拠の無い候補が並ぶため、何件ぶんかを明示する。
						-->
						<p class="mt-2 text-neutral-400">
							上位 {city.candidates.length} 件の根拠 / データバージョン: {city.directoryVersion}
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
	</div>

	<footer
		class="mt-12 border-t border-neutral-200 pt-4 text-xs text-neutral-400 dark:border-neutral-800"
	>
		<p>
			結果は確率的な判断であり、事実・公式判断・診断ではありません。入力は判定のため TypeSafe AI の
			Jev へ送信します。このアプリは入力を保存・収集しません。
		</p>
	</footer>
</main>
