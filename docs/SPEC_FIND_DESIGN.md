# SPEC FIND Design

## 1. 位置づけ

SPEC FINDは、ユーザーの「何をしたいか」という短い自然言語から、仕様書の関連する箇所を見つけるモードである。

**実装済み。** `SPEC_FIND_ENABLED=true` のときだけタブが出る。本番で有効にする判断と根拠は §8.1 にある。

目指すのは回答文や適合性判定ではなく、次のような根拠箇所の提示である。

```text
入力: 「複数の業務システム間でデータを連携したい」
出力: 関連しそうなpassage 1〜3件
      - 適合度の目安
      - 章・節
      - PDFページ
      - 短い抜粋（原文を畳んだもの）
      - 公式PDFへのリンク
      - PDL 1.0 の出典表示
```

返すのは**読むべき箇所**であって、機能要件そのものではない。itemized な機能要件は本文ではなく別紙Excelにある（§2）。

Needleの「意味が近いpassageを評価し、元の文へ戻す」考え方に着想を得るが、実装・閾値・データ量はこのプロジェクト向けに測定する。[Needle README](https://raw.githubusercontent.com/Shubhamsaboo/awesome-llm-apps/main/advanced_llm_apps/needle/README.md)

## 2. v0のソース範囲

### 採用する資料

v0はデジタル庁の「地方公共団体情報システム共通機能標準仕様書」**第2.7版の公式PDFのみ**を固定して扱う。

- 公式案内: [共通機能の標準仕様](https://www.digital.go.jp/policies/local_governments/common-feature-specification)
- PDF: [地方公共団体情報システム共通機能標準仕様書 第2.7版](https://www.digital.go.jp/assets/contents/node/basic_page/field_ref_resources/4d056a04-6eba-4109-9850-a786d3e71971/023dffea/20260227_policies_local_governments_common_02.pdf)
- 版: 第2.7版
- 公式ページ確認日: 2026-09-21
- v0の対象章: 第1章（仕様書について）、第2章（申請管理／庁内データ連携／住登外者宛名番号管理／団体内統合宛名／EUC／統合収納管理・統合滞納管理）、第3章（運用）の全節
- 文書の規模: 59ページ、本文 約56,000字、節（項レベル）38

### 機能要件は本文に無い

「◯◯に求められる機能」の節は6つとも、次の一文だけである。

> EUC 機能の具体的な機能要件は「別紙 1_機能要件」のとおりである。

**itemized な機能要件はPDFではなくExcel（別紙1）にある。** したがってSPEC FINDが返すのは「どの箇所を読むべきか」までであり、要件そのものではない。これは §3 の非目的と一致する。

一方、業務フローの節には機能ID付きの動作記述がある（ユニークな機能ID 18件）。v0では節単位の代表passageに留め、機能ID単位への分割はgold caseで必要性を確認してから判断する。

PDFのURL、版、公開日、取得日、content hashをデータセットのメタデータに保存し、質問ごとにWebから取得しない。v0の実行時データは正規化したpassage JSONとする。

### ライセンスと出典表示

digital.go.jp のコピーライトポリシーは**PDL 1.0（公共データ利用規約 第1.0版）**である（2026-09-21確認）。したがって、抽出したpassageを公開リポジトリへコミットし、アプリで表示してよい。ただし次を守る。

| 条件 | 対応 |
|---|---|
| 出典表示 | `出典：「地方公共団体情報システム共通機能標準仕様書」（デジタル庁）（URL）` |
| 加工した場合 | `「…」（デジタル庁）（URL）を加工して作成` を併記する |
| 加工物を無加工の政府資料として見せない | 画面とデータの両方で、原文か正規化文かを区別できるようにする |
| 対象外 | ロゴ、シンボル、キャラクター。これらは取り込まない |

`SpecPassage.text` は「原文または短い正規化文」なので、**正規化した時点で加工に当たる**。passageごとに原文のままか加工したかを持たせ、画面の出典表示を切り替える（§4.2 の `normalized`）。

PDF本体はリポジトリへ置かない。1.6MBあり、公式URLから常に取得できる。データセットが持つのはpassageとメタデータだけにする。

### 明示的に除外する資料

次の資料は公式ページに掲載されていてもv0には含めない。

- 機能要件のExcel
- 項目定義書
- API仕様書、ファイル連携仕様書
- FAQ、個別制度資料、Webページ本文

Excelはファイルサイズだけを見ると小さくても、行ごとの機能ID、要件文、分類、版管理、Excel固有のセル・シートlocaterを別途設計する必要がある。PDF v0の評価が終わる前に混ぜると、候補の重複と出典表示の責任範囲が増えるため、別データセットとして後から追加する。

## 3. 非目的と表示上の制約

- 仕様書に適合している、または実装可能であると判定しない。
- 行政・法令・調達上の正式な解釈を提供しない。
- PDF全文をJevへ毎回送らない。
- ランタイムに公式サイトを取得して、取得結果をそのまま判定へ使わない。
- Jevに段落の要約や回答を生成させない。

結果画面には、少なくとも「仕様箇所を探す実験であり、適合性・実装可否の判定ではない」と表示する。

## 4. データモデル

### 4.1 文書

```ts
type SpecDocument = {
  documentId: string;        // 例: common-feature-2.7
  title: string;
  version: string;           // 例: 2.7
  publishedAt: string | null;
  retrievedAt: string;
  sourceUrl: string;
  contentHash: string;
};
```

### 4.2 Passage

```ts
type SpecPassage = {
  passageId: string;         // 文書版を含めて安定化する
  documentId: string;
  sectionId: string;         // 例: 2.2
  headingPath: string[];
  text: string;              // 検索・判定対象の原文または短い正規化文
  page: number | null;
  sourceLocator: string;     // 例: §2.2 / 4.1.3
  sourceUrl: string;
  sentenceStart: number | null;
  sentenceEnd: number | null;
  tags: string[];
  /** text が原文そのままか、抽出時に正規化したか。出典表示を切り替える。 */
  normalized: boolean;
};
```

データセットは `{ schemaVersion, document, passages }` の形にし、`document.passageIds` のような重複した索引は持たない。同じ事実を2箇所に持つと必ず片方が古くなる（CITYデータで同種の取りこぼしを経験している）。実装は `src/lib/types/spec.ts` と `src/lib/server/spec-corpus.server.ts`。生成スクリプトはこの検証をそのまま import する（写すと必ず片方が古くなる）。TypeScript を Node の型ストリップで読むため、`pnpm spec:build` には **Node 22.12 以上**が要る。

`text`と出典メタデータを分離する。Jevには短い `text` と候補IDを渡し、画面に出すタイトル、章、ページ、URLはローカルデータからjoinする。PDFページは改版でずれる可能性があるため、`sourceLocator`を主キーに近い表示根拠とし、ページは補助情報とする。

## 5. データ整備

### 5.1 初期コーパス

v0は、公式PDFから再現可能なオフラインスクリプト（`scripts/build-spec-corpus.mjs`）で抽出した**39件**の代表passageに限定する。1リクエストの実測上限40件の内側に収め、分割呼び出しを避ける。

抽出の規則は次のとおり。

1. 本文を持つ節（項レベル）ごとに1件。章見出しは本文を持たないため除く。
2. 2,000字を超える節は2件目の抜粋を作る。
3. 「別紙1のとおり」の一文だけの節（5件）は1件へまとめる。§2.6.3 は帳票要件を追記しているため独立させる。まとめたpassageは**ページを持たない**（`page: null`）。統合元は別々のページにあり、どれが当たっても同じページを引用として示すことになるため、`sourceLocator` に全節を並べる。
4. 抜粋は600字以内で、文の途中で切らない（句点で切る）。
5. **折り返した見出しはつなぐ。** 版面の幅で見出しが2行に分かれることがある（§1.5）。続きは見出しの直後に空行なしで現れ、本文は必ず空行を挟む。つながないと、パンくずが「…共通機能の関」で切れ、続きの「係性」が本文の先頭へ混ざる。Jevへ渡す文脈も画面の表示も壊れる。
6. `sourceLocator` は節番号。続きは原文で読む前提にする。

**v0は全文検索ではなく代表passageの索引である。** 長い節は先頭の抜粋で代表し、本文全体は検索対象に入らない。抜粋で当たりを付けて、locatorから原文へ辿る導線でこれを補う。

- 各passageは独立した意味単位にする。
- 章見出し、節見出し、ページ、原文を失わない。
- 表や図の断片、脚注だけの行、重複したヘッダー・フッターは初期コーパスから除外する。
- 長い段落は、出典locatorを保ったまま複数passageへ分割する。
- 同じ要件の重複passageは、版内で一つにまとめる。

検査は3つの上限で行う（`src/lib/server/spec-corpus.server.ts`）。

| 上限 | 値 | 理由 |
|---|---|---|
| `MAX_PASSAGES` | 40件 | 1リクエストで評価できる実測上限 |
| `MAX_PASSAGE_CHARS` | 600字 | 長すぎる断片は複数の意味を混ぜる |
| `MAX_CORPUS_CHARS` | 20,000字 | **本文と見出しの合計。** `state` と最長の質問で32k tokensという制限に対し、約68%に収める |

**件数と1件あたりの上限だけでは、リクエスト全体の大きさが決まらない。** 40件 × 600字を上限まで使うと約25,700字になり、`state` だけで32kの約88%に達する。測っていない領域へ入るため、総量でも止める（[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §8.1）。

現在の配布コーパスは15,317字で、総量上限の77%である。

### 5.2 更新

1. デジタル庁の公式案内で新しい版の公開を確認する。
2. `scripts/build-spec-corpus.mjs` の `DOCUMENT` を更新する。`version` / `publishedAt` / `sourceUrl` / `contentHash` を**同時に**変える。
3. 新版を別の `documentId` として抽出し、旧版を上書きしない。
4. passageの差分、locator、ページ、重複をレビューする。
5. 人手のgold caseを再評価する。
6. 実機のlatency、input token、推計コスト、Recall@kを比較してから既定版を切り替える。

更新はデプロイ前に行い、ランタイムのURL取得で追随しない。既定データセットを変更した場合は、画面とログに版を残す。

### 入力PDFの照合

**生成の前に、渡されたPDFが固定した出典と同じものかを確かめる。** コーパスは題名・版・URLを固定で名乗り、PDL 1.0 の出典表示もその内容で組み立てる。別の版や無関係なPDFでも、見出しの番号付けさえ合えば抽出は通ってしまい、**公式資料を名乗る別物**が出来上がる。hashを記録するだけでは防げない。

照合するのは次の3点（`scripts/lib/spec-source.mjs`）。

| 見るもの | 目的 |
|---|---|
| content hash | 固定したPDFと同一か |
| 表紙の題名 | 別の文書を渡していないか |
| 表紙の版 | 改版なのか取り違えなのかを切り分ける |

hashだけだと「何を渡したのか」が分からない。版と題名を併せて示すことで、改版時は `DOCUMENT` の更新へ、取り違え時はファイルの取り直しへ誘導する。判定は**表紙（1ページ目）だけ**で行い、本文中の他版への言及に釣られない。

一致しない場合は出力先に触れずに終了する。

## 6. v0のJev設計

### 6.1 呼び出し方式

処理遅延とtokenを抑えるため、v0は**一つのbounded request**で候補passageを評価する。

```text
ユーザー入力
  -> 静的な20〜40件のpassageを読み込む
  -> 1回のSystem One requestで各passageの独立Noulを評価
  -> アプリ側でfitProbability順に並べる
  -> local joinで章・ページ・URLを付ける
```

v0ではStage 1のカテゴリChoiceを別呼び出しにしない。コーパスが20〜40件なら候補の絞り込みなしで足り、呼び出しを1回に保てるためである。**当初の要件はStage 1の機能領域Choiceを求めていたが、v0では意図的に省いている。** 「Stage 1 → Stage 2で全文総当たりを避ける」という目的は、SPEC FINDでは「コーパス自体を有界に保つ」ことで満たす。コーパスが増えて一回のbounded requestに収まらなくなった場合だけ、カテゴリChoice → 上位passage評価の二段階案を再検討する。

**40件までは1リクエストで成立することを実測で確認した。** 422もtoken上限も出ず、answerの欠落も無く、latencyは候補数にほとんど依存しない（40件で245ms、入力6,765token）。対象外の入力では0.9以上の候補が0件になり、abstainも成立する（[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §8.1）。分割呼び出しは同じ件数でlatency 22倍・入力token 2.5倍になるため採らない。

### 6.2 Noulの意味

1リクエストの全質問は**同じstateを見る**。質問は自前のデータを持てないため、候補passageはstateへ置き、instructionsからバックティックのパスで対象を指す。「この仕様記述は」とだけ書いても、どのpassageを指すかは結び付かない。

**passageはオブジェクトにし、キーで参照する。配列インデックスは使わない。** 配列インデックス参照は候補が20件を超えたあたりから確率が隣接インデックスへ滲む。実測では、コーパスが同じで正解の位置だけを変えたときに無関係なpassageが最上位に来た（[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §8.1）。

```json
{
  "state": {
    "mode": "spec",
    "request": "システム同士をAPIでつなぎたい",
    "passages": {
      "p0": {
        "heading": "庁内データ連携機能 / REST による公開用 API 連携における認証認可について",
        "text": "REST による公開用 API 連携において、API を利用する基幹業務システムの認証認可を行う必要があることから、認証認可の方式について、以下のとおり規定する。 (1) 全般 ① 認証方式client_secret_jwt による JWT を用いた認証方式とする。……"
      },
      "p1": { "heading": "EUC 機能 / EUC 機能の位置づけ", "text": "……" }
    }
  },
  "questions": {
    "fit_0": {
      "type": "noul",
      "instructions": "Does `passages.p0.text`, under the heading `passages.p0.heading`, help locate a relevant part of the specification for `request`? Judge semantic usefulness for finding a passage, not compliance, legal meaning, or implementation feasibility.",
      "criteria": {
        "true": "The passage is directly or meaningfully useful for finding the requested topic or operation.",
        "false": "The passage is not useful, is only broadly related, or the relevance cannot be determined."
      }
    },
    "fit_1": { "type": "noul", "instructions": "Does `passages.p1.text` … " }
  }
}
```

**質問IDは連番にし、`passageId` を埋め込まない。** 質問IDから候補IDを文字列変換で復元する設計にすると、IDにドットやアンダースコアが含まれる場合に一意へ戻せない。サーバー側で `index -> passageId` の対応表を持ち、結果のjoinはその表で行う（CITY側も同じ方針。[CITY_SEMANTIC_EXPERIMENT.md](CITY_SEMANTIC_EXPERIMENT.md) §5）。

`heading` をstateへ含めるのは、passageだけでは文脈を失う場合があるためである。送る文字数は `maxChars` の検査対象に含める。

`yesProbability`はpassageの検索上の適合度であり、仕様適合率、正答率、confidence、文書全体の確信度ではない。Noul同士は独立しており、合計1にならない。順位付けはアプリ側で行い、Jevに「top 3を返す」「理由を説明する」生成タスクをさせない。

### 6.3 閾値とabstain

上位3件までを基本表示とするが、候補が弱い場合は「十分に近い仕様箇所を見つけられませんでした」と表示する。

- `topK`、最低適合度、候補間の差は実験設定にする。
- Needleのサンプル閾値をそのまま再利用しない。
- 閾値未満を無理に表示して、関係の薄いpassageを公式回答のように見せない。
- 候補が複数同程度の場合は、順位だけでなく同率に近いことを表示する。

## 7. UI仕様

### モード

- タブ名: `SPEC FIND`
- 入力上限: 既存モードと同じ280 Unicode code points
- ボタン: `FIND` または `JUDGE` のどちらかに統一する。既存のJUDGEを維持する場合は、モード説明で「仕様箇所を探す」と明示する。

### 結果カード

各カードは次を表示する。

- 順位
- **「適合度（実験値）」**としてのNoul yesProbability。仕様適合率でも検索の正答率でもないことを、数値の隣で示す
- 文書名と版
- `headingPath`
- `sourceLocator`
- PDFページ（取得できる場合）
- 原文の短い抜粋
- 公式PDFへ移動するリンク（ページアンカーを安定して作れない場合はPDF本体へのリンク）
- PDL 1.0 の出典表示。`normalized` が真のpassageは「加工して作成」を併記する（§2）

結果の一覧の下に、Choiceの分布と取り違えないための注記を出す。

> 適合度は仕様箇所ごとに**独立して**評価した実験値です。合計は100%になりません。仕様への適合率や検索の正答率ではありません。

画面下部に次を常時表示する。

> これは仕様書内の関連箇所を探す技術検証です。仕様への適合、実装可否、行政・法的な判断を示すものではありません。

### エラーと空振り

| 状態 | 表示・挙動 |
|---|---|
| コーパス未設定 | SPEC FINDを利用不可として一般エラーを表示。Jevを呼ばない |
| passage数・文字数超過 | デプロイ前のデータエラーとして扱い、リクエストを送らない |
| Jev timeout / 429 / 529 | 入力を保持し、再試行を案内 |
| 一部answer欠落 | 結果全体を公式情報として表示せず、再試行または空振り扱い |
| 候補なし | 「十分に近い仕様箇所を見つけられませんでした」 |
| 出典join失敗 | 該当カードを表示せず、requestIdとdataset versionだけをログ |

## 8. 評価

### Gold case

- 仕様語が入力に含まれる直接一致
- 住民・利用者の言い換え
- 複数の章にまたがる要求
- 章は近いが要件が異なる入力
- 文書外の質問
- 空白・曖昧・長すぎる入力

各入力に、正解passage、許容passage、対象外、理由を人手で付ける。PDFの文章を正解として扱うのであって、Jevの確率を正解ラベルにしない。

### 指標

- Recall@1 / Recall@3
- MRRまたはnDCG（goldの複数許容順位を扱う場合）
- abstain precision / recall
- source locator join成功率
- p50 / p95 latency
- input/output tokensと推計コスト
- Jevエラー率とanswer欠落率

v0の採用条件は、Recallだけでなく、根拠locatorの正しさ、空振りの安全性、予算内の遅延・コストを同時に満たすこととする。

### 実測（2026-09-21、model `jev-1.13.0`、passage 39件、gold 17件）

評価ハーネスは `src/lib/server/spec-recall.live.spec.ts`。既定ではスキップし、`LIVE_JEV=1` のときだけ上流を呼ぶ。

```bash
LIVE_JEV=1 pnpm vitest run --reporter=verbose src/lib/server/spec-recall.live.spec.ts
```

**上流は本番のラッパー `evaluate()` を通す。** `TypeSafeClient` を直接叩くと、`JEV_TIMEOUT_MS`、総予算の `AbortSignal`、retryの中断、SDKエラーのマッピング、送信前の criteria 検査が評価の対象外になり、測っている経路が本番と変わる。

**採否の基準はログではなくassertで判定する。** 上流は1回だけ回し、基準ごとに別々のテストで判定するので、どれを満たせていないかがそのまま出る。

| 基準 | 下限 | 根拠 |
|---|---|---|
| Recall@1 | 80% | 実測87〜93%。1〜2件の揺れは通す |
| Recall@3 | 90% | 実測100%。読むべき箇所を探す用途の主指標 |
| 対象外入力のabstain | **全件** | 関係の薄いpassageを回答のように見せないのは安全性の要件。取りこぼしを許さない |
| 正解がある入力でのabstain | **0件** | 見つかるはずの入力を「見つからない」と言うのも失敗 |
| 出典の解決 | **全件** | 解決できない候補を公式根拠付きで見せない |
| p95 latency | 3,000ms | `JEV_TIMEOUT_MS` が3,500ms。超えるとSDKがretryして遅延が倍になる |
| リクエストのtoken使用率 | 64kの50%以下 | 超えたらコーパスの大きさを見直す |

下限は「実測と同じ」にしない。モデルの揺れで落ちる基準は、退行の検出器として使えなくなる。

| 指標 | 結果 |
|---|---|
| Recall@1 | **93%**（14/15） |
| Recall@3 | **100%**（15/15） |
| 対象外入力のabstain | **2/2** |
| latency 中央値 / 最大 | 587ms / 984ms |
| 入力token 平均 | 20,928 |
| 1問あたりの推計コスト | $0.00088（約0.13円） |

言い換えも通った。「Excelにデータを出して職員が加工したい」はEUC機能の節へ、「APIのアクセストークンの有効期限はどう決まるか」は §2.2.5 の2つ目の抜粋へ到達した。仕様書の用語を知らない自然文から、文字列一致では届かない箇所へ届いている。

Recall@1 を外した1件は「マイナポータルから来た申請を基幹システムに取り込みたい」で、1位が §1.3（対象範囲）になった。§1.3 は申請管理機能を含む対象機能を列挙しているため誤りとは言い切れない。正解の §2.1.1 / §2.1.4 は2位・3位に入っている。

**§1.3 は多くの問い合わせで上位に出る。** 全機能を列挙しているため、どの領域の質問にも一定の適合を示す。順位の解釈時にこの偏りを踏まえる。

**機能ID単位への分割はv0では不要と判断する。** 節単位の代表passageでRecall@3が100%に達しており、粒度を細かくする根拠が無い。必要になるのは「節の中のどのステップか」まで絞る要求が出たときである。

入力tokenはCITYの実測（候補40件で6,765）より3倍多い。passageの本文がCITYの分掌事務より長いためで、件数ではなく文字数が効いている。

## 8.1 採否の判断（2026-09-21）

**本番で有効にする。** `SPEC_FIND_ENABLED=true` を Production と Preview の両方へ設定する。

### 根拠

7つの採用基準をすべて満たした（§8）。とくに次の2点を重視した。

- **文字列検索では届かない箇所へ届く。** 「住民票のない人にも番号をつけて管理したい」の「住民票のない人」は仕様書に一度も現れない（仕様書の語は「住登外者」）。それでも §2.3 へ到達する
- **該当が無ければ候補を出さない。** 対象外の入力では0.9以上の候補が0件になり、abstain が成立する

CITY Stage 2 と違い、SPEC FIND は**結果そのものが利用者の価値**である。待ち時間を払って画面が変わらない shadow とは取引の形が違う。

### コストと露出

| 項目 | 値 |
|---|---|
| 1問あたりの入力token | 約20,900 |
| 1問あたりのコスト | 約$0.00088（約0.13円） |
| p95 latency | 約1.1秒 |

**他モードより1問あたりのコストが高い。** CITY は約8,400 tokens、LOVE / SOCIAL はさらに少ない。SPEC FIND は候補passageをstateへ載せるため約2.5倍になる。

レート制限は全モード共通で既定10回/分である。同一送信元がSPEC FINDを上限まで使うと約1.3円/分になる。`robots.txt` で検索インデックスを拒否しているため想定流量は小さいが、コストが読めない場合は `APP_RATE_LIMIT_PER_MINUTE` を下げる。

### 実験としての位置づけは残す

既定機能にしても、次の表示は外さない。

- 「仕様書内の関連箇所を探す技術検証です。仕様への適合、実装可否、行政・法的な判断を示すものではありません。」
- 「適合度（実験値）」というラベルと、合計が100%にならない旨の注記

Noulの確率は校正されていない値であり、仕様適合率でも検索の正答率でもない。機能が既定になっても、この性質は変わらない。

## 9. 実装フェーズ（完了）

1. 第2.7版PDFのメタデータとpassage fixtureを作る。
2. passage schema、重複、文字数、source URL allowlist、出典表示に必要なフィールドの検証を作る。
3. JevをmockしたSemantic Match normalizerと順位付けを作る。
4. `/api/judge`へSPEC FINDを追加する前に、server-onlyの評価関数をfixtureで検証する。
5. feature flagでUIを隠したshadow評価を行う。
6. 実機で日本語のgold case、latency、tokens、costを測る。
7. v0のPDF範囲を超える資料は、別のデータセット設計として再審査する。

## 10. Excelを後回しにする理由

機能要件Excelを読むこと自体は技術的に不可能ではない。しかし、PDF v0に対して次の設計が追加で必要になる。

- シート・行・セルを含む安定locator
- 機能IDと要件IDの正規化
- 1行が複数passageになる場合の結合規則
- PDFの章節とのcross-reference
- 版更新時の行移動と削除の差分管理
- 同じ概念のPDF passageとExcel行の重複抑制
- 返却時にどちらを優先するかのUI設計

そのため、Excelは「PDFの結果をさらに詳細化する別レイヤー」として、v0の評価後に追加する。v0へ混ぜないことが、処理遅延と設計の拡大を抑える最も小さい境界である。
