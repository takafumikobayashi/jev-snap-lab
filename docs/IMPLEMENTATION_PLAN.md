# Implementation Plan

## 1. 前提

この文書は、設計完了後に `この設計どおりMVPを実装してください` と指示された場合の作業順を定義する。今回の作業ではアプリケーションコードを作成しない。

推奨ベースライン:

- SvelteKit + TypeScript + Tailwind CSS
- Node.js 20以上 / pnpm（開発環境の npm 10.9.3 でこの構成の依存をインストールできなかったため。詳細は README を参照）
- TypeSafe公式JavaScript SDK
- Vercel
- DBなし、入力永続化なし
- `TYPESAFE_DEFAULT_MODEL=jev-latest`
- 回帰テストの比較対象は `jev-1.13.0` を明示

## 2. フェーズ

### Phase 0: 実装前確認

目的: 未確認の外部仕様・重要選択肢を潰す。

タスク:

- TypeSafe ConsoleでAPIキーを取得し、開発用と本番用を分離
- `@typesafe-ai/sdk`の現行インストールとNode.js 20 runtimeを確認
- JavaScript SDKのretry既定値の**実測確認**（既定値は [JEV_DESIGN.md](JEV_DESIGN.md) §9 に記載済み）。通常時に1試行3,500ms×3試行が12,000msに収まることと、`Retry-After` で待機が伸びた場合にtotal timeoutが待機ごと中断することの両方を確認する
- Vercelの契約プランにおける関数 `maxDuration` の既定値と上限を確認する（設定先は `vite.config.ts` のアダプタ設定とルートの `export const config`。`vercel.json` の `functions` グロブは adapter-vercel では効かない）
- `jev-latest`と`jev-1.13.0`の応答shapeを確認
- 日本語のLOVE / SOCIAL / CITY入力で質問群を試行
- 安芸高田市の公式組織ページと令和8年4月1日施行の事務組織規則の差分を再確認
- CITY初期データの係・分掌を完全にJSON化

完了条件:

- 仕様差分が `docs/JEV_DESIGN.md` / `docs/CITY_DATA.md`へ反映されている。
- 重大な仕様未確認が「実装を止める」ものか「要観測」か分類されている。

### Phase 1: プロジェクト基盤

依存: Phase 0

タスク:

- SvelteKitプロジェクトを初期化
- TypeScript / Tailwind CSS / Vercel adapterを設定
- lint / format / typecheck / testスクリプトを設定
- `.env.example`を追加
- `src/lib/types`と共通エラー形式を追加
- `Cache-Control: no-store`などのセキュリティヘッダーを設定
- `vite.config.ts` のアダプタ既定値へ `maxDuration` を設定（`JEV_TOTAL_TIMEOUT_MS` より大きい値）。`vercel.json` の `functions` グロブは adapter-vercel では効かない

完了条件:

- 空のトップページがローカル起動する。
- TypeScript、lint、テストがCI相当のコマンドで通る。

### Phase 2: Jev server adapter

依存: Phase 1

タスク:

- `jev-client.server.ts`に公式SDKをserver-onlyで初期化
- `JEV_TIMEOUT_MS`（1試行3,500ms）とtotal timeout（12,000ms）を設定
- mode別question catalogを定義。**type別の `criteria` の形（Choice=map / Score=array / Noul={true,false}）を守る**
- 送信前に `criteria` の形・Score 2〜10要素・Choice 255候補以下を検証する
- 入力schema（mode / text / 280 code points）を実装
- TypeSafe raw responseのruntime validationを実装
- Choice / Score / Noulを`ResultCard`へ正規化。Scoreは `probabilities` 最大レベルから表示ラベルを決める（[JEV_DESIGN.md](JEV_DESIGN.md) §8）
- usage、model、latencyを応答へ含める
- 401 / 422 / 429 / 529 / timeout / network errorをapp errorへ変換
- `+server.ts` に `export const config: Config = { maxDuration: 20, split: true }` を追加する。`split` を省くとconfigが同じ他ルートと関数を共有するため、専用関数にするには明示が必要

完了条件:

- 固定fixtureで3種類のanswerを正規化できる。
- Scoreが小数（例 `score: 1.05`）でも表示ラベルが `probabilities` 最大レベルと一致する。
- 不正な `criteria` の形を送信前に検出できる。
- 実機キーで各モードを1回ずつ判定できる。
- APIキーがクライアントbundleに含まれない。

### Phase 3: 共通UI

依存: Phase 1、Phase 2のAPI契約

タスク:

- 1画面レイアウト、モードタブ、textarea、文字数、JUDGEを作る
- 送信中の二重送信防止と古いレスポンス破棄を実装
- Choice / Score / Noul各カードを作る
- probabilityとconfidenceを分離して表示
- latency、model、usage推計を表示
- idle / validating / judging / success / errorを作る
- モバイル・キーボード・スクリーンリーダー対応
- `vite.config.ts` に `csp` を設定する（手書きヘッダーではなくSvelteKitの機構を使う。[ARCHITECTURE.md](ARCHITECTURE.md) の §8 を参照）

完了条件:

- モックレスポンスで3モードの画面が崩れず表示される。
- CSP有効時にハイドレーションが動作し、ブラウザコンソールにCSP違反が出ない。
- 280文字超過、空白のみ、通信失敗を画面で確認できる。
- バーの色だけに依存せず数値とラベルが表示される。

### Phase 4: モード固有実装

依存: Phase 2、Phase 3

タスク:

- LOVEの質問群、表示ラベル、注意文を実装
- SOCIALの質問群、表示ラベル、人格断定を避ける文言を実装
- CITYの静的データを`data/city/`へ追加
- CITYの`route_to` criteriaを **`routingCandidateId`（課レベル）** でグルーピングして生成
- Jev candidate IDを公式出典データへjoin。係はローカルのkeyword / responsibilityマッチで解決し、決まらなければ課までの表示に留める
- `request_category` の候補を `city-directory.json` の `categories` から生成（二重定義しない）
- CITYの根拠URL、locator、取得日、有効日を表示
- CITYのデモ・非公式案内注意文を表示

完了条件:

- 指定の受入テスト入力が期待候補または合理的な上位候補を返す。
- CITY結果に根拠URLが出て、出典なしの課を公式候補として表示しない。

### Phase 5: テスト・セキュリティ・観測

依存: Phase 4

タスク:

- unit test: Unicode code point制限、入力schema、cost、表示丸め、error mapping
- contract test: Jev fixtureのChoice / Score / Noul shape
- question snapshot test: modeごとのquestion ID、criteria、instructions
- criteria shape test: Score=array（2〜10）、Choice=map（255以下）、Noul={true,false}
- CITY data test: 同じ課の全レコードが同じ `routingCandidateId` を持つ。`routingCategories` が `categories` の部分集合である
- CITY data test: active recordのsourceRefs、URL allowlist、effective date
- e2e: 入力→送信→結果、エラー→再試行、モード切替
- `rate-limit.server.ts` を実装する（IP単位のbest-effort in-memory token bucket、既定 10 requests/minute。[ARCHITECTURE.md](ARCHITECTURE.md) の §9）
- secret scanとclient bundle確認
- CSPヘッダーが実際に付与され、違反なくページが動作することを確認
- request本文がログに出ないことを確認
- p50 / p95 latencyとupstream errorのログを確認

完了条件:

- CIでtypecheck、lint、unit、contractが通る。
- Preview環境で実機の1往復を完了する。
- 重要なセキュリティ受入条件が満たされる。

### Phase 6: Preview / Production

依存: Phase 5

タスク:

- Vercel Previewへデプロイ
- envをPreview / Productionに分離
- APIキー、モデル、timeoutを確認
- 低コストのスモークテストを実施
- Productionへデプロイ
- READMEのローカル実行方法を実装後の実際のコマンドへ更新
- CITY_DATAの取得日とデータバージョンを確認

完了条件:

- 公開URLで3モードを判定できる。
- エラー時にキーや内部レスポンスが露出しない。
- CITYが正式行政サービスでないことが画面で分かる。

## 3. 依存関係

```text
Phase 0 外部仕様・公式データ確認
          │
          ▼
Phase 1 基盤 ───────────────┐
          │                 │
          ▼                 ▼
Phase 2 Jev adapter      Phase 3 共通UI
          └──────────────┬──┘
                         ▼
                    Phase 4 モード
                         ▼
                    Phase 5 QA
                         ▼
                    Phase 6 deploy
```

Phase 2とPhase 3はAPI契約を先に固定すれば並行できる。Phase 4 CITYはデータ出典のレビューを終えるまでProductionへ出さない。

## 4. 受入テストケース

### 共通

| ID | 操作 | 期待結果 |
|---|---|---|
| C-01 | LOVE / SOCIAL / CITYを切り替える | UIラベルと質問群が切り替わる |
| C-02 | 280 code points以内を送信 | 200、結果カード、model、latencyが表示される |
| C-03 | 281 code pointsを送信 | クライアントとサーバーの両方で拒否 |
| C-04 | 空白のみを送信 | JUDGE disabledまたは400 |
| C-05 | 送信中にJUDGEを連打 | Jevリクエストが重複しない |
| C-06 | timeout fixture | 入力を保持し、再試行を表示 |
| C-07 | 429 / 529 fixture | retry後に待機メッセージ。無限retryしない |
| C-08 | 401 fixture | 一般エラーのみ表示。キー値を表示しない |
| C-09 | XSS文字列を入力 | HTMLとして実行されず文字列として扱われる |

### LOVE

| ID | 入力 | 検証 |
|---|---|---|
| L-01 | もう君のことは忘れたはずなのに | `romantic_frame` の分布と、`still_loves` / `relationship_ended` のNoulを別カードで表示 |
| L-02 | 明日も一緒に帰ろうね | `not_romantic`や低い恋愛シグナルを表示し得る。断定しない |
| L-03 | 会えない距離が気持ちを強くする | long-distanceとpassionateを複数軸で表示し得る |

### SOCIAL

| ID | 入力 | 検証 |
|---|---|---|
| S-01 | ChatGPT便利すぎてExcel開かなくなった | surprise / humor / casualness / reaction_baitを表示 |
| S-02 | これは絶対に許せない。みんなはどう思う？ | discussion / taunting / invites_agreementを独立表示 |
| S-03 | 今日の作業で知らなかったショートカットを覚えた | learningが高い読みを表示し得る |

### CITY

| ID | 入力 | 検証 |
|---|---|---|
| Y-01 | 家の前の防犯灯が切れてます | 危機管理課候補（課レベル）、公式出典、現地確認軸 |
| Y-02 | 道路に大きな穴があって危ない | 建設課候補、緊急度、現地確認軸 |
| Y-03 | ごみの分別方法が分かりません | 環境政策課候補。地域別ルールは自動回答しない |
| Y-04 | 水道料金の支払いについて | 外部事業体候補を市の課と区別 |
| Y-05 | 何か困っています | `other_or_unclear`、location_information_missing、人確認を表示 |

## 5. Definition of Done

### 機能

- [ ] 3モードを1画面で切り替えられる
- [ ] 最大280 Unicode code pointsをclient/server両方で検証する
- [ ] 1回のJev呼び出しで複数質問を返す
- [ ] Choice / Score / Noulをそれぞれ正しく表示する
- [ ] LOVE、SOCIAL、CITYの質問IDと表示ラベルが設計と一致する
- [ ] CITYの候補に公式根拠データがjoinされる
- [ ] `route_to` が課レベルで、係はローカルjoinで解決される
- [ ] カテゴリ一覧が `city-directory.json` のみに定義されている

### Jev

- [ ] APIキーはserver-only
- [ ] 実レスポンスのmodelとusageを扱える
- [ ] latencyを計測して表示できる
- [ ] `probabilities`、`confidence`、`noul`を混同しない
- [ ] 401 / 422 / 429 / 529 / timeout / network failureを処理する
- [ ] retryに上限があり、AbortSignalによる総時間上限が効いている（保留中のretry待機も中断される）
- [ ] Vercelの `maxDuration` が総予算より大きく設定され、`.vercel/output/**/.vc-config.json` に反映されている
- [ ] type別の `criteria` の形を守り、送信前に検証している
- [ ] Scoreの表示ラベルを `Math.round(score)` で引いていない

### セキュリティ・プライバシー

- [ ] 入力本文を永続保存しない
- [ ] 入力本文を本番ログへ出さない
- [ ] `dangerouslyAllowBrowser`を使わない
- [ ] `{@html}`を使わずXSSを防ぐ
- [ ] responseにAPIキー、生レスポンス、内部stack traceを含めない
- [ ] `Cache-Control: no-store`を設定する
- [ ] Content Security Policyを設定し、CSP違反なくページが動作する
- [ ] アプリ側のレート制限が有効で、超過時に 429 `RATE_LIMITED` を返す

### CITY

- [ ] 部 / 課 / 係 / 分掌 / 市民向け説明 / 根拠URL / 取得日 / 有効日がデータ化されている
- [ ] 公式組織ページと事務組織規則の出典を分けて保持する
- [ ] 係未確認を推測で埋めていない
- [ ] external operatorを市課と区別する
- [ ] 正式な行政案内でない旨を常時表示する
- [ ] データ更新手順と受入テストが存在する

### UX / 品質

- [ ] mobile / desktopで崩れない
- [ ] keyboard操作と`aria-live`が機能する
- [ ] 色だけに依存しない
- [ ] low confidenceを正解として強調しない
- [ ] Preview環境で実機スモークテストを完了する

### ドキュメント

- [ ] READMEのローカル実行手順が実装と一致する
- [ ] env一覧と秘密管理が更新されている
- [ ] JEV_DESIGNの実機確認結果が更新されている
- [ ] CITY_DATAの取得日、施行日、差分が更新されている

## 6. 実装開始前に確認する重要な選択肢

### A. フレームワーク

**推奨:** SvelteKit。

1画面の小型アプリ、server route、Vercel deployを最短に保てる。React資産を前提にする場合のみNext.jsへ切り替える。

### B. Jev呼び出し

**推奨:** TypeSafe公式JavaScript SDK。

typed question / answer、retry、timeout、例外型が利用できる。直fetchはSDKで解決できない障害調査や契約テストのための代替手段とする。

### C. モデル指定

**推奨:** 公開デモは `jev-latest`、回帰テストは `jev-1.13.0`。

latestの速度と更新を体験できる一方、回答が変わり得るため、レスポンスのmodelを必ず記録する。完全な再現性を優先する場合は、デモもversioned IDに固定する。

### D. CITYデータ範囲

**推奨:** 公式組織ページに載る市民向け窓口を全体カタログとして持ち、MVPの結果カードは主要カテゴリから始める。

全課を候補に含めることで「架空の自治体組織」を避けられる。教育委員会や消防本部などの詳細な個別分掌は、初回MVPの主要問い合わせカテゴリ外なら候補と注意表示に留め、後続で拡張する。

## 7. 実装後の運用タスク

- 月次: Jevのmodel、料金、rate limit、SDK changelogを確認
- 四半期: CITYの組織ページと例規集の施行日を確認
- リリースごと: question snapshotと受入テストの再実行
- 障害時: requestId、status、model、latency、usageのみで原因を追跡
- 誤判定報告時: 入力本文を自動収集せず、利用者の同意がある場合だけ手動で再現用fixtureを作る
