# SPEC FIND Design

## 1. 位置づけ

SPEC FINDは、ユーザーの「何をしたいか」という短い自然言語から、仕様書の関連する箇所を見つける実験モードである。**設計段階であり、現行MVPには未実装である。**

目指すのは回答文や適合性判定ではなく、次のような根拠箇所の提示である。

```text
入力: 「複数の業務システム間でデータを連携したい」
出力: 関連しそうなpassage 1〜3件
      - 適合度の目安
      - 章・節
      - PDFページ
      - 原文または短い抜粋
      - 公式PDFへのリンク
```

Needleの「意味が近いpassageを評価し、元の文へ戻す」考え方に着想を得るが、実装・閾値・データ量はこのプロジェクト向けに測定する。[Needle README](https://raw.githubusercontent.com/Shubhamsaboo/awesome-llm-apps/main/advanced_llm_apps/needle/README.md)

## 2. v0のソース範囲

### 採用する資料

v0はデジタル庁の「地方公共団体情報システム共通機能標準仕様書」**第2.7版の公式PDFのみ**を固定して扱う。

- 公式案内: [共通機能の標準仕様](https://www.digital.go.jp/policies/local_governments/common-feature-specification)
- PDF: [地方公共団体情報システム共通機能標準仕様書 第2.7版](https://www.digital.go.jp/assets/contents/node/basic_page/field_ref_resources/4d056a04-6eba-4109-9850-a786d3e71971/023dffea/20260227_policies_local_governments_common_02.pdf)
- 版: 第2.7版
- 公式ページ確認日: 2026-09-21
- v0の対象章: 共通事項、申請管理機能、庁内データ連携機能、住登外者宛名番号管理機能、団体内統合宛名機能、EUC機能、統合収納管理・統合滞納管理機能

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
  documentId: string;        // 例: local-common-feature-2.7
  title: string;
  version: string;           // 例: 2.7
  publishedAt: string | null;
  retrievedAt: string;
  sourceUrl: string;
  contentHash: string;
  passageIds: string[];
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

`text`と出典メタデータを分離する。Jevには短い `text` と候補IDを渡し、画面に出すタイトル、章、ページ、URLはローカルデータからjoinする。PDFページは改版でずれる可能性があるため、`sourceLocator`を主キーに近い表示根拠とし、ページは補助情報とする。

## 5. データ整備

### 5.1 初期コーパス

v0は、公式PDFから手作業または再現可能なオフラインスクリプトで抽出した、**20〜40件程度の代表passage**に限定する。最終件数はテキスト長と実測tokenで決定する。

- 各passageは独立した意味単位にする。
- 章見出し、節見出し、ページ、原文を失わない。
- 表や図の断片、脚注だけの行、重複したヘッダー・フッターは初期コーパスから除外する。
- 長い段落は、出典locatorを保ったまま複数passageへ分割する。
- 同じ要件の重複passageは、版内で一つにまとめる。

実装時は、`maxPassages`と`maxChars`をデータセットの検査対象にする。上限を超えるPDFテキストをリクエストへ入れない。

### 5.2 更新

1. デジタル庁の公式案内で新しい版の公開を確認する。
2. 版、公開日、URL、取得日、hashを記録する。
3. 新版を別の `documentId` として抽出し、旧版を上書きしない。
4. passageの差分、locator、ページ、重複をレビューする。
5. 人手のgold caseを再評価する。
6. 実機のlatency、input token、推計コスト、Recall@kを比較してから既定版を切り替える。

更新はデプロイ前に行い、ランタイムのURL取得で追随しない。既定データセットを変更した場合は、画面とログに版を残す。

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

**「1回のリクエストでN件の独立Noulを評価できる」は仮説であり、合意事項ではない。** TypeSafeの公式ドキュメントに1リクエストあたりの質問数上限の記載は無く、rerank cookbookは1ペア1コール（1,200コール）で書かれている。fan-outパターンも「同じ文書に複数の質問」であり、配列要素ごとに質問を割り当てる例は無い。実測は [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) の Phase 6.5 で行う。仮説が外れた場合は分割呼び出しへ切り替えるが、順位付け・abstain・source joinの層は変更しない。

### 6.2 Noulの意味

1リクエストの全質問は**同じstateを見る**。質問は自前のデータを持てないため、候補passageはstateの配列へ置き、instructionsからバックティックのパスで対象を指す。「この仕様記述は」とだけ書いても、どのpassageを指すかは結び付かない。

```json
{
  "state": {
    "mode": "spec_find",
    "request": "Excelにデータを出して職員が加工したい",
    "passages": [
      { "heading": "EUC機能 / データ抽出", "text": "……を抽出し、職員が利用可能な形式で出力できること。" },
      { "heading": "庁内データ連携機能 / 連携方式", "text": "……" }
    ]
  },
  "questions": {
    "fit_0": {
      "type": "noul",
      "instructions": "Does `passages[0].text`, under the heading `passages[0].heading`, help locate a relevant part of the specification for `request`? Judge semantic usefulness for finding a passage, not compliance, legal meaning, or implementation feasibility.",
      "criteria": {
        "true": "The passage is directly or meaningfully useful for finding the requested topic or operation.",
        "false": "The passage is not useful, is only broadly related, or the relevance cannot be determined."
      }
    },
    "fit_1": { "type": "noul", "instructions": "Does `passages[1].text` … " }
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
- 「見つかりやすさ」の目安（Noul yesProbabilityをパーセント表示する場合は実験値と明記）
- 文書名と版
- `headingPath`
- `sourceLocator`
- PDFページ（取得できる場合）
- 原文の短い抜粋
- 公式PDFへ移動するリンク（ページアンカーを安定して作れない場合はPDF本体へのリンク）
- PDL 1.0 の出典表示。`normalized` が真のpassageは「加工して作成」を併記する（§2）

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

## 9. 実装フェーズ（未着手）

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
