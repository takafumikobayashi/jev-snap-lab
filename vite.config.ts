import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// maxDuration はアダプタが Build Output API v3 の .vc-config.json へ
			// 書き出す。vercel.json の functions グロブは SvelteKit の生成関数名
			// (catchall.func) と一致しないため効かない。
			adapter: adapter({ maxDuration: 20 }),
			// SvelteKit がハイドレーション用に生成するインライン要素へ
			// nonce / hash を自動付与する。hooks.server.ts で手書きすると
			// それらが壊れる（docs/ARCHITECTURE.md §8）。
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					// ブラウザは TypeSafe API を直接呼ばず /api/judge だけを叩く。
					'connect-src': ['self'],
					'img-src': ['self', 'data:'],
					'font-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none'],
					// **明示的に指定する。** 未指定にすると dev では SvelteKit が
					// 'unsafe-inline' を補うが、本番ビルドでは style-src 自体が
					// 出力されず default-src へフォールバックし、インライン style が
					// ブロックされる。結果カードのバーは幅と色を style 属性で
					// 与えているため、本番だけ描画が壊れていた（E2E で検出）。
					'style-src': ['self', 'unsafe-inline']
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			},
			{
				// 運用スクリプトも検査対象にする。受入確認そのものが壊れていると
				// 「合格」を信用できない（scripts/lib/city-smoke.mjs の経緯）。
				test: {
					name: 'scripts',
					environment: 'node',
					include: ['scripts/**/*.{test,spec}.mjs']
				}
			}
		]
	}
});
