# Jev Design

## 1. 調査条件

- 調査日: 2026-09-20
- 参照先: [TypeSafe AI 公式ドキュメント](https://docs.typesafe.ai/)、[API reference](https://docs.typesafe.ai/api)、[Models](https://docs.typesafe.ai/models)
- この文書で「確認済み」と書いた仕様は、上記の公式ドキュメントに記載があるものに限る。
- SDKの細かなバージョン、課金アカウントごとの実効レート制限、実際の日本語精度は、実装時のアカウントと実機で確認する。

## 2. 確認済みのAPI仕様

### エンドポイント

```text
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

リクエストのトップレベルは `state`、`model`、`questions`。`state` は文字列、オブジェクト、配列を受け付ける。質問はIDをキーにした map で送り、レスポンスは同じIDの `answers` に返る。[Quick start](https://docs.typesafe.ai/introduction/quickstart) では複数の質問を一つのリクエストに混在させる例が示されている。

### モデル

公式のモデルページでは、現行モデルは `jev-1.13.0`、安定版エイリアス `jev-latest` は現時点で `jev-1.13.0` を指すと記載されている。[Models](https://docs.typesafe.ai/models)

本プロジェクトの推奨設定:

```dotenv
TYPESAFE_DEFAULT_MODEL=jev-latest
```

- デモの実行は `jev-latest` を使い、レスポンスの `model` を画面と観測ログへ残す。
- 回帰テストや結果比較では `jev-1.13.0` のような versioned ID を明示して、エイリアス移動による差分とプロンプト変更による差分を分離する。
- 実装開始時に、利用可能なモデル名とアカウントのレート制限をAPI/Consoleで再確認する。

### 制限・課金（公式記載値）

現行モデルページの記載値は次のとおり。レート制限は変更される可能性があるため、定数として固定せず、リクエスト失敗時はレスポンスを優先する。

- 価格: input 1M tokens あたり `$0.042`。output tokens は無料と記載されている。
- レート制限: 250,000 tokens/秒、1,200 requests/分。
- コンテキスト: リクエスト全体64k tokens、`state` と最長の質問の組み合わせは32k tokensという記載。
- 入力: text only。画像・音声・動画は対象外。
- 英語が主な学習言語で、日本語などCJKの精度は自分のコンテンツでテストするよう公式に注意書きがある。

280文字の入力と数十個未満の短い質問ではコンテキスト上限を通常超えないが、CITYの分掌説明を無制限に入れない。必要な候補だけをコンパクトに渡す。

## 3. Question type の使い分け

| Type | 使う条件 | 主要レスポンス | Jev Snap Labでの主用途 |
|---|---|---|---|
| Choice | 順序のない候補から1つ選ぶ | `choice`, `probabilities`, `confidence` | LOVEの主な読み、SOCIALの投稿型、CITYの担当課候補・カテゴリ |
| Score | 低い→高いという順序を言葉で定義できる | `score`, `legend`, `probabilities`, `confidence` | 恋愛的強さ、カジュアル度、議論性、CITYの緊急度 |
| Noul | yes/noの条件を明示でき、yes確率が必要 | `noul`（0〜1） | 未練、驚き、反応誘発、現地確認要否など |

公式ドキュメントでは、同じstateに対する質問は独立に評価され、複数質問を一つのリクエストへ入れられる。質問間で前の答えを参照する必要がない限り、1回のfan-outで送る。[Primitives](https://docs.typesafe.ai/primitives) / [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)

### probability と confidence

- `probabilities`: Choiceの全候補、Scoreの全レベルに対する分布。合計は1。表示するパーセントの元データ。
- `confidence`: Choice / Scoreの分布のまとまりを表す0〜1の値。選択肢そのもののprobabilityとは異なる。
- `noul`: yesである確率。Noulには別のconfidenceフィールドがない。

このため、UIでは `未練 89%` と `confidence 0.78` を同じカードの別行に置く。`confidence 89%` を `未練である確率` と再解釈しない。[Confidence](https://docs.typesafe.ai/confidence)

## 4. 共通リクエスト形式

アプリ内部では、Jevへ次の形で渡す。質問IDは英語のstable keyにし、表示文言は日本語のlabel mapで管理する。

```json
{
  "state": {
    "text": "ユーザーが入力した短文",
    "mode": "love"
  },
  "model": "jev-latest",
  "questions": {
    "question_id": {
      "type": "choice",
      "instructions": "Judge `text` ...",
      "criteria": {
        "option_a": "...",
        "other_or_unclear": "..."
      }
    }
  }
}
```

`instructions` は質問IDに依存させず、必ず `text` の何を判定するかを明記する。Jevは文字列生成や説明生成に使わず、すべての出力先と意味を質問のcriteriaで閉じる。

### type別の `criteria` の形

3つのtypeで `criteria` のJSON型が異なる。本文書の各モードの質問表は可読性のため散文で書いているが、`questionCatalog` の実装では必ず下表の形へ変換する。

| Type | `criteria` のJSON型 | 制約 | 必須 |
|---|---|---|---|
| Choice | `map<string, string \| object \| array \| null>` | 最大255 options | Yes |
| Score | **`array<string \| object \| array>`**（低い→高いの順） | 最低2、最大10 levels | Yes |
| Noul | `{ "true": ..., "false": ... }` | yes/noの意味の説明 | No（省略可） |

[API reference](https://docs.typesafe.ai/api)

Scoreの `criteria` をmapで組み立てると422になる。**配列のindexがそのままレベル番号（0始まり）**であり、レスポンスの `legend` のキーと対応する。各モードの質問表で `0:` `1:` と書いている記述は、この配列の要素順を指す。

```json
{
  "love_signal_strength": {
    "type": "score",
    "instructions": "Judge how strongly `text` carries romantic meaning.",
    "criteria": [
      "No romantic meaning.",
      "Weak or context-dependent romantic meaning.",
      "Clear romantic meaning.",
      "Romantic meaning is the center of the text."
    ]
  },
  "relationship_ended": {
    "type": "noul",
    "instructions": "Does `text` read as a relationship that has already ended?",
    "criteria": {
      "true": "The text states or strongly implies the relationship is over.",
      "false": "The text does not support that reading, or the relationship reads as ongoing."
    }
  }
}
```

## 5. LOVEのQuestion設計

### State

```json
{
  "mode": "love",
  "text": "もう君のことは忘れたはずなのに"
}
```

すべての質問は「作者の実際の感情」ではなく「入力文面がそう読めるか」を判断する。

Noulは `romantic_frame` と意図的に重複させない。「別れ」「未練」という**フレームの識別**は `romantic_frame` の候補（`breakup` / `lingering`）が担い、Noulは `romantic_frame` が別の候補を選んだ場合でも独立に成立する**状態の判定**だけを聞く。かつて `is_breakup` と `relationship_ended`、`still_loves` と `has_lingering_feelings` の2組を別々に聞いていたが、前提の有無しか違わず、画面にほぼ同じ数字が並んで読者に矛盾と受け取られるため統合した。

### 質問一覧

| ID | Type | 判定 | Criteria / 定義 |
|---|---|---|---|
| `romantic_frame` | Choice | 主な恋愛的フレーム | `breakup`, `lingering`, `passionate`, `unrequited`, `long_distance`, `ambiguous`, `not_romantic`。一番近い1つ。 |
| `love_signal_strength` | Score | 恋愛的な含意の強さ | 0: 恋愛的含意なし、1: 弱い/文脈依存、2: 明確、3: 文の中心で強い。 |
| `is_passionate` | Noul | 熱愛・強い恋情の読み | true: 強く燃える恋愛感情が中心、false: その読みを支持しない。 |
| `is_unrequited` | Noul | 片思いの読み | true: 気持ちが一方通行、または相手の気持ちが示されない片思いとして読める、false: そう読めない。 |
| `is_long_distance` | Noul | 遠距離の読み | true: 物理的な距離・離れている状態が恋愛上の要素、false: その要素なし。 |
| `relationship_ended` | Noul | 関係が終わっている可能性 | true: 現在の関係が終了/断絶したと読める、false: 継続中または判断不能。曖昧な場合は高くしすぎない。 |
| `still_loves` | Noul | まだ好きの読み | true: 現在も恋愛感情が残っていると読める、false: 残っているとは読めない。 |

### UIへの変換

- `romantic_frame.choice` を主見出しにする。
- `romantic_frame.probabilities` は上位3候補を横棒で表示する。
- Noulはすべて独立した軸として表示し、複数のYESを許容する。
- `love_signal_strength` は「§8 Scoreの表示規則」に従う。scoreを独自にパーセント化しない。

## 6. SOCIALのQuestion設計

### State

```json
{
  "mode": "social",
  "text": "ChatGPT便利すぎてExcel開かなくなった"
}
```

### 質問一覧

| ID | Type | 判定 | Criteria / 定義 |
|---|---|---|---|
| `post_type` | Choice | 投稿の主な型 | `observation`, `humor`, `learning`, `opinion`, `question`, `complaint`, `promotion`, `other`。最も中心的な型を1つ。 |
| `casualness` | Score | カジュアル度 | 0: 形式的/硬い、1: 会話的、2: くだけたSNS口調。 |
| `discussion_level` | Score | 議論性 | 0: 議論をほぼ招かない、1: 意見交換の余地あり、2: 対立・議論を強く招く。 |
| `is_surprising` | Noul | 驚き・意外性 | true: 読者に驚きや意外性を感じさせる主張、false: その要素なし。 |
| `is_joke_like` | Noul | ネタらしさ | true: オチ、誇張、言葉遊び、笑いを狙った表現、false: それらを支持しない。 |
| `is_learning_or_discovery` | Noul | 学び・発見 | true: 知識共有、気づき、発見の共有として読める、false: その読みを支持しない。 |
| `invites_agreement` | Noul | 共感誘発 | true: 読者に「わかる」と同意・共感を求めるように読める、false: その読みを支持しない。 |
| `is_boastful` | Noul | 自慢っぽさ | true: 投稿者の優位性・成果・所有を誇示するように読める、false: そう読めない。 |
| `is_taunting` | Noul | 煽り | true: 他者を刺激・挑発・見下すように読める、false: その読みを支持しない。 |
| `is_reaction_bait` | Noul | 反応誘発 | true: 質問、誇張、オチ、挑発などで返信・引用・共感を誘う構造、false: そうした構造なし。 |

### UIへの変換

- `post_type` の上位候補を投稿の主ラベルとして表示する。
- Scoreのラベルは「§8 Scoreの表示規則」に従って `legend` から取り、値を「SNS影響力」とは呼ばない。
- 自慢・煽り・反応誘発は著者への断定評価ではなく、「この文面はそう読める？」という注記付きで表示する。

## 7. CITYのQuestion設計

### State

```json
{
  "mode": "city",
  "text": "家の前の防犯灯が切れてます",
  "jurisdiction": "安芸高田市"
}
```

**`directory_version` と `directory_effective_date` は state へ入れない。** モデルにとって意味を持たないIDと日付でトークンを使うだけで、候補の説明は criteria 側に入っているため判定に寄与しない。`jurisdiction` だけは「どの自治体への問い合わせとして読むか」が判定に効くため残す。

データバージョンはレスポンスの `city.directoryVersion` に必ず記録し、画面の根拠表示（§9）と観測ログで使う。

担当候補の `criteria` は、[CITY_DATA.md](CITY_DATA.md) の静的データからサーバー側で生成する。Jevへ渡す候補は `id` と短い業務説明に限定し、採用後の根拠表示は必ず同じ `id` を使ってローカルデータへjoinする。

### 質問一覧

| ID | Type | 判定 | Criteria / 定義 |
|---|---|---|---|
| `route_to` | Choice | 最初の担当候補 | **課・外部事業体レベル**の候補から一つ（係では分割しない。理由は後述）。`other_or_unclear`を必ず含める。 |
| `request_category` | Choice | 安定カテゴリ | `city-directory.json` の `categories` から生成する。候補一覧は [CITY_DATA.md](CITY_DATA.md) を single source of truth とし、本文書に列挙しない。 |
| `urgency` | Score | 緊急度 | 0: 通常、1: 近日確認、2: 当日確認が望ましい、3: 人身・重大な安全への即時リスクを含む可能性。サービスのSLAではない。 |
| `onsite_visit_likely` | Noul | 現地確認要否 | true: 現地の状態・位置・設備を確認する必要がありそう、false: 文面だけで一次案内できそう。 |
| `human_review_likely` | Noul | 人による確認要否 | true: 事実、資格、個人情報、例外、権限などの確認が必要そう、false: それらを含まない。 |
| `cross_department_likely` | Noul | 他課連携要否 | true: 複数課、支所、警察、県、広島県水道広域連合企業団などへの連携がありそう、false: 単一候補で閉じそう。 |
| `location_information_missing` | Noul | 位置情報不足 | true: 担当判断に町名、施設名、番地などが必要だが文面にない、false: 位置情報が十分、または位置不要。 |
| `emergency_signal` | Noul | 緊急性の明示 | true: 火災、事故、人身危険、犯罪進行中等の即時性を明示、false: そうした明示なし。アプリは通報を実行しない。 |

### `route_to` の粒度と候補キー

**`route_to` の criteria key は課レベルの `routingCandidateId` を使う。** [CITY_DATA.md](CITY_DATA.md) の `organizationUnitId` は課.係の粒度を持つが、これを直接 Choice の候補にしない。

理由は確率の分散である。Choiceの `probabilities` は合計1になるため、一つの課を3つの係へ分割すると、課としての確度が3つの小さい値へ割れる。危機管理課が78%で選ばれるはずの入力が26%×3になり、`confidence` も下がって「判断が割れています」という誤った表示を招く。係の特定はJevの仕事ではなく、選ばれた課の配下でローカルデータをjoinして解決する。

下記は初期の論理キー例である。

```text
crisis_management
general_affairs
secretary_public_relations
property_management
finance
policy_planning
dx_promotion
citizen_services
tax
environment_policy
human_rights_multicultural
social_welfare
child_family_center
health_promotion
insurance_medical
agriculture
forestry_fisheries
commerce_tourism
construction_management
construction_works
sewerage
water_enterprise
branch_office
other_or_unclear
```

課・係の実際の名称や所在はデータ更新で変わり得るため、Jevの質問文へハードコードせず、候補説明をデータから生成する。

### CITYの判定結果の扱い

1. `route_to.choice` で主候補を取得する。
2. `route_to.probabilities` の上位3件を表示する。
3. 上位候補ごとにローカルの `sourceRefs` をjoinし、課、係、分掌、公式URL、取得日、有効日を表示する。
4. `human_review_likely.noul`、`location_information_missing.noul`、`emergency_signal.noul` を機械的な手続き開始条件にしない。
5. `confidence`が低い、`other_or_unclear`が上位、または出典がない場合は「候補を絞り切れない」と表示する。

## 8. レスポンスのアプリ内契約

TypeSafeの生レスポンスはサーバーからブラウザへそのまま返さず、UIが必要とする最小形式へ正規化する。

```ts
type JudgeResponse = {
  requestId: string;
  mode: "love" | "social" | "city";
  model: string;
  latencyMs: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  };
  results: ResultCard[];
  city?: {
    directoryVersion: string;
    sources: CitySource[];
  };
};

type ResultCard =
  | {
      id: string;
      label: string;
      kind: "choice";
      selected: string;
      options: Array<{ key: string; label: string; probability: number }>;
      confidence: number;
    }
  | {
      id: string;
      label: string;
      kind: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      id: string;
      label: string;
      kind: "noul";
      yesProbability: number;
    };
```

### Scoreの表示規則

公式のScore answerは、`score` が**レベル間に着地し得る確率加重値**で、`legend` は整数レベルをキーにしたラベルである。

```json
{ "score": 1.05, "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
  "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 }, "confidence": 0.92 }
```

`score` から直接 `legend` を引けないため、表示規則を次のように固定する。

1. **メーターの位置**は `score` をそのまま使う（1.05なら0〜2スケールの52.5%地点）。丸めない。
2. **ラベル文言**は `probabilities` が最大のレベルの `legend` を使う（上例なら `"1"` → `Frustrated`）。`Math.round(score)` は使わない。分布が二峰性のとき、丸めた値が最大確率のレベルと一致しない場合があるため。
3. メーターの両端に最小レベルと最大レベルの `legend` を添え、尺度の意味を常に示す。
4. `score` を100点満点や独自のパーセントへ再計算しない。
5. 最大確率のレベルが複数並んだ場合は、小さいレベル番号を採る。

**画面には `legend` をそのまま出さない。** `criteria` は英語で書く方針のため（Jevは英語が主な学習言語であり、判定精度を優先する。[Models](https://docs.typesafe.ai/models)）、`legend` には送った英語がそのまま返る。日本語UIに英語が混在するのを避けるため、質問定義と対になる `scoreLabels`（レベル順の日本語配列）を持ち、表示にはそちらを使う。

`scoreLabels` は `criteria` と同じ長さ・同じ順序でなければならない。ずれると別レベルの説明を表示することになるため、次の2箇所で検証する。

1. contract test: 全Score質問について `scoreLabels[id].length === criteria.length`
2. 正規化時: レスポンスの `legend` のキー数と `scoreLabels` の長さが一致すること。不一致は契約違反としてエラーにする

### usage とコスト

`usage` は公式API referenceで `required` とされており、`input_tokens` と `output_tokens` を持つ。型は防御的にoptionalのまま保持してよいが、欠落は異常系として扱う。`output_tokens` は課金対象外（output無料）なので、コスト推計の隣に並べるときは課金に寄与しないことを明示する。`estimatedCostUsd`はusageが返った場合だけ計算する。公式の現行単価を環境変数 `JEV_INPUT_PRICE_PER_MILLION_TOKENS` で上書き可能にし、画面では「推計」と表示する。

```text
estimatedCostUsd = input_tokens / 1_000_000 * 0.042
```

## 9. Timeout、retry、エラー

### SDK

推奨は TypeSafe 公式 JavaScript SDK (`@typesafe-ai/sdk`)。公式SDKには `TypeSafeClient`、typed question helpers、例外型、retry設定、timeout設定がある。`TypeSafeClient` の設定仕様では、デフォルトtimeoutは1試行10,000msで、per-call overrideも可能と記載されている。[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) / [TypeSafeClient API](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient)

### SDKのretry既定値（公式記載値）

`RetryPolicy` の既定値は次のとおり。アプリのtimeout予算はこの値と整合させる必要がある。[RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy)

| 項目 | 既定値 |
|---|---|
| `maxRetries` | 2（初回を含めて最大3試行） |
| `backoffInitialMs` | 500（`backoffMaxMs` 5,000まで倍化） |
| `backoffJitter` | 0.25（各backoffから最大25%を減算） |
| `httpStatuses` | 408、429、500〜599（529を含む） |
| `apiTimeoutError` | true（**timeoutもretryされる**） |
| `apiConnectionError` | true（**接続失敗もretryされる**） |
| `respectRetryAfter` | true（`maxRetryAfterMs` 60,000まで） |

### MVP設定

1試行timeoutは**3,500ms**、total request budgetは12,000msとする。通常時はちょうど3試行が予算に収まる。

```text
3500 + 500 + 3500 + 1000 + 3500 = 12,000ms
試行1  backoff 試行2  backoff 試行3
```

公式デフォルトの10,000ms、あるいは以前の推奨値だった8,000msを1試行に使うと、3試行分で25,500msとなり12,000msの予算では試行2が途中で打ち切られ試行3が一度も実行されない。retryを設計に含めるなら1試行を短くする必要がある。

#### total budget の性質（実装時の誤解を避けるため）

上の12,000msは**通常時の計算であり、3試行の完了を保証しない**。3点を明確にしておく。

1. **12,000msはAbortSignalによるハード上限である。** SDKのtimeoutは1試行あたりにしか効かず、`RequestOptions.timeout` の説明にも「there is no total retry budget」と明記されている。総予算はSDKの機能ではなくアプリ側で `AbortController` を用意して強制する。

2. **3試行が必ず実行されるとは限らない。** SDKは `respectRetryAfter: true` かつ `maxRetryAfterMs: 60000` なので、上流が `Retry-After` で長い待機を指示した場合、固定backoff（500ms / 1,000ms）ではなくその指示に従う。429が返って `Retry-After: 30` が付けば、試行1の後で予算を使い切る。

3. **Retry-After の待機も総予算で中断する。** `RequestOptions.signal` は「Cancellation signal for the request **and pending retries**」と定義されており、渡したAbortSignalは送信中のリクエストだけでなく待機中のretryも打ち切る。したがって予算超過時は待機ごと中断され、アプリは504 / `UPSTREAM_TIMEOUT` を返す。

[RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy) / [RequestOptions](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions)

- 429 / 529 / 408 / 5xx: SDKの指数backoffと `retry-after` 尊重を利用する。アプリ側で同じretryを二重実装しない。
- 408 / 504: SDKのretry対象に408が含まれるため、ここへ残るのは「retryしても回復しなかった」場合である。障害ではなく時間切れとして `UPSTREAM_TIMEOUT`（504）へ写し、再試行可能として表示する。
- timeout / 接続失敗もSDKが既定でretryする。アプリ側の「1回で失敗扱い」は、**SDKがretryを使い切った後**のユーザー向け挙動を指す。
- 401: 設定エラー。ユーザーには接続失敗、サーバーログにはキー未設定/認証失敗の種別だけを記録し、キー値は記録しない。
- 422: 質問定義またはリクエスト構築のバグ。ユーザーには再試行を促さず、一般的なエラーを表示し、監視対象にする。
- 接続失敗 / SDK timeout: SDKのretryを使い切った時点で失敗として終了し、ユーザーの入力を保持して再試行ボタンを出す。アプリから再送はしない。
- 不明な5xx: 再試行済みならJev障害表示。レスポンス本文はクライアントへ転送しない。

公式APIが文書化しているエラーは401、422、429、529。その他のHTTPステータスは「未知の上流エラー」として安全側に扱う。[API reference / Errors](https://docs.typesafe.ai/api)

## 10. 入力・出力の検証

- クライアントとサーバーの両方で mode enum を検証する。
- サーバーで Unicode code points 基準の280文字制限を検証する。実装では日本語の合成文字・絵文字の扱いをテストする。
- 空白だけ、制御文字のみ、JSON bodyでないリクエストは400。
- stateにユーザー入力と固定モード文字列以外の任意オブジェクトを受け付けない。
- **送信前**に、組み立てた質問の `criteria` が type ごとの形（Choice=map、Score=array、Noul={true,false}）に一致することを検証する。Scoreは2〜10要素、Choiceは255候補以下。ここで弾けば422を事前に防げる。
- レスポンスの `answers` のtype、probability範囲、Scoreのlegend、必須質問キーをサーバー側で検証する。
- Scoreの `legend` のキー数が送信した `criteria` の要素数と一致することを検証する。
- probabilityの合計は浮動小数誤差を許容した範囲で検証し、異常なら結果を表示せず再試行可能なエラーにする。
- `choice`がcriteriaに存在しない場合はデータ/SDKの契約違反としてエラーにする。

## 11. 実機確認が必要な項目

以下は公式ドキュメントから概形は確認できるが、本プロジェクトの実装前に実際のAPIキーで確認する。

- `@typesafe-ai/sdk` のインストール可能な現行バージョンと Node.js runtime compatibility
- 日本語（特にひらがな、漢字、絵文字、短い歌詞風表現）の確率の安定性
- CITY候補数を増やしたときの入力token数とlatencyの実測（公式は「質問を足しても応答時間はほとんど変わらず、追加分のトークン代だけ」としており、現行の1モード7〜10問は想定内。上限そのものより候補説明の長さが効く）
- 日本語の質問文での Choice / Score / Noul の相対精度
- 429 / 529時のSDKのretryとbackoffの**実測値**（既定値は§9に記載済み。実測との差分だけを見る）
- Vercelの `maxDuration` 既定値とプラン上限、レスポンスヘッダ、ログの扱い（§9のtotal budget 12,000msより大きい値を明示設定する必要がある）
- 公式単価と実アカウントの請求単位

## 12. 出典と更新

主要な一次出典:

- [TypeSafe AI Introduction](https://docs.typesafe.ai/introduction)
- [Quick start](https://docs.typesafe.ai/introduction/quickstart)
- [Primitives](https://docs.typesafe.ai/primitives)
- [Choice](https://docs.typesafe.ai/primitives/choice)
- [Score](https://docs.typesafe.ai/primitives/score)
- [Noul](https://docs.typesafe.ai/primitives/noul)
- [Confidence](https://docs.typesafe.ai/confidence)
- [API reference](https://docs.typesafe.ai/api)
- [Models](https://docs.typesafe.ai/models)
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

実装時はこの文書の上部の調査日、モデルID、単価、API shapeを更新し、API仕様に変更があった場合は `docs/IMPLEMENTATION_PLAN.md` の確認項目を再実行する。
