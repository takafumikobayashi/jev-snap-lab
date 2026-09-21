# Implementation Plan

## 1. 前提

この文書は、設計完了後に `この設計どおりMVPを実装してください` と指示された場合の作業順を定義する。今回の作業ではアプリケーションコードを作成しない。

推奨ベースライン:

- SvelteKit + TypeScript + Tailwind CSS
- Node.js 22.12以上 / pnpm（開発環境の npm 10.9.3 でこの構成の依存をインストールできなかったため。詳細は README を参照）
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
- `@typesafe-ai/sdk`の現行インストールとNode.js runtimeを確認
- JavaScript SDKのretry既定値の**実測確認**（既定値は [JEV_DESIGN.md](JEV_DESIGN.md) §9 に記載済み）。通常時に1試行3,500ms×3試行が12,000msに収まることと、`Retry-After` で待機が伸びた場合にtotal timeoutが待機ごと中断することの両方を確認する
- Vercelの契約プランにおける関数 `maxDuration` の既定値と上限を確認する（設定先は `vite.config.ts` のアダプタ設定とルートの `export const config`。`vercel.json` の `functions` グロブは adapter-vercel では効かない）
- `jev-latest`と`jev-1.13.0`の応答shapeを確認
- 日本語のLOVE / SOCIAL / CITY入力で質問群を試行
- M市の公式組織ページと令和8年4月1日施行の事務組織規則の差分を再確認
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
- `request_category` の候補をデータセットの `categories` から生成（二重定義しない）
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
- [x] e2e: 入力→送信→結果、エラー→再試行、モード切替
- [x] e2e: モックAPIでCSP違反がコンソールに出ないことを自動検証する（Phase 3 では手動確認にとどめた）
- [x] e2e: 判定中のモード切替と入力編集で、古い結果が表示されないことを確認する
- [x] e2e: バーの幅と色が実際に適用されること（テキストだけの検証では本番の描画崩れを見逃す）
- [x] CI: typecheck / lint / unit / ドキュメント参照 / 秘密情報 / build / バンドル検査 / e2e
- [x] `rate-limit.server.ts` を実装する（送信元単位のbest-effort in-memory token bucket、既定 10 requests/minute。[ARCHITECTURE.md](ARCHITECTURE.md) の §9）
- [x] secret scanとclient bundle確認（`pnpm check:secrets` とCIのバンドル検査、E2Eのバンドル検査）
- CSPヘッダーが実際に付与され、違反なくページが動作することを確認
- request本文がログに出ないことを確認
- [x] p50 / p95 latencyとupstream errorのログを確認（[ARCHITECTURE.md](ARCHITECTURE.md) の §12。項目の存在をテストで固定）

完了条件:

- CIでtypecheck、lint、unit、contractが通る。
- Preview環境で実機の1往復を完了する。
- 重要なセキュリティ受入条件が満たされる。

### Phase 6: Preview / Production

依存: Phase 5

タスク:

手順とチェックリストは [DEPLOY.md](DEPLOY.md) にまとめた。

- Vercel Previewへデプロイ（`develop` への push で自動）
- envをPreview / Productionに分離
- APIキー、モデル、timeoutを確認
- 低コストのスモークテストを実施（`pnpm check:deployment <url>`。`--smoke` で判定を1回だけ実行）
- Productionへデプロイ（`main` へ merge）
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

各項目は自動テストか実測で確認している。根拠は §5.1 にまとめた。残るのは Preview 環境での実機スモークテストだけで、これはデプロイ後にしか実施できない。


### 機能

- [x] 3モードを1画面で切り替えられる
- [x] 最大280 Unicode code pointsをclient/server両方で検証する
- [x] 1回のJev呼び出しで複数質問を返す
- [x] Choice / Score / Noulをそれぞれ正しく表示する
- [x] LOVE、SOCIAL、CITYの質問IDと表示ラベルが設計と一致する
- [x] CITYの候補に公式根拠データがjoinされる
- [x] `route_to` が課レベルで、係はローカルjoinで解決される
- [x] カテゴリ一覧がデータセットのみに定義されている

### Jev

- [x] APIキーはserver-only
- [x] 実レスポンスのmodelとusageを扱える
- [x] latencyを計測して表示できる
- [x] `probabilities`、`confidence`、`noul`を混同しない
- [x] 401 / 422 / 429 / 529 / timeout / network failureを処理する
- [x] retryに上限があり、AbortSignalによる総時間上限が効いている（保留中のretry待機も中断される）
- [x] Vercelの `maxDuration` が総予算より大きく設定され、`.vercel/output/**/.vc-config.json` に反映されている
- [x] type別の `criteria` の形を守り、送信前に検証している
- [x] Scoreの表示ラベルを `Math.round(score)` で引いていない

### セキュリティ・プライバシー

- [x] 入力本文を永続保存しない
- [x] 入力本文を本番ログへ出さない
- [x] `dangerouslyAllowBrowser`を使わない
- [x] `{@html}`を使わずXSSを防ぐ
- [x] responseにAPIキー、生レスポンス、内部stack traceを含めない
- [x] `Cache-Control: no-store`を設定する
- [x] Content Security Policyを設定し、CSP違反なくページが動作する
- [x] アプリ側のレート制限が有効で、超過時に 429 `RATE_LIMITED` を返す

### CITY

- [x] 部 / 課 / 係 / 分掌 / 市民向け説明 / 根拠URL / 取得日 / 有効日がデータ化されている
- [x] 公式組織ページと事務組織規則の出典を分けて保持する
- [x] 係未確認を推測で埋めていない
- [x] external operatorを市課と区別する
- [x] 正式な行政案内でない旨を常時表示する
- [x] データ更新手順と受入テストが存在する

### UX / 品質

- [x] mobile / desktopで崩れない
- [x] keyboard操作と`aria-live`が機能する
- [x] 色だけに依存しない
- [x] low confidenceを正解として強調しない
- [ ] Preview環境で実機スモークテストを完了する

### ドキュメント

- [x] READMEのローカル実行手順が実装と一致する
- [x] env一覧と秘密管理が更新されている
- [x] JEV_DESIGNの実機確認結果が更新されている
- [x] CITY_DATAの取得日、施行日、差分が更新されている

### 5.1 検証の根拠

| 項目 | 根拠 |
|---|---|
| 3モード切替、280 code points、複数質問、Choice/Score/Noul表示 | E2E（C-01 / C-03 / C-04、3種類の描き分け、バーの実描画） |
| 質問IDとラベルが設計と一致 | `question-catalog.spec.ts` のID集合固定 |
| CITYの根拠join、課レベルの`route_to`、カテゴリの単一定義 | `city-directory.spec.ts` |
| APIキーがserver-only | E2Eのバンドル検査、CIの静的出力検査 |
| model / usage / latency | 実機での3モード疎通（Phase 2）、E2Eの表示確認 |
| probabilities / confidence / noul の非混同 | `display.spec.ts`、UIで別カード・別表示 |
| 401 / 422 / 429 / 529 / timeout / network | `jev-config.spec.ts` の `mapSdkError` |
| retry上限とAbortSignalの総時間上限 | `jev-client.spec.ts`（signalの受け渡しとabortの発火） |
| `maxDuration` の反映 | `.vercel/output/**/.vc-config.json` を実測（全7関数で20秒） |
| 送信前のcriteria検証 | `question-validation.spec.ts` |
| `Math.round(score)` を使わない | `display.spec.ts` の二峰分布 |
| 入力を永続保存しない | `localStorage` / `sessionStorage` / `cookie` / `indexedDB` の不使用をgrepで確認 |
| 入力本文をログへ出さない | `server.spec.ts`、dev実機のログ確認 |
| `dangerouslyAllowBrowser` 不使用、`{@html}` 不使用 | grep（前者はコメント内の言及のみ） |
| レスポンスに内部情報を含めない | `server.spec.ts` |
| `Cache-Control: no-store` ほかのヘッダー | E2E |
| CSP | E2E（違反0件、ヘッダー内容、バーの実描画） |
| レート制限 | `rate-limit.spec.ts`、`server.spec.ts`、dev実機で12回連打 |
| CITYデータの構造と出典 | `city-directory.spec.ts`、`city-validation.spec.ts` |
| 行政案内でない旨の常時表示 | E2E（モードごとの注意文の出し分け） |
| mobile / desktop で崩れない | E2E（375px で横スクロールなし・1列、1280px で2列） |
| keyboard と `aria-live` | E2E（矢印キーでのタブ移動、`aria-live` 領域への結果反映、`aria-busy`） |
| 色だけに依存しない | `CardHeader` が種類を文字でも示す。パレットは検証スクリプトで実測 |
| low confidence を強調しない | E2E（「判断が割れています」の表示） |
| ドキュメントの整合 | `pnpm check:docs`（リンクとパス参照の実在） |

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

### E. 次期Semantic拡張の範囲

**推奨:** CITYは現行の課レベルChoiceを既定のまま残し、Semantic Fitは上位1課（必要時のみ2課）×代表分掌12件以内の限定実験にする。SPEC FINDはデジタル庁の共通機能標準仕様書第2.7版の公式PDFを20〜40件程度のbounded passageへ正規化し、1回のJev requestで評価する。

機能要件Excel、項目定義書、API仕様書、ランタイムのWeb取得はSPEC FIND v0に含めない。Excelは後続で別データセットとして、セル・行locator、機能ID、版差分、PDFとの重複を設計してから追加する。

Semantic Fit / SPEC FINDの設計根拠は [CITY_SEMANTIC_EXPERIMENT.md](CITY_SEMANTIC_EXPERIMENT.md) と [SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) に分離する。どちらも本MVPのDefinition of Doneへ遡って追加しない。

## 7. 実装後の運用タスク

- 月次: Jevのmodel、料金、rate limit、SDK changelogを確認
- 四半期: CITYの組織ページと例規集の施行日を確認
- リリースごと: question snapshotと受入テストの再実行
- 障害時: requestId、status、model、latency、usageのみで原因を追跡
- 誤判定報告時: 入力本文を自動収集せず、利用者の同意がある場合だけ手動で再現用fixtureを作る

## 8. Semantic 拡張の実装計画（完了）

Phase 6.5 から Phase 10 まで完了している。いずれもLOVE / SOCIAL / CITYの既定経路を変更していない。

| Phase | 内容 | 結果 |
|---|---|---|
| 6.5 | Jevの前提を実測 | 40件まで1リクエストで成立。**候補はキー参照**（§8.1） |
| 7 | 共通Semantic Matchのfixture | 完了 |
| 8 | SPEC FIND PDF v0 | 完了。Recall@3 100% |
| 9 | CITY Semantic Fit のshadow | 完了。本番では無効のまま |
| 10 | 実機評価と採否 | SPEC FIND は採用、CITY は据え置き |

### 8.0 合意事項

着手前に固定する。ここを動かす場合は、この節を先に更新する。

| 項目 | 決定 |
|---|---|
| CITYの既定経路 | 現行の課レベルChoiceを維持する。Semantic Fitはshadowから始める |
| CITY Semantic Fitの候補 | 上位1課（必要時のみ2課）× 代表分掌12件以内 |
| SPEC FINDのソース | デジタル庁 共通機能標準仕様書 第2.7版（2026-02-27公開）のPDFのみ |
| SPEC FINDのコーパス | 固定passage 20〜40件程度を1リクエストで評価する（実測で成立、§8.1）。ランタイムのWeb取得はしない |
| 後回しにするもの | 機能要件Excel、項目定義書、API仕様書、ランタイム取得 |
| 出典の扱い | digital.go.jpは**PDL 1.0（公共データ利用規約 第1.0版）**。出典表示と加工表示を必須とする（[SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) §2） |
| 候補IDの復元 | 質問IDから候補IDを**文字列変換で復元しない**。連番の質問IDとサーバー側の対応表で引く |
| 質問とstateの結び付き | 1リクエストの全質問は同じstateを見る。候補を**オブジェクト**としてstateへ置き、instructionsからキーのパス（`` `responsibilities.r12.text` ``）で対象を指す。配列インデックス参照は使わない（§8.1） |
| Semantic Match Engineの境界 | `候補集合 -> Map<候補ID, probability>`。上流を何回呼ぶかはengineの内側の実装詳細にする |

公式ドキュメントに1リクエストあたりの質問数上限の記載は無く、rerank cookbookは1ペア1コールで書かれている。そのためPhase 6.5で実測した。結果は下記のとおりで、**40件までは1リクエストで成立する**。ただし成立には次の条件が要る。

| 条件 | 内容 |
|---|---|
| **候補はオブジェクトのキーで参照する** | `responsibilities.r12.text`。**配列インデックス（`responsibilities[12].text`）は使わない** |

配列インデックス参照は、候補が20件を超えたあたりから確率が隣接インデックスへ滲み、無関係な候補が最上位に来る。実測で確認した（§8.1）。

### Phase 6.5: Jevの前提を実測する（スパイク）— 完了

- [x] 判定基準を測る前に決めた（成立とみなす件数24、Stage 2単体のp95 3000ms）
- [x] N = 5 / 12 / 24 / 40 で実測した
- [x] 参照の書き方（配列index / オブジェクトkey）を比較した
- [x] 分割呼び出し（1候補1リクエスト）の代替コストを測った
- [x] 結果を [CITY_SEMANTIC_EXPERIMENT.md](CITY_SEMANTIC_EXPERIMENT.md) と [SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) へ反映した

### 8.1 Phase 6.5 の実測結果

測定日 2026-09-21、model `jev-1.13.0`（`jev-latest`）。入力は架空データセットの分掌事務、質問は「住民文がこの分掌に意味的に含まれるか」のNoul。正解の分掌を既知の位置へ置き、**それが最上位に来るか**まで確認した。200が返ることは、参照が効いた証明にならない。

**1. 件数と所要時間**

| 候補数 | 成功 | latency 中央値 / 最大 | 入力token | answer欠落 |
|---|---|---|---|---|
| 5 | 3/3 | 529 / 540 ms | 1,095 | 0 |
| 12 | 3/3 | 227 / 229 ms | 2,281 | 0 |
| 24 | 3/3 | 216 / 251 ms | 4,167 | 0 |
| 40 | 3/3 | 245 / 266 ms | 6,765 | 0 |

40件まで422もtoken上限も出ない。質問を増やしてもlatencyはほぼ変わらず、公式ドキュメントの「質問は並列に評価される」と一致する。判定基準の3000msに対して十分な余裕がある。候補1件あたりの入力tokenは約165で、40件でも$0.0003程度。

**2. 参照の書き方が結果を左右する**

配列インデックス参照では、候補が増えると確率が隣接インデックスへ滲む。正解の**位置だけ**を変えて比べると差が出る（N=40、他の条件は同じ）。

| 正解の位置 | 上位3件 | 1位 |
|---|---|---|
| 3 | 0.95 / 0.48 / 0.32 | 正解 |
| 12 | 0.94 / 0.65 / 0.51 | 正解 |
| 20 | 0.95 / 0.89 / 0.85 | 正解（隣接が浮く） |
| 33 | 0.95 / 0.94 / 0.94 | **別候補**（「市税等の滞納処分及び強制執行に関すること」） |

滞納処分は予防接種と無関係なので、候補の似すぎではなく**参照の取り違え**である。コーパスが同じで位置だけ違うのに分布が変わることが、その裏付けになる。

オブジェクトのキー参照（`responsibilities.r33.text`）へ変えると、同じN=40で分離が戻る。

| 参照 | 2位との差 | 0.9以上の件数 | 1位 |
|---|---|---|---|
| 配列index | 0.00〜0.01 | 5〜7件 | 2回中1回外す |
| **キー参照** | **0.77〜0.78** | **1件** | **2回とも正解** |

位置を0 / 7 / 19 / 26 / 33 / 39 と振っても、キー参照は**6/6で正解が1位**、2位との差0.77〜0.81、0.9以上は常に1件だけだった。

**3. 分割呼び出しは明確に不利**

候補12件を1件ずつ12回に分けると、1回にまとめた場合と比べて**latencyが22倍、入力tokenが2.5倍**になる（stateを毎回送り直すため）。

| 方式 | latency | 入力token |
|---|---|---|
| 1リクエストに12問 | 227 ms | 2,281 |
| 12リクエストに1問ずつ | 5,008 ms | 5,808 |

**4. トークン予算のどこにいるか**

Jevの制限は **`state` と最長の質問で 32k tokens**、リクエスト全体で 64k tokens である（[models](https://docs.typesafe.ai/models)）。効いてくるのは前者で、質問は1問あたり113 tokensしか増えないのに対し、stateは候補の文字数に比例する。

配布コーパス（39件・15,612字）での実測:

| 測った値 | 結果 |
|---|---|
| state + 質問1問 | 16,868 tokens（32k の **51%**） |
| 文字あたりの state token | 1.080 |
| 質問1問あたりの増分 | 113 tokens |
| リクエスト全体（39問） | 20,927 tokens（64k の 33%） |

件数40件・1件600字の上限をすべて使うと約25,700字になり、state だけで32kの約85%に達する。件数と1件あたりの上限だけでは総量が決まらないため、**コーパス全体の文字数上限（20,000字）**も検証する。この値なら state + 質問1問が約66%に収まる。上げるときは先にトークンとレイテンシを測り直す（[spec-budget.live.spec.ts](../src/lib/server/spec-budget.live.spec.ts)）。

**5. abstainは成立する**

対象外の入力（「株式の売買手数料の相場を知りたい」）をN=40へ与えると、0.9以上の候補は0件、正解位置の確率も0.01だった。閾値による足切りが機能する。

**測定の限界**: クエリ1本、データセット1つ、セルあたり2〜3回。「40件は成立する」「配列indexは使えない」を判断するには足りるが、境界の正確な位置（何件から滲み始めるか）は詰めていない。モデル更新で変わりうるため、`model` を記録した数字として扱う。

### Phase 7: 共通Semantic Matchのfixture — 完了

- [x] `SpecDocument` / `SpecPassage` とCITY `responsibilityId` の安定ID設計を確定する
- [x] passageの重複、文字数、版、取得日、hash、source URLを検証する
- [x] Noul question builderをfixtureだけで実装する
- [x] Choiceの比較分布とNoulの独立 `yesProbability` を別型で保持する
- [x] アプリ側の順位付け、top-k、abstain、source joinを実装する
- [x] Engineの境界を `候補集合 -> Map<候補ID, probability>` にし、上流の呼び出し回数を内側へ隠す
- [x] 質問IDは連番にし、候補IDとの対応表をサーバー側に持つ（文字列変換で復元しない）
- [x] Jevのmock responseでanswer欠落、未知ID、確率範囲外を検証する

完了条件:

- [x] 自由生成なしで候補IDから結果を再現できる
- [x] 出典joinに失敗した候補を公式根拠付きで表示しない
- [x] 既存LOVE / SOCIAL / CITYの型・APIレスポンスに影響しない（追加のみ、既存ファイルの変更なし）
- [x] 上流を1回呼ぶか複数回呼ぶかを変えても、順位付け以降の層を書き換えずに済む

追加したファイル:

| ファイル | 役割 |
|---|---|
| `src/lib/types/semantic.ts` | 候補、スコア、順位付けの共通型 |
| `src/lib/types/spec.ts` | `SpecDocument` / `SpecPassage` / `SpecCorpus` |
| `src/lib/server/semantic-match.server.ts` | 評価エンジン。リクエスト組み立て、契約検証、順位付け、abstain |
| `src/lib/server/semantic-policies.server.ts` | CITY / SPEC の質問文と閾値 |
| `src/lib/server/spec-corpus.server.ts` | コーパス検証と PDL 1.0 の出典表示 |
| `src/lib/server/spec-evidence.server.ts` | 候補IDから出典への join |

### Phase 8: SPEC FIND PDF v0

依存: Phase 6.5、Phase 7。CITYより先に行う。SPEC FINDは新モードの追加だけで、先日作り直したばかりの `city.candidates[]` の型とE2Eに触れない。上流呼び出しも1回なので、CITY固有のrequest-level deadlineの宿題を後ろへ回せる。

- [x] デジタル庁公式の共通機能標準仕様書第2.7版を固定する
- [x] 20〜40件程度の代表passageをオフライン抽出し、`data`配下のspec用ディレクトリへ追加する（39件）
- [x] `maxPassages` / `maxChars`を超えないデータ検査を追加する
- [x] 1回のbounded Jev requestでpassageごとの独立Noulを評価する
- [x] top-3、abstain、章節・ページ・公式PDFリンクを表示する
- [x] SPEC FINDをserver-side feature flagの既定無効で追加する（`SPEC_FIND_ENABLED`）
- [x] Excel、項目定義書、API仕様書を混入させない検査を追加する
- [x] gold caseでRecall@1 / Recall@3、source join、p95 latency、tokens、コストを測る（Recall@1 93% / Recall@3 100%、[SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) §8）

完了条件:

- [x] 入力、候補、版、source locatorの対応がfixtureで再現できる
- [x] 十分に近い候補がない場合に、無理な回答を出さずabstainできる
- [x] 仕様適合、実装可否、行政・法的判断と誤認させない注意文が常時表示される
- [x] 公式サイトへランタイムアクセスせず、固定データセットの版が結果へ残る
- [x] 既存3モードのE2EとMVP Definition of Doneが変わらない

### Phase 9: CITY Semantic Fitのshadow実験（任意）

依存: Phase 6.5、Phase 7、Phase 8の実機評価、CITYの現行受入テスト。SPEC FINDで共通処理の有効性を確かめてから着手する。

- [x] `CITY_SEMANTIC_EXPERIMENT=false` を既定にする
- [x] 現行 `route_to` 上位1課から代表分掌を最大12件選ぶ
- [x] 追加Jev呼び出しを最大1回に制限する
- [x] 既存結果を返せるrequest-level deadlineとfallbackを実装する（`REQUEST_BUDGET_MS = 16,000`）
- [x] base / semanticのlatency、tokens、推計コスト、hit@k、abstainを入力本文なしで記録する
- [x] 直接語彙、言い換え、課境界、対象外、情報不足のFit / Gapケースを比較する（[CITY_SEMANTIC_EXPERIMENT.md](CITY_SEMANTIC_EXPERIMENT.md) §7.2）

完了条件:

- [x] Semantic Fit失敗時も現行CITY結果が返る
- [x] 追加分がVercel `maxDuration`とコスト上限に収まる（合計約1,350ms、入力token約10,700）
- [x] 根拠表示は既存の静的データjoinであり、Jev生成文を出典としていない
- [x] 既定UIへ昇格するか、shadowのままにするかを評価記録へ残す（**本番は無効のまま据え置き**。[CITY_SEMANTIC_EXPERIMENT.md](CITY_SEMANTIC_EXPERIMENT.md) §7.3）

### Phase 10: 実機評価と採否

依存: Phase 8またはPhase 9の該当機能。SPEC FIND（Phase 8）の評価を先に行う。

- [ ] `jev-latest`で日本語gold caseを実機評価する
- [ ] versioned modelで再現性を確認する
- [ ] p50 / p95、input token、推計コスト、429 / 529 / timeoutを比較する
- [ ] 閾値を固定値として移植せず、採用した値と校正根拠を記録する
- [x] 採用、shadow継続、撤回のいずれかを決定する
  - SPEC FIND: **採用**。本番で有効にする（[SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) §8.1）
  - CITY Semantic Fit: **据え置き**。本番では無効のまま（[CITY_SEMANTIC_EXPERIMENT.md](CITY_SEMANTIC_EXPERIMENT.md) §7.3）

### 次期拡張のDefinition of Done

- [ ] CITY既定経路の候補・根拠・匿名化方針を壊さない
- [ ] SPEC FINDはPDF v2.7の固定コーパスだけを使い、Excelを参照しない
- [ ] リクエストへ渡す候補数・文字数に上限がある
- [ ] Noulの適合度とChoiceの分布をUI・型・ログで混同しない
- [ ] 順位、閾値、abstainがアプリ側で決定される
- [ ] source locator、版、取得日、hashが再現可能である
- [ ] Jev障害時にCITYはfallback、SPEC FINDは再試行または空振り表示となる
- [ ] 実機測定で遅延・コスト・精度のトレードオフを確認している

## 9. 次期拡張: BATCH JUDGE と SPEC FIND v1

Jevの使い方が逆になる2つを同じLabで測り、**どの問題構造でSystem One Modelが効くのか**を比較できる状態にする。

```text
SPEC FIND    少数のQuery  × 多くのKnowledge
BATCH JUDGE  多数のInput  × 少数の判断基準
```

BATCH JUDGE は新規モード、SPEC FIND v1 は既存モードの拡張。設計は [BATCH_JUDGE_DESIGN.md](BATCH_JUDGE_DESIGN.md) と [SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) §10 にある。

進捗は次のとおり。**一括で「着手前」とは言えない状態にある。**

| | 状態 |
|---|---|
| BATCH JUDGE | Phase 11（schema・fixture）と Phase 12（方式の実測）が完了。**Jev呼び出しの経路とUIは未実装** |
| SPEC FIND v1 | 着手前 |

### 9.0 合意事項

| 項目 | 決定 |
|---|---|
| 既存モード | LOVE / SOCIAL / CITY / SPEC FIND の既定経路を変更しない |
| feature flag | BATCH JUDGE も既定無効から始める。明示的な `true` だけを有効とする |
| 参照の書き方 | 候補も事例も**オブジェクトのキー**で参照する。配列インデックスは使わない（§8.1） |
| 分割 | 最初からchunkしない。分割はlatency 22倍・入力token 2.5倍になる（§8.1） |
| 計測 | 既存の `estimateCostUsd` と `JudgeResponse.usage` を再利用する。新しい仕組みを作らない |
| 表示する数値 | すべて実測値にする。設計段階で置いた見本の数字を画面へ出さない |
| Excelの名称 | 出典表示は公式ページの表記「機能要件（第2.7版）」に合わせる。PDF本文の「別紙1_機能要件」は使わない |
| 機能ID | ExcelのF列（7桁）をそのまま使う。**内部IDを新しく作らない**。PDFの業務フローと同じ体系 |

**合意事項ではないもの（実測で決める）**

- ~~1リクエストへ入れられる「件数 × 軸数」~~ Phase 12 で実測した。750問まで成立し、1,000問で400
- Layer 2 の絞り込みをどの階層まで行うか。機能領域だけでは統合収納管理（419件）が32k制限を超える
- SPEC FIND v1 を二段階にするか、決定的な絞り込みで1リクエストに収めるか

### Phase 11: BATCH JUDGE のschemaとfixture

依存: なし。Jevを呼ばない。**完了。**

- [x] 3テーマ（PRIVACY / DEADLINE / DX JUDGE）の判断軸を確定する
- [x] 各テーマ30〜50件のfixtureを作る。曖昧なケースを意図的に入れる（各50件）。PRIVACYは**貼り付けられる文章そのもの**の形にした
- [x] 正解ラベルを1件ずつ判断して付ける。**Jev自身の出力をgoldにしない**
- [ ] **人が全件を確認する。** 現状は `labelStatus: 'draft'`（Claude起草・人手確認前）
- [x] 共通の計測項目を既存実装から再利用できる形にする（`estimateCostUsd`、`result.usage`）

成果物: `src/lib/types/batch.ts`、`data/batch/{privacy,deadline,dx}.json`、`src/lib/server/batch-dataset.server.ts`

**残件:** ラベルはClaudeが起草した下書きである。DX は利用者が目視で確認済みだが、その後5軸から3択へ作り直したため再確認が要る。PRIVACY と DEADLINE は未確認。Phase 13 の前に人が通しで確認する（[BATCH_JUDGE_DESIGN.md](BATCH_JUDGE_DESIGN.md) §5）。

### Phase 12: BATCH JUDGE のbenchmark（実測）

依存: Phase 11。捨てコードでよい。**完了。** 結果は [BATCH_JUDGE_DESIGN.md](BATCH_JUDGE_DESIGN.md) §4.6。

- [x] 判定基準を**測る前に**決める（16,000ms以内 / answer欠落0 / 並び替えの差0.10以内）
- [x] 「件数 × 軸数」で測る。50×1 と 50×5 を別物として扱う
- [x] Pattern A（1リクエスト）/ B（chunk）/ C（別構造）を比較する
- [x] **probabilityの混線**を確認する。並び順だけを変え、同じ並びのゆらぎと比べる
- [x] answerの欠落、latency、tokens、コストを記録する
- [x] 結果を [BATCH_JUDGE_DESIGN.md](BATCH_JUDGE_DESIGN.md) へ反映する

完了条件:

- [x] 各テーマで成立する最大の件数を実測値として決めた（**質問数ではなくtokenが壁**。約65,000 tokens）
- [x] 参照方式を確認した。**配列インデックスによる大規模な混線は解消したが、並び順依存は残っている**
- [ ] **事前に決めた「並び替えによる確率差0.10以内」は未達。** 素の並び順では12〜18/150が超え、最大0.320〜0.430。本番は `canonicalOrder`（本文のハッシュ順）で入力順の影響を消したが、上流のゆらぎで判定は0〜1/50が変わる。並び順依存そのものは残る
- [ ] UIへ出す数値の桁が実測と合っている（Phase 13 でUIを作るときに確認する）

**実測で分かった主なこと**

- 壁は質問数ではなくtoken側にある。短い質問なら750問通り、長い質問は600問で400になる
- latencyは質問数にほぼ比例しない（50問421ms、150問981ms、750問2,309ms）
- 分割の追加コストは入力tokenで2〜8%。SPEC FINDの2.5倍とは違い、stateが小さいため

- **事例は内容のハッシュ順でstateへ入れる。** 利用者が貼った順で送ると、同じ50件でも並べ替えただけで結果が変わる
- **排他的なカテゴリは Choice。** DEADLINE 94%、DX 78〜82%。独立Noulへ展開すると落ちる
- **同じ入力に同じ答えは返らない。** 同じリクエストを2回投げると判定が0〜1/50変わる
- **DEADLINE は基準日を state で与える。** 「9月25日17時まで」は基準日なしにgoldが決まらない。基準日を動かすと判定が動くことを実測で確認した
- **DXは5つの独立Noulをやめて3択にした。** 軸が独立しておらず、gold真と偽の平均差が0.06〜0.20しかなかった
- **PRIVACYは3軸の最大値で二値化しない。** `sensitive` が話題の語に反応する。`identifies` または `personal` で98%（見逃し0、過検知1）
- 分離の悪い軸を閾値で切らない。DXの5軸版は同じ並びで2回投げるだけで4.4%が反転していた

### Phase 13: BATCH JUDGE の実装

依存: Phase 12。**完了。**

- [x] feature flagの既定無効で追加する（`BATCH_JUDGE_ENABLED`）
- [x] **質問定義は [batch-questions.server.ts](../src/lib/server/batch-questions.server.ts) から使う。書き写さない**
- [x] 一括評価。**gold との一致は画面に出さない**（§6）。評価は benchmark の仕事
- [x] latency / tokens / cost を表示する。1件あたりの時間は参考値である旨を注記する
- [x] 画面に精度を出さない。benchmark で「暫定ラベルとの一致率」として扱う
- [x] PRIVACYは断定しない。**ラベルの文言で担い、説明の段落は画面へ置かない**（§3.1）
- [x] **PRIVACYの結論に「安全」と書かない。** `要確認シグナルなし` / `要確認` の二値（型とテストで固定）
- [x] **入力欄の手前に**、入力文がTypeSafe AIへ送信されることを出す
- [x] デモ用の例文だけで動きを確認できる

成果物: `src/lib/server/batch-judge.server.ts`、`src/routes/api/batch/+server.ts`、`src/routes/batch/`、`src/lib/client/batch-api.ts`、`src/lib/batch-display.ts`、`src/lib/components/BatchRow.svelte`

完了条件:

- [x] 既存4モードのE2Eとテストが変わらない（既存42件はそのまま、BATCH JUDGE で9件追加して51件）
- [x] 表示する数値がすべて実測値である（§4.8）

**入力を受け付けない判断.** 「AIにそのまま入れてよい？」を判定するモードが、判定のために利用者の文章をAIへ送る。実際の個人情報を貼られると、判定より先に送信が起きる。見せ場は「数十件を一度に」であり、利用者が50件を打ち込む使い方も現実的でない。入力を足すなら、注意文とデモ用例文、検証（`batch-input.ts`）を一緒に設計し直す。

**残件:** goldラベルの人手確認（Phase 11 の残件）。benchmark の一致率は暫定ラベルに対する値のままである。画面には出さない。

### Phase 14: SPEC FIND の gold dataset と Source Gap の確認

依存: なし。**Excelの取り込みより先に行う。**

- [ ] 現実的な質問を20件以上作り、`expectedSource` を人手で付ける
- [ ] Retrieval Gap / Corpus Gap / Source Gap を区別して集計する
- [ ] Source Gapの割合から、Layer 2 が要るか、どの機能領域が効くかを判断する

完了条件:

- [ ] 3種類のGapを数えられる
- [ ] Layer 2 へ進むかどうかを数字で判断した

### Phase 15: 機能要件Excelの取り込み（Phase 14の結果次第）

依存: Phase 14。

- [ ] `common_05.xlsx`（第2.7版・274KB）から761件を正規化する
- [ ] **ルビを除去する。** `<si>` から `<rPh>` を除く。大項目748件・機能名称451件・要件文242件に混入している
- [ ] 機能IDをそのまま使う。内部IDを作らない
- [ ] PDF corpusへ混ぜず、独立datasetとして扱う
- [ ] 入力Excelが固定した出典と同じかを照合してから生成する（PDFと同じ方針）

### Phase 16: SPEC FIND v1 の検索方式をbenchmark

依存: Phase 15。

- [ ] 1リクエストへ入れられる要件数を 40 / 86 / 231 の3点で測り、崩れる場所を確認する
- [ ] 絞り込みの階層（機能領域だけ / 中項目まで / さらに下）を比較する
- [ ] A（2リクエスト）/ B（決定的な絞り込み + 1リクエスト）/ C を比較する
- [ ] 最も良い方式を実測で選び、docsへ残す

### Phase 17: SPEC FIND v1 の統合とドキュメント更新

依存: Phase 16。

- [ ] main spec / functional requirements / out-of-scope を区別して表示する
- [ ] Source Sufficiency の表示を追加する
- [ ] 公式のsource・version・locatorを失わない
- [ ] README / PRODUCT_SPEC / JEV_DESIGN / SPEC_FIND_DESIGN / ARCHITECTURE を実態へ合わせる

### 次期拡張のDefinition of Done（BATCH JUDGE / SPEC FIND v1）

- [ ] 既存4モードの既定経路とE2Eが変わらない
- [ ] BATCH JUDGE の3テーマが動き、人手goldとの一致を確認できる
- [ ] SPEC FIND が main spec と functional requirements を区別できる
- [ ] **Source Gap を retrieval failure として扱っていない**
- [ ] 検索方式・件数の上限を実測で選んでいる
- [ ] 公式のsource・version・locator・出典表示を失っていない
- [ ] 画面に出る数値がすべて実測値である
- [ ] Jevに法的・行政的・仕様適合性の判断をさせていない
