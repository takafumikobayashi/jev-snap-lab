# CITY Semantic Fit Experiment

## 1. 位置づけ

この文書は、CITYの担当候補判定にセマンティックな適合度評価を追加する場合の実験設計である。**設計段階であり、現行のMVP実装には含まれない。**

現行の既定経路は次のまま維持する。

```text
短文
  -> route_to Choice（課レベル）
  -> Choiceの確率を表示
  -> 候補IDをローカルのCITYデータへjoin
  -> 分掌、出典、取得日、有効日を表示
```

Semantic Fitは、Jevの出力を公式な担当課の確定へ置き換える機能ではない。現行Choiceの判断を補助する、または精度比較のための `experimental` / `shadow` 結果として扱う。

## 2. 目的と非目的

### 目的

- 短い住民文と、候補課の分掌事務の意味的な近さを測る。
- Choiceが候補を取りこぼす入力、課境界が曖昧な入力、語彙が異なる入力を発見する。
- Jevの確率と、ローカルデータの根拠情報を同じ安定IDで結び付ける。
- レイテンシ、入力token、推計コスト、適合度の再現性を測定できるようにする。

### 非目的

- CITYの正式な問い合わせ先、行政判断、緊急度、SLAを確定すること。
- Jevに全615件の分掌事務を毎回送ること。
- 分掌事務を生成・要約させ、その文章を公式根拠として表示すること。
- 現行の公開用架空データセットや匿名化方針を変更すること。

## 3. 現行ベースライン

現行の `route_to` は、同じ課に属する係を一つの `routingCandidateId` にまとめたChoiceである。係をChoice候補へ分割すると確率が分散するため、係の解決はJevではなくローカルの `keywords` / `responsibilities` マッチで行う。

Semantic Fitの評価では、次の値をベースラインとして保存する。

- `route_to.choice`
- `route_to.probabilities`
- `route_to.confidence`
- `requestId`、model、latency、usage
- `directoryVersion`
- ローカルjoinで得られた候補とsource locator

ベースラインの表示と挙動は、実験結果の有無にかかわらず成立しなければならない。

## 4. 最小実験案

### 4.1 候補の絞り込み

初回の実験では、既存の `route_to` 結果から次のように候補を決める。

1. 既存Choiceの上位1件を標準候補とする。
2. 候補の確率差が小さい、または明示的な実験設定がある場合だけ上位2件まで許可する。
3. 上位3件以上、全課、全係へのfan-outはv0では行わない。
4. `other_or_unclear` しか残らない場合は、Semantic Fitを実行せず、現行結果を返す。

「確率差が小さい」の閾値はTypeSafe/Jevの普遍的な仕様ではない。固定値を設計段階で決めず、受入データで校正する。候補数が増えるほど入力tokenと結果の解釈コストが増えるため、候補数はリクエストごとの予算内で制限する。

### 4.2 分掌候補の事前選択

候補課ごとに全分掌を送らず、サーバー側で決定的に代表候補を選ぶ。

- 初期上限は**1課あたり12件**とする。
- `responsibilityId`、`officialText`、`sourceRefs`を持つレコードだけを対象にする（Jevへ送るのは `officialText`。§4.3）。
- 住民語と結び付く `keywords` があるもの、具体的な事物を含むもの、代表性が高いものを優先する。
- 「計画」「総括」「課の庶務」のように、課の区別に寄与しない抽象的な事務は優先度を下げる。
- 同じ入力、同じデータバージョンでは同じ順序になるようにする。

12件は精度を保証する数字ではなく、現行データの偏りとtoken予算を考えた初期上限である。実測で超過する場合はさらに減らし、取りこぼしが多い場合もいきなり全件へ増やさず、評価データを追加してから見直す。

### 4.3 Jevへの質問

CITY v0では、既存のChoiceを置き換えず、限定した候補について独立したNoulを追加評価する。

1リクエストの全質問は**同じstateを見る**。質問は自前のデータを持てないため、候補分掌はstateへ置き、instructionsからバックティックのパスで対象を指す。

**候補はオブジェクトにし、キーで参照する。配列インデックスは使わない。** 配列インデックス参照は候補が20件を超えたあたりから確率が隣接インデックスへ滲み、無関係な候補が最上位に来る。実測で確認した（[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §8.1）。

```json
{
  "state": {
    "mode": "city",
    "text": "家の前の防犯灯が切れてます",
    "jurisdiction": "M市",
    "responsibilities": {
      "r0": { "section": "危機管理課", "text": "防犯施設の設置及び管理に関すること。" },
      "r1": { "section": "危機管理課", "text": "災害対策に関すること。" }
    }
  },
  "questions": {
    "fit_0": {
      "type": "noul",
      "instructions": "Is the resident's `text` directly or meaningfully covered by `responsibilities.r0.text`, which is handled by `responsibilities.r0.section`? Judge the wording of the request, not the official truth of who must handle it.",
      "criteria": {
        "true": "The resident text is directly or meaningfully covered by this responsibility.",
        "false": "The text is not covered, is only weakly related, or cannot be judged."
      }
    },
    "fit_1": { "type": "noul", "instructions": "Is the resident's `text` … `responsibilities.r1.text` … " }
  }
}
```

Noulの回答は `{ "type": "noul", "noul": 0.85 }` の形で返る。既存の `normalizeAnswers` が `answer.noul` を読むのと同じである。

**質問IDは連番にし、`responsibilityId` を埋め込まない。** 実データのIDは `accounting.u1.r1` の形で、`routingCandidateId` 自体が `social_welfare` のようにアンダースコアを含む。ドットをアンダースコアへ変換すると `social_welfare_u2_r15` となり、どこが区切りか一意に戻せない。サーバー側で `index -> responsibilityId` の対応表を持つ（既存の `normalizeAnswers` がcatalogのmapで引くのと同じ流儀）。

`directoryVersion` は結果のjoinと観測に必要だが、判定に寄与しないためJevへ送らない。現行の値は `mcity-2026-04-01`（`jurisdiction` と `effectiveFrom` の組）である。

Jevへ送るテキストは **`publicSummary` ではなく `officialText`** とする。現行Stage 1のChoice descriptionは `publicSummary` に代表分掌（`officialText` 由来）を添える形だが、Stage 2は分掌そのものとの適合を測るため、条文の文言を直接使う。実データの長さは `officialText` 最長102字 / `publicSummary` 最長96字で、どちらでもtoken予算に差は出ない。

**候補数は実測で裏が取れている。** 40件まで1リクエストで成立し、latencyは候補数にほとんど依存しない（[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §8.1）。CITYの上位2課×12件＝最大24件は余裕の内側にある。分割呼び出しは同じ12件でlatency 22倍・入力token 2.5倍になるため、まとめて送る方式を既定とする。

Noulの `yesProbability` は「この分掌に意味的に適合するという読み」の確率である。Choiceの `route_to.probabilities` とは別物であり、候補間で合計1になる分布ではない。`confidence` や公式な担当確率として表示しない。

### 4.4 呼び出し回数とfallback

CITYの既定経路は1回呼び出しのままとする。Semantic Fitを動かす場合だけ、既存Choiceの後に最大1回の追加呼び出しを行う実験経路とする。

```text
既定:      route_to Choice + その他の質問       1回
実験時:    既定の結果 -> 候補/分掌を決定 -> Fit Noul  追加1回まで
失敗時:    Semantic Fitを破棄 -> 既定結果を表示
```

追加呼び出しの成功は、現行の担当候補や根拠表示を上書きする条件にしない。追加呼び出しがtimeout、429、529、422、データ不整合になった場合も、既定結果を返せることを成功条件とする。

1回のHTTPリクエスト全体に、既存呼び出しと追加呼び出しを合算したrequest-level deadlineが必要である。現在の `JEV_TOTAL_TIMEOUT_MS=12000` は1回のevaluateの予算であり、2回呼べることを意味しない。

現行値をそのまま2回ぶん使うと**予算が足りない**。

```text
JEV_TOTAL_TIMEOUT_MS  12000  x 2 回 = 24000 ms
maxDuration           20000 ms
```

先にVercel側で切られ、アプリの504にも既定結果のfallbackにも到達しない。Semantic Fitを実装する段階で、リクエスト全体の予算を新設してStage 1 / Stage 2で分け合い、`maxDuration` と同時に見直す。SPEC FINDは1回呼び出しなのでこの宿題は無く、[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) でSPEC FINDを先行させる理由の一つになっている。

## 5. レスポンスと根拠join

Semantic Fitの内部結果は、少なくとも次の形で保持する。Jevが返した自由文章やcriteria全文はクライアントへ返さない。

```ts
type SemanticFitResult = {
  routingCandidateId: string;
  responsibilityId: string;
  fitProbability: number;  // Noul yesProbability。公式確率ではない
  rank: number;
  matchedText: string;     // ローカルデータから取得した表示用要約
  sourceRefs: string[];    // ローカルjoinしたsourceId
};
```

joinは次の順序で行う。

1. 質問ID（連番）をサーバー側の対応表で `responsibilityId` へ引く。質問IDの文字列から復元しない（§4.3）。
2. そのIDが現在の `directoryVersion` に存在するか検証する。
3. `fitProbability`でアプリ側で順位付けする。Jevに順位や説明文を生成させない。
4. `sourceRefs`からローカルの出典、locator、取得日、有効日を解決する。
5. 出典が解決できない結果は、公式根拠付きの候補として表示せず、データ不整合としてログする。

表示には「意味的に近い可能性」「実験的な候補」など、正式な担当確定と区別できるラベルを使う。一定値を超えない候補だけを「該当なし」と断定するのではなく、候補なしを許す `abstain` 状態を持たせる。

## 6. 評価方法

### 6.1 Fit / Gapケース

最低限、次のケースを同じ入力集合で比較する。

| ケース | 目的 |
|---|---|
| 直接語彙（防犯灯、道路の穴など） | 現行ChoiceとFitの基本整合 |
| 言い換え（街灯、舗装のへこみなど） | 条文語と住民語の橋渡し |
| 課境界（子どもの予防接種など） | 複数課候補の扱い |
| 複数課にまたがる文 | cross-department軸との関係 |
| 情報不足・曖昧文 | abstainとfallback |
| CITY対象外 | 無理に候補を出さないこと |

各ケースには、人手で作った期待候補、許容候補、出典責任者、曖昧さを記録する。Jevの数値だけを正解ラベルにしない。

### 6.2 指標

- 現行Choiceの top-1 / top-3 候補一致率
- Semantic Fitの responsibility hit@1 / hit@3
- 候補課の根拠join成功率
- `abstain` の適合率（分からない入力を分からないとしたか）
- 現行経路との差分率（どの入力で候補が変わったか）
- p50 / p95 latency、追加入力token、推計コスト
- timeout / 429 / 529 / 422率

### 6.3 採用条件

Semantic Fitは、精度が上がったように見えるだけでは既定経路へ昇格しない。少なくとも、評価ケースで根拠joinを壊さず、レイテンシ・コスト・エラー率の予算内に収まり、曖昧入力で過剰確信を増やさないことを確認する。

閾値は実験データから校正する。Needleのサンプルにある閾値をそのまま流用しない。TypeSafe/JevのNoul確率に、他システムのしきい値を移植しても同じ意味になる保証はない。

## 7. 実装時の段階

1. fixtureだけでSemantic Fitのquestion builder、response normalizer、local joinを実装する。
2. 現行CITY APIへ影響しないserver-onlyの評価関数として追加する。
3. feature flagまたはshadow modeで、結果を画面へ出さずmetricsだけ比較する。
4. 評価データと実測で候補数、12件上限、request deadlineを調整する。
5. 既定UIへ出す場合は、現行候補と実験候補を同じカードに混ぜず、実験であることと根拠の種類を明示する。

## 8. 未決定事項

- 上位1件で十分か、どの条件で上位2件にするか
- 課ごとの分掌候補上限（初期12件）の再校正
- `fitProbability`を表示するか、順位と根拠だけを表示するか
- abstainの表示閾値と、候補差が小さい場合の表示方法
- CITYの既定APIレスポンスへexperimental blockを含めるか
- 追加呼び出しを許すrequest-level deadlineと料金上限（現行の12000×2が `maxDuration` 20000を超える点を含む）
- 1リクエストへ何件のNoulを入れられるか（Phase 6.5の実測待ち）

これらは実装前に評価fixtureと実機観測で決める。決定までは、Semantic Fitを本番の既定ルートへ入れない。
