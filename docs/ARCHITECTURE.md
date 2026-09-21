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
data/city/*.json ─────────────────┐
question catalog / labels ─────────┴─ server only
```

## 3. データフロー

1. ブラウザは入力文とモードだけを `POST /api/judge` へ送る。
2. server routeが `Content-Type: application/json`、**ボディのサイズ上限**、mode enum、280 code points、空白のみを検証する。

   **ボディは上限つきで読む。** `request.json()` は本文全体をメモリへ展開してから返すため、文字数を検証する前に巨大なボディを読み込んでしまう。上限（8KB）を超えた時点でストリームの読み取りを打ち切る。`Content-Length` は詐称できるので、宣言値で早期に弾いたうえで、実際に読んだバイト数でも見る。

   8KBという値は、280 code pointsの日本語がUTF-8で840バイト程度、絵文字だけでも1,120バイト程度であることから決めた。JSONのエスケープとキー名を足しても数KBに収まるため、正当な入力を拒まない。
3. `questionCatalog` がモードの質問を返す。
4. CITYでは読み込んだデータセットの activeな組織単位から `route_to.criteria`を生成する。
5. Jev公式SDKをserver-only moduleで呼び出す。
6. SDKの応答を、TypeSafe生型の検証後に `JudgeResponse`へ正規化する。
7. CITYでは `route_to`の候補IDを静的データへjoinし、根拠情報を付加する。
8. ブラウザは結果を表示する。入力文は保存せず、レスポンスにも不要なら再掲しない。

### Semantic Fit の論理フロー（実装済み）

#### CITY Semantic Fit

```text
Browser
  -> /api/judge (mode=city, experimental flag)
  -> 既存のCITY Choiceを1回評価
  -> 上位1〜2課を決定、各課の代表分掌を最大12件へ絞る
  -> Semantic Fit Noulを追加で最大1回評価
  -> アプリ側で順位付け
  -> responsibilityIdで静的CITYデータへjoin
  -> 現行結果 + experimental block（任意）
```

既定のCITY経路はこの追加分岐を通らない。追加呼び出しの失敗、timeout、レート制限、answer欠落は、現行のChoiceと根拠joinを返すfallback条件とする。2回のJev呼び出しを許す場合は、既存の1回分 `JEV_TOTAL_TIMEOUT_MS` とは別にrequest-level deadlineを設ける。

#### SPEC FIND PDF v0

```text
Browser
  -> /api/judge (mode=spec-find)
  -> server-onlyで固定済みのpassage JSONを読む
  -> passage数・文字数の上限を検証
  -> 1回のbounded Jev requestで各passageを独立Noul評価
  -> アプリ側でfitProbability順に並べる
  -> passageIdで文書版・章節・ページ・公式PDF URLへjoin
  -> 上位候補またはabstainを表示
```

SPEC FIND v0はランタイムで公式サイトへアクセスしない。機能要件Excel、項目定義書、API仕様書もこのフローへ含めない。コーパスがbounded requestに収まらなくなった場合だけ、Stage 1 Choiceを含む二段階方式を再検討する。

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
│   │   │   ├── city-evidence.server.ts
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
│   ├── city/
│   │   ├── fictional-m-city.json   # 公開用。コミットする
│   │   └── local-*.json             # 実データ。gitignore（§9 of CITY_DATA）
│   ├── spec/                        # SPEC FIND のpassage corpus（下記）
│   └── batch/                       # BATCH JUDGE の評価用fixture（下記）
├── static/
│   ├── favicon.svg             # 優先
│   ├── favicon.png             # SVG 非対応環境のフォールバック
│   ├── og-image.jpg
│   └── robots.txt
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

Semantic 拡張で追加した構成は次のとおり。

```text
data/spec/
└── common-feature-2.7.json       # 公式PDFから正規化したbounded passage corpus
                                  # 版・取得日・URL・content hash を同じファイルへ持つ

src/lib/server/
├── semantic-match.server.ts      # CITY / SPEC FIND共通のNoul評価・順位付け
├── semantic-policies.server.ts   # ドメインごとの質問文と閾値
├── spec-corpus.server.ts         # コーパス検証と PDL 1.0 の出典表示
├── spec-evidence.server.ts       # passageIdから出典へのjoin
├── spec-find.server.ts           # SPEC FINDの入口。feature flagとコーパス読み込み
└── city-semantic.server.ts       # CITY Stage 2 の shadow 実験

scripts/
└── build-spec-corpus.mjs         # 公式PDFからコーパスを生成する（PDFは同梱しない）
```

BATCH JUDGE で追加した構成は次のとおり。**Jev呼び出しの経路とUIはまだ無い。** 方式を決めるための実測までが入っている。

```text
data/batch/
├── privacy.json                  # 3テーマ各50件。人手で付けた正解ラベル付き
├── deadline.json                 # gold は Jev の出力ではない（BATCH_JUDGE_DESIGN §5）
└── dx.json

src/lib/types/
└── batch.ts                      # テーマ・ラベル・事例の型

src/lib/server/
├── batch-questions.server.ts     # Jevとの契約。質問ID・primitive・instructions・
│                                 # criteria・stateの参照パス・answer欠落時の扱い
├── batch-dataset.server.ts       # fixture の読み込み時検証と内訳の集計
├── batch-questions.spec.ts       # 契約の検査
├── batch-dataset.spec.ts         # 検証と配布fixtureの性質を確かめる
└── batch-judge.live.spec.ts      # 方式を決めるための実測。既定でスキップし、
                                  # LIVE_JEV=1 のときだけ上流を呼ぶ
```

`data/batch`のfixtureは`data/spec`と同じ扱いで、読み込み時に全フィールドを検証する。goldの綴り違いが「不一致」として集計されると、benchmarkがデータの壊れ方を測ってしまうため（[BATCH_JUDGE_DESIGN.md](BATCH_JUDGE_DESIGN.md) §5）。

`data/spec`のpassage JSONは静的・バージョン管理対象とし、公式サイトからのランタイム取得は行わない。PDF本体は1.6MBあり公式URLから常に取得できるため同梱せず、出力JSONだけをコミットする。メタデータは別ファイルに分けず同じJSONへ入れる。同じ事実を2箇所に持つと必ず片方が古くなるため（[SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) §4）。

本プロジェクトでは設定を `vite.config.ts` へ集約し、`svelte.config.js` を置かない。SvelteKit 2.62 以降は `sveltekit()` プラグインが `KitConfig` を直接受け取れるようになっており、その場合 `svelte.config.js` は無視される。`svelte.config.js` を使う方式も引き続きサポートされているため、必要になれば移せる。adapter、CSP、runes モード（Svelte 5）の強制はいずれも `vite.config.ts` に置く。

`*.server.ts`はブラウザへバンドルされないserver-only境界を意図する。Jevキーを持つモジュールは `src/lib/server/` からしかimportしない。

## 5. 環境変数

| 変数 | 必須 | 用途 | クライアント公開 |
|---|---:|---|---:|
| `TYPESAFE_API_KEY` | Yes | TypeSafe API Bearer key | No |
| `TYPESAFE_DEFAULT_MODEL` | No | 既定モデル。推奨 `jev-latest` | No |
| `TYPESAFE_BASE_URL` | No | SDKのAPI root。通常は既定値を使う | No |
| `JEV_TIMEOUT_MS` | No | 1試行timeout。推奨3500（§6の算出根拠を参照） | No |
| `JEV_TOTAL_TIMEOUT_MS` | No | retryを含む1回ぶんの総予算。推奨12000。**16,000msで頭打ち** | No |
| `JEV_INPUT_PRICE_PER_MILLION_TOKENS` | No | コスト推計。既定0.042 | No |
| `APP_RATE_LIMIT_PER_MINUTE` | No | アプリ側のbest-effort上限 | No |
| `CITY_DIRECTORY` | No | CITYのデータセット名。既定は架空データ `fictional-m-city`（[CITY_DATA.md](CITY_DATA.md) の §9） | No |
| `CITY_SOURCE_HOSTS` | No | 出典URLに許可するホスト（カンマ区切り）。未設定ならURLを持つ出典を許さない | No |
| `PUBLIC_SITE_URL` | No | サイトの起点URL。OGPの絶対URL生成に使う。未設定なら画像系のmetaを出さない | Yes |
| `PUBLIC_APP_LABEL` | No | CITYのデモ注意文など公開可能な表示設定 | Yes可 |
| `SPEC_FIND_ENABLED` | No | SPEC FINDを有効にする。明示的な `true` だけ | No |
| `CITY_SEMANTIC_EXPERIMENT` | No | CITY Stage 2 のshadow実験を有効にする。明示的な `true` だけ | No |

Semantic 拡張で追加した環境変数は次のとおり。どちらもfeature flagで、既定は安全側（無効）である。明示的な `true` だけを有効とし、`1` や `TRUE` では有効にならない。

| 変数 | 既定 | 用途 |
|---|---|---|
| `SPEC_FIND_ENABLED` | 無効 | SPEC FIND の UI と API。**本番で有効にする** |
| `CITY_SEMANTIC_EXPERIMENT` | 無効 | CITY Stage 2 の shadow 経路。**本番では無効のまま** |

候補数や上限は環境変数にしていない。実測で決めた値をコードの定数として持ち、変更するときは測り直す前提にする。

- `MAX_CANDIDATES_PER_REQUEST = 40`（`semantic-match.server.ts`）
- `MAX_PASSAGES = 40` / `MAX_PASSAGE_CHARS = 600` / `MAX_CORPUS_CHARS = 20,000`（`spec-corpus.server.ts`）
- `MAX_RESPONSIBILITIES = 12` / `MAX_SECTIONS = 1`（`city-semantic.server.ts`）

データセットのIDも固定する。SPEC FIND は第2.7版のコーパスを直接importしており、環境変数で差し替えられない。差し替えを許すと、検証していないデータで公開する経路ができる。

feature flagはクライアントから任意値を受け取らず、server route側で判定する。APIキー、データセット、source URLのallowlistは引き続きserver-onlyで扱う。

`.env`はコミットしない。VercelではPreview / Productionごとに分離する。`PUBLIC_` prefix以外の秘密はSvelteのpublic env importへ渡さない。

### 関数の最大実行時間（環境変数ではない）

Vercelは関数に既定の最大実行時間を設定しており、超えるとプラットフォーム側が関数を終了させる。これは環境変数ではなくデプロイ設定で指定する。

`JEV_TOTAL_TIMEOUT_MS` が既定値を超えていると、アプリのtimeout処理（504 / `UPSTREAM_TIMEOUT`）へ到達する前に関数が殺され、ユーザーにはプラットフォームのエラーが出る。**総予算より確実に大きい `maxDuration` を明示設定する。**

そのうえで、`/api/judge` は**リクエスト全体の予算 `REQUEST_BUDGET_MS = 16,000ms`** を持ち、すべての `evaluate` 呼び出しへ残り時間を渡す。`evaluate` は1回ぶんの総予算と渡された残りの短い方を使うため、`JEV_TOTAL_TIMEOUT_MS` に16秒を超える値を設定しても16秒で頭打ちになる。設定が `maxDuration` を踏み抜くのを、環境変数の運用ではなくコードで防ぐ。

渡し忘れるとこの上限が効かない。CITY Stage 2 と SPEC FIND を足したときに Stage 1 への受け渡しが漏れており、`JEV_TOTAL_TIMEOUT_MS` を大きくすると `maxDuration` を先に踏む状態になっていた。全モードの Stage 1 が予算を受け取ることをテストで固定している。

**`vercel.json` の `functions` グロブは使えない。** adapter-vercelはBuild Output API v3を使い、`.vercel/output/functions/**/.vc-config.json` をアダプタ自身が書き出す。生成される関数名は `catchall.func` などであり、`src/routes/api/judge/+server.ts` のようなソースパスとは一致しないため、`vercel.json` に書いても適用されない。

設定方法は次の2つで、いずれも実測で `.vc-config.json` への反映を確認済み。

```ts
// 1. 全ルート共通の既定値: vite.config.ts
adapter({ maxDuration: 20 })
```

```ts
// 2. ルート単位: src/routes/api/judge/+server.ts
import type { Config } from '@sveltejs/adapter-vercel';

export const config: Config = { maxDuration: 20, split: true };
```

**専用の関数にしたい場合は `split: true` が必要である。** アダプタはルートをconfigのハッシュでグルーピングし、同じconfigを持つルートは1つの関数を共有する。`split: true` はそのグループIDを強制的にユニークにする。

```js
// adapter-vercel の該当箇所
const id = config.split ? `${hash}-${groups.size}` : hash;
```

ビルド出力で確認した挙動は次のとおり。`maxDuration` だけを指定した2ルートは同じ関数を指すシンボリックリンクになり、`split: true` を付けたルートだけが別の実体を持つ。

```text
__pa.func -> ../![-]/1.func   maxDuration 33
__pb.func -> ../![-]/1.func   maxDuration 33（__pa と共有）
__pc.func -> ../![-]/2.func   maxDuration 33 + split: true（専用）
```

現時点では `/api/judge` 以外に固有configを持つルートが無いため `split` なしでも結果的に単独の関数になるが、それは偶然の産物であり保証ではない。将来ルートが増えたときに同居してしまうのを防ぐため、判定エンドポイントには `split: true` を明示する。

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
| 400 | `INVALID_INPUT` | ボディが8KB超、JSON不正、mode不正、空白のみ、281文字以上 |
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
- `source.url`は`CITY_SOURCE_HOSTS`で許可したホストのhttpsだけに制限する。**許可ホストの一覧はリポジトリに書かない**（自治体が特定されるため）。未設定ならURLを持つ出典を一切許さず、架空データはURLを持たないので公開時はこれで足りる。ユーザー入力URLをリンクにしない。
- レスポンス本文をそのままDOMへ挿入しない。

### ログ・保存

- MVPではDB、ファイル、localStorage、cookieへの入力本文保存をしない。
- server logにはrequestId、mode、latency、status、model、usageのみを基本とし、textとJev request bodyを記録しない。
- TypeSafe SDKのdebug loggingを本番で有効にしない。公式SDKはdebugでbodyもログし得るため、ログレベルはwarnまたはerrorにする。
- Vercelのアクセスログや上流事業者の保持方針は、実装・公開前に各利用規約とDPAを確認する。

### 検索エンジンとSNSクローラーの扱い

`static/robots.txt` で**検索エンジンは拒否し、SNSのリンク展開だけ通す**。

全拒否にすると、SNSのクローラーも `robots.txt` を尊重するためOGPカードが表示されない。一方で検索流入は塞ぎたい（[CITY_DATA.md](CITY_DATA.md) の §9）。リンクを踏んだ人だけが到達する経路は残す、という切り分けである。

`robots.txt` はUser-agentごとに最も具体的なgroupだけが適用されるため、個別のクローラーに `Allow: /` を書いた上で、最後に `User-agent: *` を `Disallow: /` にする。

### OGP

`og:image` は**絶対URL**でなければクローラーが解決できない。`PUBLIC_SITE_URL` から組み立て、**未設定なら画像系のmetaを出さない**。壊れた相対URLを出すくらいなら出さない方がよい。クローラーはどちらも無視するが、出さなければ設定漏れだと分かる。サーバー起動時にも警告を残す。

設定漏れはローカルでは踏めないため、E2Eで次を検証する。

- `og:image` が絶対URLであること
- `og:type` / `og:title` / `og:description` / `og:url` が揃うこと
- `og:image:width` / `height` の宣言が実画像のPNGヘッダーと一致すること
- `robots.txt` が検索を拒否しつつSNSを通すこと

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

1. **`style-src` は明示的に指定する。** 未指定にすると、dev では SvelteKit が `'unsafe-inline'` を補うが、**本番ビルドでは補われず `default-src` へフォールバックし、インライン `style` 属性がブロックされる**。結果カードのバーは幅と色を `style` 属性で与えているため、本番だけ描画が壊れる。実際にこの状態でPhase 3を終えており、Phase 5のE2Eで検出した。

   ```ts
   'style-src': ['self', 'unsafe-inline']
   ```

   `'unsafe-inline'` を含めると、SvelteKit はスタイルにhash/nonceを付ける必要がないと判断する（`style_needs_csp` が false になる）。Svelte の transition もインライン `<style>` を生成するため、いずれにせよ許可が要る。

   実際のレスポンスヘッダーで確認した値は次のとおり。

   ```text
   content-security-policy: default-src 'self'; connect-src 'self'; font-src 'self';
     img-src 'self' data:; object-src 'none';
     script-src 'self' 'nonce-…'; style-src 'self' 'unsafe-inline';
     base-uri 'self'; form-action 'self'; frame-ancestors 'none'
   ```

   `style-src` がゆるい分、`script-src` を nonce で締めることと `object-src 'none'` / `base-uri 'self'` / `form-action 'self'` を効かせることで XSS の実害を抑える。

2. **prerenderされたページではCSPが `<meta http-equiv>` で入る。** この場合 `frame-ancestors`、`report-uri`、`sandbox` は無視される。
3. **`connect-src` は `self` で足りる。** ブラウザはTypeSafe APIを直接呼ばず、`/api/judge` だけを叩くため。

**Phase 3に置く理由。** 空のページへ先にCSPを入れても、違反が起きないため通って当然であり、UIが増えた時点で壊れる。結果カード、favicon、Tailwindの生成CSSが出揃うPhase 3で入れ、以後の実装で違反が出たらその場で気付ける状態にする。Production直前（Phase 6）に後付けすると、最も直したくないタイミングで壊れる。

## 9. Rate limit / abuse対策

MVPでは外部DBなしで過剰な設計をしない。ただし次の二層を用意する。

1. クライアント: 送信中の二重送信を禁止し、連打にクールダウンを置く。**Phase 3**。
2. サーバー: 送信元アドレス単位のbest-effort in-memory token bucket。既定は10 requests/minuteで、`APP_RATE_LIMIT_PER_MINUTE`（正の整数）で変更できる。読めない値を黙って既定値へ戻すと、絞ったつもりのまま10 requests/minuteで走り続ける。設定してあるのに読めない場合は `RATE_LIMIT_INVALID` を警告として残す。**Phase 5で実装済み**（`src/lib/server/rate-limit.server.ts`）。

### 実装上の判断

**固定窓ではなくトークンバケットにした。** 固定窓は窓の境界で `limit × 2` を許してしまう。経過時間に比例して補充する方式なら境界が無い。テストで「窓末尾に上限まで使い、次の窓頭で同数は通らない」ことを固定している。

**入力検証より先に判定する。** 上流を呼ばないリクエストでも枠を消費させる。そうしないと、壊れたリクエストの連打でサーバーを回させられる。

**追跡するキー数に上限を設ける（既定10,000）。** 送信元アドレスは詐称できるため、無制限に覚えるとメモリ枯渇の経路になる。上限に達したら挿入順が最も古いものから捨てる。使い続けているキーは参照のたびに順序が更新されるので押し出されにくい。

**拒否時は `Retry-After` を返す。** 次の1トークンが貯まるまでの秒数で、1秒以上に切り上げる。

serverlessではインスタンスを跨いで状態を共有しないため、**完全な制限にはならない**。踏み台からの大量アクセスを止める手段ではなく、素朴な連打と事故を抑えるためのものである。公開範囲が広がる場合はVercel Edgeのレート制限機能か外部KVを検討する。

判定APIは上流に課金が発生するため、公開前に必ず入れる。ただしUIが無い段階では踏みようがないため、画面と一緒に検証できるPhase 5に置く。

upstreamから429 / 529が返ったときは、公式SDKのbackoffと`retry-after`処理を利用する。アプリ側の追加retryは行わず、最終的に429ならユーザーへ待機を促す。

将来、公開範囲が広がった場合だけ、Vercel Edgeのレート制限機能または外部KVを検討する。

## 10. レイテンシとコスト計測

- `startedAt = performance.now()`をserver route入口で記録する。
- `latencyMs`は入力検証後からJev応答の正規化完了までのサーバー処理時間と定義する。
- ユーザーが見たTotal UI latencyは別物なので、必要になった場合のみクライアント側で別計測する。
- Jev responseの`model`、`usage.input_tokens`、`usage.output_tokens`を取得できた場合のみ表示する。
- コスト推計は `input_tokens / 1_000_000 * 0.042` を初期式とし、「推計」とラベル付けする。
- 監視・ログに入力本文を含めない。

次期拡張では、既存の1回判定とSemantic Fit追加分を分けて計測する。

- `baseUpstreamLatencyMs`: 現行のChoice / Score / Noul呼び出し
- `semanticUpstreamLatencyMs`: CITY追加評価またはSPEC FINDのbounded request
- `latencyMs`: request-level deadline内の総処理時間
- `baseInputTokens` / `semanticInputTokens`: それぞれの推計コストの元になる値
- `passageCount`、`responsibilityCount`、`datasetVersion`

入力本文、passage全文、CITYの分掌全文はログへ出さない。候補数・データセット版・token数だけで、token増加と精度差を追えるようにする。CITYの追加呼び出しを導入する場合は、既存の `JEV_TOTAL_TIMEOUT_MS` をそのまま2回適用せず、外側のdeadline、fallback、Vercel `maxDuration`を一組で設定する。

## 11. デプロイ

- Vercel projectへ接続し、framework presetをSvelteKitにする。
- PreviewとProductionの環境変数を分離する。
- `maxDuration` が `JEV_TOTAL_TIMEOUT_MS` より大きいことを `.vercel/output/**/.vc-config.json` で確認し、Previewで実際にtimeoutを踏んで504が返ることを確認する。
- Node.js runtimeは **22.12以上**とする。TypeSafe JavaScript SDK が要求するのは `>=20` だが（[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)）、Node 20 系は 2026-04-30 にサポートが終了しており、`pnpm spec:build` が型ストリップ（Node 22.6以降）を使う。CI と Vercel（`nodejs22.x`）も 22 系である。`package.json` の `engines` と `.npmrc` の `engine-strict=true` で強制する。
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

### ログの形

1リクエスト1行のJSONで出す。複数行に分けると集計しづらい。入力本文、APIキー、上流のレスポンス本文は含めない。

```json
{"route":"api/judge","requestId":"req_…","mode":"love","status":200,
 "model":"jev-1.13.0","upstreamLatencyMs":640,"latencyMs":642,
 "inputTokens":944,"questionCount":7}
```

```json
{"route":"api/judge","requestId":"req_…","mode":"love","status":429,
 "code":"RATE_LIMITED","latencyMs":1,"detail":"…"}
```

`latencyMs` から p50 / p95 を、`status` と `code` から失敗の種別ごとの件数を、`model` からモデル分布を、`inputTokens` からコストを算出できる。項目が揃っていることはテストで固定している。

`upstreamLatencyMs` はJevの往復、`latencyMs` は入力検証後から正規化完了までのサーバー処理時間で、別物として記録する。
