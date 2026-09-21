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

## 8. 次期拡張の実装計画（未着手）

この節はMVP完了後に着手する候補であり、現在の3モードの既定経路を変更する作業ではない。新機能の設計が確定しても、実装前に実機でtoken・latency・コストを測る。

### 8.0 合意事項

着手前に固定する。ここを動かす場合は、この節を先に更新する。

| 項目 | 決定 |
|---|---|
| CITYの既定経路 | 現行の課レベルChoiceを維持する。Semantic Fitはshadowから始める |
| CITY Semantic Fitの候補 | 上位1課（必要時のみ2課）× 代表分掌12件以内 |
| SPEC FINDのソース | デジタル庁 共通機能標準仕様書 第2.7版（2026-02-27公開）のPDFのみ |
| SPEC FINDのコーパス | 固定passage 20〜40件程度。ランタイムのWeb取得はしない |
| 後回しにするもの | 機能要件Excel、項目定義書、API仕様書、ランタイム取得 |
| 出典の扱い | digital.go.jpは**PDL 1.0（公共データ利用規約 第1.0版）**。出典表示と加工表示を必須とする（[SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) §2） |
| 候補IDの復元 | 質問IDから候補IDを**文字列変換で復元しない**。連番の質問IDとサーバー側の対応表で引く |
| 質問とstateの結び付き | 1リクエストの全質問は同じstateを見る。候補配列をstateへ置き、instructionsからバックティックのパスで対象を指す |
| Semantic Match Engineの境界 | `候補集合 -> Map<候補ID, probability>`。上流を何回呼ぶかはengineの内側の実装詳細にする |

**合意事項ではないもの（検証対象の仮説）**

「N件の独立Noulを1回のリクエストで評価できる」ことは、TypeSafeの公式ドキュメントで裏が取れていない。

- 1リクエストあたりの質問数上限は文書化されていない
- rerank cookbookは1ペア1コール（40クエリ×30候補で1,200コール）で、「明快さのために1ペア1質問にした」と明記している
- fan-outパターンは「**同じ文書**に複数の質問」であり、配列要素ごとに質問を割り当てる例は無い

Phase 6.5で実測し、結果が出るまで「1回のリクエスト」を前提として固定しない。上の「Engineの境界」を守っておけば、仮説が外れても順位付け・abstain・source joinの層は影響を受けない。

### Phase 6.5: Jevの前提を実測する（スパイク）

依存: Phase 5。捨てコードでよい。ここで得た数字だけを次フェーズの前提にする。

- [ ] 判定基準を**測る前に**決める（成立とみなす質問数、許容するp95 latency、1リクエストあたりの入力token上限）
- [ ] stateへ候補配列を置き、instructionsからバックティックのパスで対象を指す最小の質問セットを作る
- [ ] N = 5 / 12 / 24 / 40 で実測する（成立可否、latency、input tokens、エラー内容）
- [ ] 失敗する場合、何が先に壊れるかを記録する（422か、token上限か、精度低下か）
- [ ] パス参照が効かない場合に備え、候補1件ずつ送る形の数字も1点だけ取る

完了条件:

- [ ] Phase 7以降で使う「1リクエストあたりの候補数」を実測値として決めた
- [ ] 仮説が外れた場合の代替（分割呼び出し）のコストとlatencyを把握した
- [ ] 結果を [CITY_SEMANTIC_EXPERIMENT.md](CITY_SEMANTIC_EXPERIMENT.md) と [SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) へ反映した

### Phase 7: 共通Semantic Matchのfixture

依存: Phase 5。Phase 6のProduction公開は必須ではないが、Preview相当の観測環境を用意する。question builderの候補数と呼び出し方は Phase 6.5 の実測値を反映する。

- [ ] `SpecDocument` / `SpecPassage` とCITY `responsibilityId` の安定ID設計を確定する
- [ ] passageの重複、文字数、版、取得日、hash、source URLを検証する
- [ ] Noul question builderをfixtureだけで実装する
- [ ] Choiceの比較分布とNoulの独立 `yesProbability` を別型で保持する
- [ ] アプリ側の順位付け、top-k、abstain、source joinを実装する
- [ ] Engineの境界を `候補集合 -> Map<候補ID, probability>` にし、上流の呼び出し回数を内側へ隠す
- [ ] 質問IDは連番にし、候補IDとの対応表をサーバー側に持つ（文字列変換で復元しない）
- [ ] Jevのmock responseでanswer欠落、未知ID、確率範囲外を検証する

完了条件:

- [ ] 自由生成なしで候補IDから結果を再現できる
- [ ] 出典joinに失敗した候補を公式根拠付きで表示しない
- [ ] 既存LOVE / SOCIAL / CITYの型・APIレスポンスに影響しない
- [ ] 上流を1回呼ぶか複数回呼ぶかを変えても、順位付け以降の層を書き換えずに済む

### Phase 8: SPEC FIND PDF v0

依存: Phase 6.5、Phase 7。CITYより先に行う。SPEC FINDは新モードの追加だけで、先日作り直したばかりの `city.candidates[]` の型とE2Eに触れない。上流呼び出しも1回なので、CITY固有のrequest-level deadlineの宿題を後ろへ回せる。

- [ ] デジタル庁公式の共通機能標準仕様書第2.7版を固定する
- [ ] 20〜40件程度の代表passageをオフライン抽出し、`data`配下のspec用ディレクトリへ追加する
- [ ] `maxPassages` / `maxChars`を超えないデータ検査を追加する
- [ ] 1回のbounded Jev requestでpassageごとの独立Noulを評価する
- [ ] top-3、abstain、章節・ページ・公式PDFリンクを表示する
- [ ] SPEC FINDをserver-side feature flagの既定無効で追加する
- [ ] Excel、項目定義書、API仕様書を混入させない検査を追加する
- [ ] gold caseでRecall@1 / Recall@3、source join、p95 latency、tokens、コストを測る

完了条件:

- [ ] 入力、候補、版、source locatorの対応がfixtureで再現できる
- [ ] 十分に近い候補がない場合に、無理な回答を出さずabstainできる
- [ ] 仕様適合、実装可否、行政・法的判断と誤認させない注意文が常時表示される
- [ ] 公式サイトへランタイムアクセスせず、固定データセットの版が結果へ残る
- [ ] 既存3モードのE2EとMVP Definition of Doneが変わらない

### Phase 9: CITY Semantic Fitのshadow実験（任意）

依存: Phase 6.5、Phase 7、Phase 8の実機評価、CITYの現行受入テスト。SPEC FINDで共通処理の有効性を確かめてから着手する。

- [ ] `CITY_SEMANTIC_EXPERIMENT=false` を既定にする
- [ ] 現行 `route_to` 上位1課から代表分掌を最大12件選ぶ
- [ ] 追加Jev呼び出しを最大1回に制限する
- [ ] 既存結果を返せるrequest-level deadlineとfallbackを実装する
- [ ] base / semanticのlatency、tokens、推計コスト、hit@k、abstainを入力本文なしで記録する
- [ ] 直接語彙、言い換え、課境界、対象外、情報不足のFit / Gapケースを比較する

完了条件:

- [ ] Semantic Fit失敗時も現行CITY結果が返る
- [ ] 追加分がVercel `maxDuration`とコスト上限に収まる
- [ ] 根拠表示は既存の静的データjoinであり、Jev生成文を出典としていない
- [ ] 既定UIへ昇格するか、shadowのままにするかを評価記録へ残す

### Phase 10: 実機評価と採否

依存: Phase 8またはPhase 9の該当機能。SPEC FIND（Phase 8）の評価を先に行う。

- [ ] `jev-latest`で日本語gold caseを実機評価する
- [ ] versioned modelで再現性を確認する
- [ ] p50 / p95、input token、推計コスト、429 / 529 / timeoutを比較する
- [ ] 閾値を固定値として移植せず、採用した値と校正根拠を記録する
- [ ] 採用、shadow継続、撤回のいずれかを決定する

### 次期拡張のDefinition of Done

- [ ] CITY既定経路の候補・根拠・匿名化方針を壊さない
- [ ] SPEC FINDはPDF v2.7の固定コーパスだけを使い、Excelを参照しない
- [ ] リクエストへ渡す候補数・文字数に上限がある
- [ ] Noulの適合度とChoiceの分布をUI・型・ログで混同しない
- [ ] 順位、閾値、abstainがアプリ側で決定される
- [ ] source locator、版、取得日、hashが再現可能である
- [ ] Jev障害時にCITYはfallback、SPEC FINDは再試行または空振り表示となる
- [ ] 実機測定で遅延・コスト・精度のトレードオフを確認している
