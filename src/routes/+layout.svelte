<script lang="ts">
	import './layout.css';

	let { children } = $props();
</script>

<svelte:head>
	<!--
		SVG を優先し、対応していない環境のために PNG を残す。ブラウザは
		対応する最初の rel="icon" を選ぶ。
	-->
	<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
	<link rel="icon" type="image/png" href="/favicon.png" />
</svelte:head>
{@render children()}
