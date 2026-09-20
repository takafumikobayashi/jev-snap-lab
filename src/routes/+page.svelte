<script lang="ts">
	import { MODES } from '$lib/types/judge';
</script>

<svelte:head>
	<title>Jev Snap Lab</title>
	<meta name="description" content="Tiny inputs. Instant decisions." />
</svelte:head>

<main class="mx-auto max-w-2xl px-4 py-16">
	<h1 class="text-3xl font-bold">Jev Snap Lab</h1>
	<p class="mt-2 text-neutral-500">Tiny inputs. Instant decisions.</p>

	<p class="mt-8 text-sm text-neutral-500">Phase 1 の基盤のみ。判定 UI は Phase 3 で実装する。</p>
	<ul class="mt-2 text-sm text-neutral-500">
		{#each MODES as mode (mode)}
			<li>{mode}</li>
		{/each}
	</ul>
</main>
