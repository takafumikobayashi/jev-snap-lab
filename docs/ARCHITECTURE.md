# Architecture

## 1. 推奨構成

### 結論

MVPは **SvelteKit + TypeScript + Tailwind CSS + Vercel + TypeSafe公式JavaScript SDK** を推奨する。

理由は、1画面中心の小型アプリであり、SvelteKitのserver routeでAPIキーをサーバーに閉じ込められ、Vercel adapterでデプロイ先をほぼ追加設定なしにできるためである。UIとserver routeを一つのリポジトリで保てることも、実験を小さく保つ上で重要である。

### 代替案

| 案 | 長所 | 短所 | 採用判断 |
|---|---|---|---|
| SvelteKit | 1画面アプリの実装量が少ない。SSR/server routeが一体。 | チームのReact資産がある場合は再利用が少ない。 | **推奨** |
| Next.js | Vercelとの親和性、React資産、採用事例が多い。 | MVPには抽象化がやや多く、server/client境界の説明コストが増える。 | React資産が必要なら代替 |
| Vite SPA + 別API | UIとAPIの境界が明快。 | APIの別デプロイ、CORS、環境変数管理が必要。 | MVPでは採用しない |

ここでのSvelteKit推奨は設計上のベースラインである。実装開始前に、チームのReact前提やTypeSafe SDKのSvelteKit runtime動作を確認し、必要ならNext.jsへ切り替える。

## 2. システム構成

```text
┌───────────────────────────────┐
│ Browser                        │
│ Svelte page                    │
│ - mode / text                  │
│ - result cards                 │
│ - no API key                   │
└───────────────┬───────────────┘
                │ POST /api/judge
                │ mode + text
┌───────────────▼───────────────┐
│ SvelteKit server route         │
│ - validate body / 280 chars    │
│ - build mode questions         │
│ - load static CITY directory   │
│ - timeout / error mapping      │
│ - measure latency / usage      │
└───────────────┬───────────────┘
                │ official SDK
                │ Authorization: Bearer ...
┌───────────────▼───────────────┐
│ TypeSafe AI / Jev              │
│ POST /v1/systemone             │
│ typed answers                  │
└───────────────────────────────┘

Repository static data:
city-directory.json ──────────────┐
question catalog / labels ─────────┴─ server only
```

## 3. データフロー

1. ブラウザは入力文とモードだけを `POST /api/judge` へ送る。
2. server routeが `Content-Type: application/json`、mode enum、280 code points、空白のみを検証する。
3. `questionCatalog` がモードの質問を返す。
4. CITYでは `city-directory.json` の activeな組織単位から `route_to.criteria`を生成する。
5. Jev公式SDKをserver-only moduleで呼び出す。
6. SDKの応答を、TypeSafe生型の検証後に `JudgeResponse`へ正規化する。
7. CITYでは `route_to`の候補IDを静的データへjoinし、根拠情報を付加する。
8. ブラウザは結果を表示する。入力文は保存せず、レスポンスにも不要なら再掲しない。

### リクエスト相関

- サーバーで `requestId` を発行し、レスポンスに含める。
- クライアントは送信時に `clientRequestId` を保持し、古いレスポンスを表示しない。
- `requestId` と `clientRequestId` は入力本文から生成しない。

## 4. ディレクトリ構成

実装時の目標構成:

```text
.
├── src/
│   ├── hooks.server.ts
│   ├── routes/
│   │   ├── +page.svelte
│   │   └── api/
│   │       └── judge/
│   │           └── +server.ts
│   ├── lib/
│   │   ├── components/
│   │   │   ├── ModeTabs.svelte
│   │   │   ├── JudgeForm.svelte
│   │   │   ├── ResultCard.svelte
│   │   │   ├── ChoiceResult.svelte
│   │   │   ├── ScoreResult.svelte
│   │   │   └── NoulResult.svelte
│   │   ├── client/
│   │   │   └── api.ts
│   │   ├── server/
│   │   │   ├── jev-client.server.ts
│   │   │   ├── question-catalog.server.ts
│   │   │   ├── city-directory.server.ts
│   │   │   ├── normalize-response.server.ts
│   │   │   ├── errors.server.ts
│   │   │   └── rate-limit.server.ts
│   │   ├── types/
│   │   │   ├── judge.ts
│   │   │   └── city.ts
│   │   └── validation/
│   │       └── judge-input.ts
│   └── app.html
├── data/
│   └── city/
│       └── akitakata-2026-04-01.json
├── static/
├── tests/
│   ├── unit/
│   ├── contract/
│   └── e2e/
├── docs/
├── .env.example
├── package.json
├── pnpm-lock.yaml
└── vite.config.ts       # SvelteKit + Tailwind + adapter-vercel + Vitest
```

本プロジェクトでは設定を `vite.config.ts` へ集約し、`svelte.config.js` を置かない。SvelteKit 2.62 以降は `sveltekit()` プラグインが `KitConfig` を直接受け取れるようになっており、その場合 `svelte.config.js` は無視される。`svelte.config.js` を使う方式も引き続きサポートされているため、必要になれば移せる。adapter、CSP、runes モード（Svelte 5）の強制はいずれも `vite.config.ts` に置く。

`*.server.ts`はブラウザへバンドルされないserver-only境界を意図する。Jevキーを持つモジュールは `src/lib/server/` からしかimportしない。

## 5. 環境変数

| 変数 | 必須 | 用途 | クライアント公開 |
|---|---:|---|---:|
| `TYPESAFE_API_KEY` | Yes | TypeSafe API Bearer key | No |
| `TYPESAFE_DEFAULT_MODEL` | No | 既定モデル。推奨 `jev-latest` | No |
| `TYPESAFE_BASE_URL` | No | SDKのAPI root。通常は既定値を使う | No |
| `JEV_TIMEOUT_MS` | No | 1試行timeout。推奨3500（§6の算出根拠を参照） | No |
| `JEV_TOTAL_TIMEOUT_MS` | No | retryを含む総予算。推奨12000 | No |
| `JEV_INPUT_PRICE_PER_MILLION_TOKENS` | No | コスト推計。既定0.042 | No |
| `APP_RATE_LIMIT_PER_MINUTE` | No | アプリ側のbest-effort上限 | No |
| `PUBLIC_APP_LABEL` | No | CITYのデモ注意文など公開可能な表示設定 | Yes可 |

`.env`はコミットしない。VercelではPreview / Productionごとに分離する。`PUBLIC_` prefix以外の秘密はSvelteのpublic env importへ渡さない。

### 関数の最大実行時間（環境変数ではない）

Vercelは関数に既定の最大実行時間を設定しており、超えるとプラットフォーム側が関数を終了させる。これは環境変数ではなくデプロイ設定で指定する。

`JEV_TOTAL_TIMEOUT_MS` が既定値を超えていると、アプリのtimeout処理（504 / `UPSTREAM_TIMEOUT`）へ到達する前に関数が殺され、ユーザーにはプラットフォームのエラーが出る。**総予算より確実に大きい `maxDuration` を明示設定する。**

**`vercel.json` の `functions` グロブは使えない。** adapter-vercelはBuild Output API v3を使い、`.vercel/output/functions/**/.vc-config.json` をアダプタ自身が書き出す。生成される関数名は `catchall.func` などであり、`src/routes/api/judge/+server.ts` のようなソースパスとは一致しないため、`vercel.json` に書いても適用されない。

設定方法は次の2つで、いずれも実測で `.vc-config.json` への反映を確認済み。

```ts
// 1. 全ルート共通の既定値: vite.config.ts
adapter({ maxDuration: 20 })
```

```ts
// 2. ルート単位: src/routes/api/judge/+server.ts
import type { Config } from '@sveltejs/adapter-vercel';

export const config: Config = { maxDuration: 20 };
```

ルート単位の `config` を持つルートは、アダプタによって**専用の関数へ自動分割される**（`split` を明示しなくてよい）。判定エンドポイントをページSSRから隔離できるため、`/api/judge` 実装時はこちらを第一候補とする。

現状はアダプタ既定値として20秒を設定している。`maxDuration` は上限であって予約ではなく、Vercelの課金はactive CPU基準なので、ページ側に広めの上限が付いてもコストには影響しない。Phase 2で `/api/judge` にルート単位の設定を入れた後、アダプタ既定値を絞るかを判断する。

20秒は `JEV_TOTAL_TIMEOUT_MS` 12,000ms に検証・正規化・ログ出力の余裕を加えた値である。実装開始時に、契約プランで設定可能な上限と既定値をVercelのダッシュボードで確認する。[Configuring Maximum Duration](https://vercel.com/docs/functions/configuring-functions/duration) / [adapter-vercel](https://svelte.dev/docs/kit/adapter-vercel)

## 6. Jev client境界

推奨は、公式SDKを一度だけ初期化するserver-only moduleである。

```text
src/lib/server/jev-client.server.ts
  ├─ new TypeSafeClient({
  │    apiKey: env.TYPESAFE_API_KEY,
  │    defaultModel: env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest",
  │    timeout: 3500,          // 1試行。SDK既定は10000
  │    retry: {}               // SDK既定のまま（maxRetries: 2）
  │  })
  └─ evaluate(request, abortSignal) -> typed result
```

公式JavaScript SDKのクライアント設定には、APIキー、base URL、default model、ブラウザ利用を許可する `dangerouslyAllowBrowser`、timeout、retryがある。`dangerouslyAllowBrowser`は使わず、キー露出を防ぐ。[TypeSafeClientConfig](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig)

### timeout予算の算出根拠

SDKのtimeoutは1試行単位で、公式記載のデフォルトは10,000ms。総予算という概念はSDK側に無いため、retryを含む総時間はアプリのAbortControllerで制限する。

このとき、**1試行timeout × 試行回数 + backoffの合計が総予算に収まっていなければ、後続の試行は実行されない**。SDK既定の `maxRetries: 2`（最大3試行）、`backoffInitialMs: 500`（5,000まで倍化）を前提に逆算する。

```text
3500 + 500 + 3500 + 1000 + 3500 = 12,000ms  ← 推奨。3試行が予算内に収まる
8000 + 500 + 8000 + 1000 + 8000 = 25,500ms  ← 総予算12,000msでは試行2が途中で切れ、試行3は実行されない
```

1試行3,500msはJevの実測レイテンシ（公式例で百ms台）に対して十分な余裕がある。実機計測後に調整する場合は、上式の等号関係を保ったまま両方の値を動かす。

SDKは `apiTimeoutError` と `apiConnectionError` も既定でretryするため、アプリ側で再送を重ねない。詳細な既定値は [JEV_DESIGN.md](JEV_DESIGN.md) の §9 を参照。

**上の等式は通常時の計算であり、3試行の完了を保証しない。** SDKに総retry予算は無く（`RequestOptions.timeout` は1試行あたり）、`Retry-After` は最大60秒まで尊重される。上流が長い待機を指示すれば試行1の後で予算を使い切る。`JEV_TOTAL_TIMEOUT_MS` はあくまでAbortSignalによるハード上限であり、SDKへ渡した `signal` は送信中のリクエストに加えて**待機中のretryも中断する**。予算超過時は待機ごと打ち切り、504 / `UPSTREAM_TIMEOUT` を返す。

## 7. API route契約

### `POST /api/judge`

Request:

```json
{
  "mode": "love",
  "text": "もう君のことは忘れたはずなのに"
}
```

Response 200:

```json
{
  "requestId": "req_...",
  "mode": "love",
  "model": "jev-1.13.0",
  "latencyMs": 148,
  "usage": {
    "inputTokens": 392,
    "outputTokens": 65,
    "estimatedCostUsd": 0.000016464
  },
  "results": []
}
```

Client-visible error shape:

```json
{
  "error": {
    "code": "UPSTREAM_TIMEOUT",
    "message": "判定に時間がかかっています。入力を保持したまま再試行してください。",
    "requestId": "req_...",
    "retryable": true
  }
}
```

クライアントには内部のstack trace、Jev APIの生レスポンス、APIキー、入力本文、内部のcriteria全文を返さない。

### HTTP status mapping

| App status | code | 例 |
|---:|---|---|
| 400 | `INVALID_INPUT` | JSON不正、mode不正、空白のみ、281文字以上 |
| 401/500 | `CONFIGURATION_ERROR` | Jevキー未設定・無効。ユーザーには一般エラー |
| 422 | `QUESTION_DEFINITION_ERROR` | 固定質問またはCITYデータから生成した質問が不正 |
| 429 | `RATE_LIMITED` | upstreamまたはアプリ側のレート制限 |
| 502/503 | `UPSTREAM_UNAVAILABLE` | Jev障害・過負荷。上流の529をそのまま返さない（529はIANA未登録でCDN・プロキシの扱いが不定なため、アプリは503を返す） |
| 504 | `UPSTREAM_TIMEOUT` | total budget超過、SDK timeout、上流の408 / 504。いずれも再試行可能として表示する |

## 8. セキュリティ

### APIキー

- ブラウザからTypeSafe APIを直接呼ばない。
- SDKの `dangerouslyAllowBrowser` を有効にしない。
- キーをclient env、HTML、Svelte props、ログ、エラーメッセージへ入れない。
- 変更時はVercel secretを更新し、古いキーを無効化する。

### 入力とXSS

- Svelteの通常のテキストバインディングで表示し、`{@html}`を使わない。
- 入力はJevへ渡すだけで、Markdown / HTMLとして解釈しない。
- 結果ラベルとCITYのURLは静的なカタログからのみ出す。
- `source.url`は許可した`https://www.akitakata.jp/`または公式例規集ホストだけに制限し、ユーザー入力URLをリンクにしない。
- レスポンス本文をそのままDOMへ挿入しない。

### ログ・保存

- MVPではDB、ファイル、localStorage、cookieへの入力本文保存をしない。
- server logにはrequestId、mode、latency、status、model、usageのみを基本とし、textとJev request bodyを記録しない。
- TypeSafe SDKのdebug loggingを本番で有効にしない。公式SDKはdebugでbodyもログし得るため、ログレベルはwarnまたはerrorにする。
- Vercelのアクセスログや上流事業者の保持方針は、実装・公開前に各利用規約とDPAを確認する。

### 応答ヘッダー

| ヘッダー | 導入フェーズ | 実装場所 |
|---|---|---|
| `X-Content-Type-Options: nosniff` | Phase 1（実装済み） | `src/hooks.server.ts` |
| `Referrer-Policy: strict-origin-when-cross-origin` | Phase 1（実装済み） | `src/hooks.server.ts` |
| `Cache-Control: no-store`（`/api/*`） | Phase 1（実装済み） | `src/hooks.server.ts` |
| `Content-Type: application/json; charset=utf-8` | Phase 2 | `/api/judge` の `+server.ts` |
| **Content Security Policy** | **Phase 3** | `vite.config.ts` の `csp` |

### Content Security Policy の実装方式

**`hooks.server.ts` で手書きしない。** SvelteKitはハイドレーション用のインラインスクリプトを自前で生成するため、素の `Content-Security-Policy` ヘッダーを後付けするとページが動かなくなる。SvelteKitの `csp` 設定を使えば、生成した各インライン要素へnonceまたはhashが自動付与される。

設定は `sveltekit()` プラグインへ渡す（`KitConfig` を直接受けるため、`adapter` と同階層）。

```ts
// vite.config.ts
sveltekit({
	adapter: adapter({ maxDuration: 20 }),
	csp: {
		mode: 'auto',
		directives: {
			'default-src': ['self'],
			'script-src': ['self'],
			'connect-src': ['self'],
			'img-src': ['self', 'data:'],
			'frame-ancestors': ['none'],
			'base-uri': ['self'],
			'form-action': ['self']
		}
	}
})
```

実装時に注意する点が3つある。

1. **Svelte transition は `style-src` に影響する。** 多くのtransitionはインライン `<style>` を生成するため、UIでtransitionを使う場合は `style-src` を未指定にするか `unsafe-inline` を許可する必要がある。CITYの出典リンク以外に外部リソースを読まない設計なので、`style-src` を未指定のままにして他を締める方針で始める。
2. **prerenderされたページではCSPが `<meta http-equiv>` で入る。** この場合 `frame-ancestors`、`report-uri`、`sandbox` は無視される。
3. **`connect-src` は `self` で足りる。** ブラウザはTypeSafe APIを直接呼ばず、`/api/judge` だけを叩くため。

**Phase 3に置く理由。** 空のページへ先にCSPを入れても、違反が起きないため通って当然であり、UIが増えた時点で壊れる。結果カード、favicon、Tailwindの生成CSSが出揃うPhase 3で入れ、以後の実装で違反が出たらその場で気付ける状態にする。Production直前（Phase 6）に後付けすると、最も直したくないタイミングで壊れる。

## 9. Rate limit / abuse対策

MVPでは外部DBなしで過剰な設計をしない。ただし次の二層を用意する。

1. クライアント: 送信中の二重送信を禁止し、連打にクールダウンを置く。
2. サーバー: IP単位のbest-effort in-memory token bucketを実装し、例えば10 requests/minuteを既定値とする。serverlessのインスタンスを跨いで完全な制限にはならないことを明記する。

upstreamから429 / 529が返ったときは、公式SDKのbackoffと`retry-after`処理を利用する。アプリ側の追加retryは行わず、最終的に429ならユーザーへ待機を促す。

将来、公開範囲が広がった場合だけ、Vercel Edgeのレート制限機能または外部KVを検討する。

## 10. レイテンシとコスト計測

- `startedAt = performance.now()`をserver route入口で記録する。
- `latencyMs`は入力検証後からJev応答の正規化完了までのサーバー処理時間と定義する。
- ユーザーが見たTotal UI latencyは別物なので、必要になった場合のみクライアント側で別計測する。
- Jev responseの`model`、`usage.input_tokens`、`usage.output_tokens`を取得できた場合のみ表示する。
- コスト推計は `input_tokens / 1_000_000 * 0.042` を初期式とし、「推計」とラベル付けする。
- 監視・ログに入力本文を含めない。

## 11. デプロイ

- Vercel projectへ接続し、framework presetをSvelteKitにする。
- PreviewとProductionの環境変数を分離する。
- `maxDuration` が `JEV_TOTAL_TIMEOUT_MS` より大きいことを `.vercel/output/**/.vc-config.json` で確認し、Previewで実際にtimeoutを踏んで504が返ることを確認する。
- Node.js runtimeはTypeSafe JavaScript SDKの要件であるNode.js 20以上に合わせる。[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- 最初のProduction deploy前に、Previewで以下を確認する。
  - APIキーがクライアントbundleに存在しない
  - `POST /api/judge`がJevへ到達する
  - timeout / 429 / 422を画面が処理する
  - CITYの出典リンクが許可ドメインだけを開く
  - 画面に入力本文が保存されない
  - CSPヘッダーが付与され、コンソールにCSP違反が出ない

## 12. 監視の最小項目

- request count by mode
- success / error count by error code
- p50 / p95 latency
- upstream 429 / 529 count
- input token total（本文なし）
- model version distribution
- CITY `other_or_unclear`率、low-confidence率

MVPで外部Observabilityを増やしすぎず、Vercelのログと構造化server logで始める。コストや失敗の傾向が見えたら追加する。
