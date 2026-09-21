<script lang="ts">
	import { toPercent } from '$lib/display';
	import { decidingProbability, verdictLabel, verdictStyle } from '$lib/batch-display';
	import type { BatchJudgeResponse, BatchJudgeResult } from '$lib/types/batch';

	/**
	 * `results` は**開示済みの分**だけを受け取る。
	 *
	 * 1件ずつ出していくあいだ、まとめの数字も一緒に動く。分母は全件なので、
	 * バーは伸びていく。
	 */
	let { response, results }: { response: BatchJudgeResponse; results: BatchJudgeResult[] } =
		$props();

	/** 結論ごとの件数。テーマによって値が違うのでデータから作る。 */
	const byVerdict = $derived(
		[...new Set(response.results.map((result) => result.verdict))]
			.map((verdict) => ({
				verdict,
				count: results.filter((result) => result.verdict === verdict).length
			}))
			.sort((a, b) => b.count - a.count)
	);

	/**
	 * 判定に効いた確率の帯。
	 *
	 * **0.5付近の件数を出す。** そこにある事例は、同じ入力でも次回ひっくり
	 * 返りうる（docs/BATCH_JUDGE_DESIGN.md §4.6）。
	 */
	const bands = $derived.by(() => {
		const values = results.map((result) => decidingProbability(response.theme, result.signals));
		return [
			{ label: '0.9 以上', count: values.filter((value) => value >= 0.9).length },
			{
				label: '0.7 〜 0.9',
				count: values.filter((value) => value >= 0.7 && value < 0.9).length
			},
			{
				label: '0.4 〜 0.7（揺れやすい）',
				count: values.filter((value) => value >= 0.4 && value < 0.7).length
			},
			{ label: '0.4 未満', count: values.filter((value) => value < 0.4).length }
		];
	});

	/**
	 * ラベルの有無は**全件**で決める。
	 *
	 * 開示済みだけで見ると、まだ0件のあいだ「正解ラベルがない」と出てしまう。
	 * 実際に開示中の画面へ出た。数えるのは開示済み、有無は全件。
	 */
	const hasLabels = $derived(response.results.some((result) => result.gold !== undefined));
	const graded = $derived(results.filter((result) => result.gold !== undefined));
	const agreed = $derived(graded.filter((result) => result.agrees).length);

	/**
	 * どちらへ寄って外したか。分からないと直しようがない（§7）。
	 *
	 * **矢印だけで書かない。** `要確認シグナルなし → 要確認 1件` と出したところ、
	 * 「要確認が1件」と読まれた（実際は24件）。ラベルと判定を別の列に出す。
	 */
	const confusion = $derived(
		Object.values(
			graded
				.filter((result) => result.agrees === false)
				.reduce<Record<string, { gold: string; verdict: string; count: number }>>(
					(carry, result) => {
						const key = `${result.gold}\u0000${result.verdict}`;
						carry[key] ??= {
							gold: verdictLabel(result.gold ?? ''),
							verdict: verdictLabel(result.verdict),
							count: 0
						};
						carry[key].count += 1;
						return carry;
					},
					{}
				)
		).sort((a, b) => b.count - a.count)
	);

	const disagreed = $derived(graded.filter((result) => result.agrees === false).length);
</script>

<section class="mt-8">
	<h2 class="text-xs font-semibold tracking-wide text-neutral-500">結果のまとめ</h2>

	<div class="mt-3 grid gap-6 sm:grid-cols-2">
		<div>
			<h3 class="text-xs text-neutral-500">judge がどう判定したか（{response.caseCount}件）</h3>
			<ul class="mt-1.5 space-y-1">
				{#each byVerdict as row (row.verdict)}
					<li class="flex items-center gap-2 text-sm">
						<span class="flex w-40 shrink-0 items-center gap-1.5">
							<span
								class="h-2 w-2 shrink-0 rounded-full {verdictStyle(row.verdict).bar}"
								aria-hidden="true"
							></span>
							<span>{verdictLabel(row.verdict)}</span>
						</span>
						<span class="h-1.5 flex-1 rounded-full bg-neutral-200 dark:bg-neutral-800">
							<span
								class="block h-1.5 rounded-full transition-[width] duration-150 {verdictStyle(
									row.verdict
								).bar}"
								style="width: {(row.count / response.caseCount) * 100}%"
							></span>
						</span>
						<span class="w-14 text-right font-mono text-xs tabular-nums">
							{row.count}件
						</span>
					</li>
				{/each}
			</ul>
		</div>

		<div>
			<h3 class="text-xs text-neutral-500">判定に効いた確率の分布（{response.caseCount}件）</h3>
			<ul class="mt-1.5 space-y-1">
				{#each bands as band (band.label)}
					<li class="flex items-center gap-2 text-sm">
						<span class="w-40 shrink-0 text-xs">{band.label}</span>
						<span class="h-1.5 flex-1 rounded-full bg-neutral-200 dark:bg-neutral-800">
							<span
								class="block h-1.5 rounded-full bg-neutral-500 transition-[width] duration-150"
								style="width: {(band.count / response.caseCount) * 100}%"
							></span>
						</span>
						<span class="w-14 text-right font-mono text-xs tabular-nums">{band.count}件</span>
					</li>
				{/each}
			</ul>
		</div>
	</div>

	{#if hasLabels}
		<div class="mt-5">
			<h3 class="text-xs text-neutral-500">
				{#if response.labelStatus === 'draft'}
					暫定ラベル（人手確認前）と judge の照合
				{:else}
					正解ラベルと judge の照合
				{/if}
			</h3>

			<!--
				**「49 / 50」とだけ出さない。** 判定した件数と読まれた。何と何を
				比べた数字なのかを言葉で書く。
			-->
			<p class="mt-1 text-sm">
				<span class="font-mono tabular-nums">{graded.length}</span>件のうち、ラベルと同じ判定が
				<span class="font-mono text-emerald-700 tabular-nums dark:text-emerald-400">{agreed}</span
				>件、違う判定が
				<span class="font-mono text-amber-700 tabular-nums dark:text-amber-400">{disagreed}</span
				>件（{toPercent(agreed / graded.length)}% 一致）
			</p>

			{#if confusion.length > 0}
				<!--
					矢印だけで書かない。`要確認シグナルなし → 要確認 1件` と出したら
					「要確認が1件」と読まれた。実際は24件で、それは結論の内訳の数字。
				-->
				<div class="mt-2">
					<p class="text-xs text-neutral-500">違った{disagreed}件の内訳</p>
					<table class="mt-1 text-xs">
						<thead class="text-neutral-500">
							<tr>
								<th class="pr-4 text-left font-normal">ラベル</th>
								<th class="pr-4 text-left font-normal">judge の判定</th>
								<th class="text-left font-normal">件数</th>
							</tr>
						</thead>
						<tbody>
							{#each confusion as row (row.gold + row.verdict)}
								<tr>
									<td class="pr-4">{row.gold}</td>
									<td class="pr-4 text-amber-700 dark:text-amber-400">{row.verdict}</td>
									<td class="font-mono tabular-nums">{row.count}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{:else}
		<p class="mt-5 text-xs text-neutral-500">
			入力した文章には正解ラベルがないため、一致率は出していません。例文を判定すると出ます。
		</p>
	{/if}
</section>
