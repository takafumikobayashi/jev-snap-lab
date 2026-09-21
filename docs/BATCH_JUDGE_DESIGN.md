# BATCH JUDGE Design

## 1. 位置づけ

BATCH JUDGEは、短い文章を数十件まとめてJevへ渡し、意味判断を一度に構造化するモードである。**未実装。** §4.6 に Phase 12 の実測があり、方式は決まっている。

既存モードとJevの使い方が逆になる。

```text
SPEC FIND    少数のQuery  × 多くのKnowledge  -> 読むべき根拠を探す
BATCH JUDGE  多数のInput  × 少数の判断基準    -> 大量の意味判断を高速に行う
```

同じLabで両方を測り、**どの問題構造でSystem One Modelが効くのか**を比較できる状態にすることが目的である。「AIが文章を書く」デモにはしない。

## 2. 非目的

- 個人情報該当性の正式な判定
- 「安全」「送信してよい」の保証（§3.1）
- 法的・行政的な判断
- DX施策の自動決定、自動承認、自動実行
- 日時文字列の厳密なparse
- Jevによる長文生成

BATCH JUDGEが返すのは**仕分けの候補**であり、確定ではない。

## 3. 判定テーマ

初期版は3テーマ。

### 3.1 PRIVACY「AIにそのまま入れてよい？」

判断の対象は**これから貼り付けようとしている文章そのもの**である。「〜をまとめたい」という作業の説明ではない。fixture もその形にしてある。

判定の基準は次の通り。**作業の意図では判定しない。**

> この文をそのまま渡したとき、(a) 特定の個人が分かる / (b) 特定の個人の事情が分かる / (c) 慎重に扱うべき事情が分かる、のいずれかが成り立つか。

Jevへは原子的な問いに分けて聞く。

- `identifies` 特定の個人が絞り込めるか（氏名、住所、電話、メール、番号、1人しかいない役職、属性の組み合わせ）
- `personal` 特定の個人の事情を述べているか
- `sensitive` 慎重に扱うべき情報に触れているか

**判定は `identifies` か `personal` のどちらかが閾値以上、とする。3軸の最大値を使わない。** `sensitive` は話題の語に反応するため、「生活保護受給世帯の一覧をExcelから抽出しました」のように誰も特定できない文が sensitive=0.96 になる。実測での比較（§4.6）:

| 判定ルール | 一致 | 見逃し | 過検知 |
|---|---|---|---|
| `max(identifies, personal, sensitive)` ≥ 0.5 | 92% | 0 | 4 |
| **`identifies` ≥ 0.5 または `personal` ≥ 0.5** | **96%** | **0** | **2** |

個人が出てこない文を要確認にしても、利用者が警告を無視するようになるだけである。`sensitive` は判定には使わず、要確認になった理由の内訳として画面へ出す。

#### 「安全」と言わない

**結論の片方に `safe` という語を使わない。** コード上の値は `no_signal` である。`safe` は安全の保証と読まれ、このモードが出せる結論ではない。

`no_signal` が意味するのは一点だけである。

> このモードが見る範囲で、明確な要確認シグナルが検出されなかった

次のいずれでもない。**設計・コード・画面のどこでもこの区別を崩さない。**

| 言えないこと | 理由 |
|---|---|
| 法的に個人情報に該当しない | 該当性の判断は条文と事実関係に依る。確率では出ない |
| Jevや他のAIサービスへ送ってよい | 送信可否は組織の規程・契約・条例が決める |
| 個人情報が含まれていない | 見落としは起こる。実測の見逃し0は50件のfixtureに対する値で、一般の入力への保証ではない |

画面の文言も `安全` / `OK` / `そのまま入力` としない。**`要確認シグナルなし` / `要確認` の二値に留める。** 「そのまま入力してよい」と読める表現は、このモードが出せない保証を出している。

電話番号、メールアドレス、マイナンバーのように決定的な規則で検出できるものは、将来regex/DLPとのhybridにできる設計にする。**Jevを唯一の制御にしない。** この点は注意文としても画面に常時出す（SPEC FINDの「適合度（実験値）」と同じ水準）。

#### このモード自身が入力をJevへ送る

**「AIにそのまま入れてよい？」を判定するために、入力文をAIへ送っている。** 利用者が個人情報を含む文を試しに貼れば、その文はJevへ送られる。判定より先にそれが起きる。

画面には次を**入力欄の手前に**常時出す。判定結果と一緒に出しても遅い。

> 入力した文章は判定のためにTypeSafe AIへ送信されます。実際の個人情報は入力しないでください。

デモ用の例文を用意し、利用者が自分の文章を貼らなくても動きを確認できるようにする。入力した文章を保存しないことは既存モードと同じだが、**送信していることは別に伝える。**

### 3.2 DEADLINE「いつまでに対応が必要？」

期限の明示、急ぎ度、対応期限の意味カテゴリを判断する。

```text
NOW / TODAY / SOON / LATER / NO_DEADLINE
```

**基準日を state で与える。** 「9月25日17時までに提出してください」のような絶対日付は、今日が何日かを知らなければどの区分にも決まらない。基準日を持たないまま gold を付けると、**Jevの誤判定と gold の不整合を区別できなくなる。**

日付はアプリが持つ Knowledge であり、Jev に推測させるものではない（§9）。fixture は `referenceDate` を持ち、検証で必須にしている。本番では実行時の日付を入れる。

**calendar parserを作るモードではない。** Jevにさせるのは「基準日から見てどれくらい先か」という意味判断だけで、日付文字列の厳密なparseはさせない。必要ならアプリ側のparserとのhybridを検討する。

基準日が実際に使われていることは実測で確かめている（§4.6）。

### 3.3 DX JUDGE「この業務課題、何から手を付ける？」

短い相談文から、**まず何をするか**を3択で仕分ける。

```text
BPR      業務のやり方を見直せば解ける（やめる・減らす・様式や承認を変える）
DIGITAL  デジタルで置き換えれば解ける（自動化・システム・AIの仕分け）
NEITHER  どちらでもない（人・体制・制度の問題）
```

**当初は5つの独立Noulだった。** 複数が同時に高くてよい、という設計判断だったが、実測で軸が独立していなかった。goldが真の群と偽の群の平均差は0.06〜0.20しかなく、どの課題もどの軸も0.5〜0.8に固まっていた。「検討に値する」としか言えていない。

| 軸 | gold真 mean | gold偽 mean | 差 | 最良閾値での一致 |
|---|---|---|---|---|
| bpr_first | 0.61 | 0.52 | 0.10 | 0.45 で 70% |
| automation | 0.79 | 0.60 | 0.19 | 0.75 で 86% |
| ai_candidate | 0.68 | 0.58 | 0.10 | 0.75 で 84% |
| system_change | 0.70 | 0.49 | 0.20 | 0.60 で 76% |
| human_review | 0.70 | 0.64 | **0.06** | 0.85 で 76% |

最良閾値が0.45〜0.85にばらけており、ひとつの校正では合わない。3択へ変えたところ、一致率は軸ごと38〜68%から**80%**になり、質問数も250問から50問へ減った（§4.6）。

**解決策の網羅ではなく、着手順の判断にする。** 「否」の受け皿として `NEITHER` を置き、人・体制・制度の問題を無理にBPRかデジタルへ寄せない。正式なDXコンサルティング判断ではない。

## 4. 実測が要る前提

### 4.1 「件数 × 軸数」で質問数が決まる

§3の3テーマは軸の数が違う。**1リクエストの質問数は件数そのものではない。**

| テーマ | 1件あたりの質問 | 50件での質問数 |
|---|---|---|
| PRIVACY | 3（原子的なNoul） | 150 |
| DEADLINE | 1（Choice） | 50 |
| DX JUDGE | 1（Choice） | 50 |

当初は DX を5つの独立Noulにしていて250問になる想定だった。§3.3 の通り3択へ変えたため、実装が必要とする最大は150問である。ただし**壁がどこにあるかは別に測った**（§4.6）。

**測定済みの上限は40問だった**（[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §8.1）。250問はその6倍で、外挿できなかった。そのため Phase 12 で測った。結果は §4.6。

**benchmarkは「件数」ではなく「件数 × 軸数」で行う。** 50×1 と 50×5 は別物として測る。

### 4.2 分割は最後の手段

SPEC FINDの実測で、同じ候補数を1問ずつ分けて送ると**latencyが22倍、入力tokenが2.5倍**になった（stateを毎回送り直すため）。最初からchunkしない。

ただしこの数字はそのままBATCH JUDGEへ持ち込めない。理由と実測は §4.5。

### 4.3 参照はオブジェクトのキーで

配列インデックス参照は候補が20件を超えたあたりから確率が隣接インデックスへ滲む。コーパスを固定して正解の位置だけを変えると分布が変わることから、候補の似すぎではなく参照の取り違えと分かっている。

```text
配列index   2位との差 0.00〜0.01  / 0.9以上が5〜7件
キー参照    2位との差 0.77〜0.78  / 0.9以上が1件
```

BATCH JUDGEでも `case_001` のような安定キーを使う。

### 4.4 benchmarkで見るもの

```text
Pattern A  50件を1 stateへ置き、全質問を1リクエストで評価
Pattern B  一定数ずつchunk
Pattern C  複数inputをまとめた別の構造
```

各パターンで測る。

- 成立する最大の「件数 × 軸数」
- latency（p50 / p95）
- input / output tokens、推計コスト
- answerの欠落
- **probabilityの混線**（隣の事例の判断が漏れていないか）

混線の検出は、SPEC FINDと同じ方法を使う。**正解が分かっている事例の位置だけを変えて、分布が変わるかを見る。** 200が返ることは、参照が効いた証明にならない。

**同じ並びで2回投げた差も測る。** これが無いと、逆順との差が位置のせいなのか上流のゆらぎなのか区別できない。

### 4.5 分割のコストは state の大きさで決まる

SPEC FIND では分割が latency 22倍・入力token 2.5倍になった。state が15,000字のコーパスで、chunkごとに丸ごと送り直していたためである。

BATCH JUDGE の state は短文50件（約1,100字）しかない。同じ理屈は効かず、実測でも分割の追加コストは入力tokenで2〜8%に留まった（§4.6）。**「分割は高い」は BATCH JUDGE には自動的に当てはまらない。** それでも既定は Pattern A にする。tokenでもlatencyでも負けないためである。

### 4.6 実測（Phase 12）

2026-09-21、model `jev-1.13.0`。測定は [src/lib/server/batch-judge.live.spec.ts](../src/lib/server/batch-judge.live.spec.ts)、質問の定義は [batch-questions.server.ts](../src/lib/server/batch-questions.server.ts)（§5.5）。

対象のfixture。**fixtureを直せば変わる**ので、以下の数値がどのデータに対するものか辿れる。

```text
privacy=sha256-5d4fede871aa763f  deadline=sha256-449f388d77f53a5f  dx=sha256-fee027ba72e9851a
```

**判定基準は測る前に決めた。** 1リクエスト16,000ms以内（`/api/judge` の `REQUEST_BUDGET_MS`）、answer欠落0、並び替えによる確率の差0.10以内。

**以下の一致率はすべて暫定ラベルに対する値である**（`labelStatus: 'draft'`、§5）。**精度ではない。** latency・token・成立範囲はラベルに依らないので、そのまま読んでよい。

#### 成立範囲

壁は質問数ではなく**token側**にある。質問文の長さで成立する問数が変わる。

| 構成 | 質問数 | 入力token | latency | 結果 |
|---|---|---|---|---|
| 短い質問（DX 5軸、150件） | 750 | 65,269 | 2,309ms | 欠落0 |
| 短い質問（DX 5軸、200件） | 1,000 | — | — | **400 BadRequest** |
| 長い質問（PRIVACY 3軸、100件） | 300 | 36,370 | 1,129ms | 欠落0 |
| 長い質問（PRIVACY 3軸、200件） | 600 | — | — | **400 BadRequest** |

750問が通って600問が落ちる。**問数で上限を決めてはならない。** 65,000 tokens 付近が境で、リクエスト上限64k tokensとほぼ一致する（https://docs.typesafe.ai/models）。

実装が必要とする最大は PRIVACY の150問（50件 × 3軸、約16,000 tokens）で、上限の約1/4である。

#### Pattern の比較（1回あたり）

| | 質問数 | リクエスト | 入力token | 実時間 |
|---|---|---|---|---|
| A privacy 50×3 | 150 | 1 | 18,125 | 981ms |
| B privacy chunk | 150 | 4 | 18,965 | 921ms |
| A deadline 50×1 | 50 | 1 | 11,083 | 687ms |
| B deadline chunk | 50 | 2 | 11,363 | 801ms |
| A dx 50×1 | 50 | 1 | 10,793 | 421ms |
| B dx chunk | 50 | 2 | 11,073 | 882ms |

**Pattern A を採る。** 入力tokenは分割すると2〜8%増える。実時間は質問数が少ないうちは拮抗するが、当初の DX 5軸（250問）で測ったときは分割が2.6倍遅かった（A 763ms / B 2,022ms）。勝つ場面が無い。

latencyは質問数にほぼ比例しない。50問421ms に対し150問981ms、750問でも2,309msである。

#### Pattern C（軸の構造を変える）

| | 質問数 | 一致 |
|---|---|---|
| **deadline 1 Choice** | 50 | **96%** |
| deadline 5 Noul へ展開 | 250 | 82% |
| **dx 1 Choice（3択）** | 50 | **80%** |
| dx 3 Noul へ展開 | 150 | 74% |

**排他的なカテゴリは Choice が強い。** deadline を独立Noulへ展開すると `soon` と `later` のように隣り合う区分が同時に高くなり、14ポイント落ちた。DX も同じ向きで、3択のほうが6ポイント良い。

DX の混同は一箇所に集まっている。

```text
内訳  bpr:12/19  digital:22/24  neither:6/7
混同  bpr→digital=6  digital→bpr=2  bpr→neither=1  neither→bpr=1
```

BPRとデジタルの境界がほぼ全てで、これは判断そのものが難しい部分である。`neither` は7件中6件当たっており、「否」の受け皿は機能している。

#### 基準日

絶対日付を含む3件について、文はそのままに基準日だけを動かした。**stateへ置くだけでは、使われている証明にならない。**

```text
基準日シフト 2026-09-21（月） -> 2026-09-25（金）
  deadline_021  9月25日17時までに提出してください      soon  -> today   動いた
  deadline_043  9月30日までにご提出ください            soon  -> soon
  deadline_049  10月15日までに報告書をまとめてください  later -> later
```

動くべき1件だけが動いた。9月25日は基準日9/21から見れば同じ週の金曜（SOON）、9/25から見れば当日（TODAY）である。残る2件は基準日が4日動いても区分が変わらない位置にあり、変わらないのが正しい。

DEADLINE の一致率は基準日の追加前後で94%のまま変わっていない。入力tokenは1回あたり11,083から12,109へ9%増える。

#### PRIVACY の判定ルール

一致率は非対称である。**見逃し（個人情報を見落とす）と過検知（安全な文を要確認にする）を分けて数える。**

| ルール | 0.3 | 0.5 | 0.7 | 見逃し | 過検知 |
|---|---|---|---|---|---|
| `max(3軸)` | 88% | 92% | 90% | 0 | 4 |
| `identifies` のみ | 84% | 80% | 82% | — | — |
| **`identifies` または `personal`** | 92% | **96%** | 94% | **0** | **2** |
| `identifies` または (`personal` かつ `sensitive`) | 94% | 92% | 92% | — | — |

どのルールでも**見逃しは0**だった。差が出るのは過検知である。採用したルールで残る2件は、どちらも「個人情報を含む」と「個人情報に言及する」の境界にある。

```text
過検知 privacy_041  id=0.31 pers=0.87 sens=0.68  市長への手紙に、実名で近隣トラブルの相談が書かれていました。
過検知 privacy_043  id=0.53 pers=0.28 sens=0.37  甲市青葉町の空き家について、所有者の氏名と連絡先を調べたい。
```

どちらも安全側へ倒した誤りであり、この用途では許容できる。

#### probabilityの混線

**同じ並びで2回投げた差を先に測った。** これが無いと、逆順との差が位置のせいか上流のゆらぎか区別できない。PRIVACY の50件 × 3軸（150問）で測っている。

| | 平均差 | 最大差 | 0.10超 | 0.5をまたぐ反転 |
|---|---|---|---|---|
| 同じ並びで2回 | 0.009 | 0.080 | 0/150 | 2 |
| 逆順 | 0.032 | 0.400 | 13/150 | 6 |

**位置に依存する成分はある。** 逆順の平均差はゆらぎの3.5倍で、判定基準の0.10を13件が超えた。ただし配列インデックス参照で起きた「2位との差0.00〜0.01」のような崩れ方ではない。最大差0.400が出たのは `privacy_029`（「高橋さんのお子さんが不登校で…」）の `identifies` で、元の値が0.47と境界にある事例である。

**判定が変わったのは150件中6件。** PRIVACY の3軸は分離が良いため、確率が動いても二値の結論はほとんど動かない。当初の DX 5軸で測ったときは、同じ並びで2回投げるだけで250件中11件（4.4%）が0.5をまたいで反転していた。**分離の悪い軸を閾値で切ると、位置を変えなくても揺れる。**

### 4.7 実測から決めたこと

- Pattern A（1リクエスト）を既定にする。分割しない
- **上限は質問数ではなくtokenで見る。** 750問が通って600問が落ちた。境は約65,000 tokens
- 実装が必要とする最大は150問（PRIVACY 50件 × 3軸）。上限の約1/4
- **排他的なカテゴリは Choice。** DEADLINE 96%、DX 80%。独立Noulへ展開すると14ポイント / 6ポイント落ちる
- **DEADLINE は基準日を state で与える。** 絶対日付は基準日なしにどの区分にも決まらない
- **PRIVACY は3軸の最大値で二値化しない。** `identifies` または `personal` が0.5以上、とする（96%、見逃し0、過検知2）
- 分離の悪い軸を閾値で切らない。DX の5軸版は、同じ並びで2回投げるだけで4.4%が反転していた

## 5. Dataset

各テーマ30〜50件のfixtureを作る。

```ts
type BatchJudgeCase = {
	id: string;
	text: string;
	gold: unknown;
	difficulty?: 'easy' | 'medium' | 'hard';
	note?: string;
};
```

DEADLINE のデータセットは `referenceDate` を持つ。**gold を決めた日が分からないと、絶対日付を含む事例は再現しない**（§3.2）。

**Jev自身が作った答えをgoldにしない。** 曖昧なケースも意図的に入れる。

実体は `data/batch/{privacy,deadline,dx}.json`（各50件）。読み込み時の検証は [batch-dataset.server.ts](../src/lib/server/batch-dataset.server.ts) にあり、goldの綴り違いを「不一致」として集計しないようにしている。

1事例の上限は**画面の入力上限をそのまま使う**（`MAX_INPUT_CODE_POINTS`）。別の数字を書くと必ず片方が古くなる。数え方も入力検証と同じ `countCodePoints` に揃える。`String.prototype.length` は UTF-16 の code unit 数なので、サロゲートペアの漢字を2文字と数え、画面で入る文章が fixture に入らなくなる。

> **現在のラベルは下書きである（`labelStatus: 'draft'`）。** Phase 11 で用意した3ファイルのラベルはClaudeが起草したもので、人手の確認を経ていない。Jevの出力をgoldにしてはいないが、人が通しで見たわけでもない。**Phase 13 の実装前に人が全件を確認すること。**
>
> 状態は文章ではなく `data/batch/*.json` の `labelStatus` が持つ。文章で書くと必ず docs と食い違う。実際に README・ARCHITECTURE・IMPLEMENTATION_PLAN の3箇所が「人手で付けた正解ラベル」のまま残っていた。`reviewed` へ変えるのは人が全件を見たときだけで、fixture を作り直したら `draft` へ戻す。
>
> **`draft` のあいだ、一致率を「精度」と呼ばない。** §4.6 の96% / 94% / 80% はいずれも暫定ラベルに対する実測値である。
>
> PRIVACY は一度作り直している。最初のfixtureは「〜をまとめたい」という作業の説明文だったが、このモードが判断するのは貼り付けられる文章そのものなので、中身が個人情報である形へ置き換えた。氏名・住所・電話番号・メール・マイナンバーはすべて架空で、市名は既存テストと同じ「甲市」、電話は未割当の `0000` ブロック、メールは RFC 2606 の `example.jp` を使っている。
>
> DX は利用者が目視で確認し、方向性として妥当と判断している（2026-09-21）。その上で5軸から3択へ作り直したため、**新しいgoldラベルは再度の確認が要る**。

## 5.5 Jevとの契約

質問ID、primitive、instructions、criteria、stateの参照パスは [batch-questions.server.ts](../src/lib/server/batch-questions.server.ts) で決める。**評価用のコードへ質問文を書き写さない。** 書き写すと、片方だけ直したときに「測ったもの」と「動くもの」がずれる。§4.6 の実測はこのモジュールを通している。

### 5.5.1 質問ID

```text
<caseId>__<axis>        privacy_022__identifies / deadline_021__class / dx_001__first_move
```

質問IDはJevへ送られない。答えを事例へ戻すための対応表でしかないので、**IDの文字列から事例を復元しない。** 組み立てたときの `Map<質問ID, 事例ID>` をそのまま持ち回る。

### 5.5.2 state

```json
{
  "mode": "batch",
  "theme": "deadline",
  "referenceDate": "2026-09-21",
  "cases": {
    "deadline_021": { "text": "9月25日17時までに提出してください" },
    "deadline_043": { "text": "9月30日までにご提出ください" }
  }
}
```

事例は**オブジェクトのキー**で置く（§4.3）。`referenceDate` は持つテーマだけ入れる。判定に寄与しない値をstateへ入れない。

**stateへ入れるのは `id` と `text` だけである。**

```ts
type BatchJevCase = Pick<BatchCase, 'id' | 'text'>;
```

`gold` は答えそのもの、`note` は「属性の組み合わせで個人が絞られうる」のような根拠で、どちらも渡せば一致率が測れなくなる。`difficulty` も人手の評価であって判断材料ではない。

**dataset を丸ごと state へ渡す書き方に変えると静かに漏れる。** 型だけでは守れないので、組み立てた state を `id` と `text` だけから作った期待値と**完全一致**で比べている（[batch-questions.spec.ts](../src/lib/server/batch-questions.spec.ts)）。

部分一致では検査にならない。実際に `privacy_023` の note「氏名と連絡先」が `privacy_043` の本文「…所有者の氏名と連絡先を調べたい。」の一部と一致し、正しい実装が漏えいとして落ちた。

### 5.5.3 テーマごとの質問

**PRIVACY** — Noul 3問／件。`identifies` と `personal` が判定、`sensitive` は理由の内訳（§3.1）。

```json
{
  "privacy_022__identifies": {
    "type": "noul",
    "instructions": "Does `cases.privacy_022.text` single out one particular private individual?",
    "criteria": {
      "true": "One particular person can be pinned down from it — by name, address, phone number, email address, an identification number, an internal staff or case number, a role held by one person, or a combination of attributes narrow enough to isolate one person.",
      "false": "No particular private individual can be pinned down. Aggregate figures, organisations and companies, places without a household, and public figures acting in their official capacity do not count."
    }
  }
}
```

**DEADLINE** — Choice 1問／件。5択。`referenceDate` を参照させる（§3.2）。

```json
{
  "deadline_021__class": {
    "type": "choice",
    "instructions": "How soon does `cases.deadline_021.text` ask for a response? Today's date is given in `referenceDate`; read any explicit date against it. Judge how far off the deadline is, not the calendar arithmetic itself.",
    "criteria": {
      "now": "The text asks for action right away, or says a deadline has already passed.",
      "today": "The text points at the end of the working day, tonight, or first thing tomorrow morning.",
      "soon": "The text points at this week, next week, or the end of this month.",
      "later": "The text points beyond this month: next month, this quarter, the fiscal year, or later.",
      "none": "The text expresses no time pressure at all."
    }
  }
}
```

**DX JUDGE** — Choice 1問／件。3択（§3.3）。

```json
{
  "dx_001__first_move": {
    "type": "choice",
    "instructions": "For the problem described in `cases.dx_001.text`, what should be taken up first?",
    "criteria": {
      "bpr": "The work itself should be questioned first. The form, the rule, the approval chain, or the duplication is the problem, and a tool laid over it would preserve that problem.",
      "digital": "The work itself is needed and a tool would do it: copying, aggregating, searching, transcribing, sending, drafting, or sorting by meaning.",
      "neither": "Neither fits. It is a matter of people, staffing, training, or a rule set outside this organisation, and has to be settled before any tool or redesign is chosen."
    }
  }
}
```

**Score は使わない。** 段階を測る軸が無いためである。使う理由ができたら、ここへ根拠と一緒に足す。

### 5.5.4 answer が欠けたときの扱い

**リクエスト全体を失敗させる**（`UPSTREAM_UNAVAILABLE`）。一部だけ返して残りを「判定できなかった」と描くほうが親切に見えるが、PRIVACY で欠落が `要確認シグナルなし` と並んで表示されると、**見ていない事例を安全に見せる**ことになる。

欠落は想定される状態ではない。実測では150問・250問・300問・500問・750問のいずれでも1件も出ていない（§4.6）。異常として扱い、静かに欠けたまま見せない。再実行は数百msで済む。

次も同じく契約違反として失敗させる。**200が返ることは、契約が守られた証明にならない。**

| 条件 | 例 |
|---|---|
| `answers` がオブジェクトでない | 配列、`null` |
| 送っていない質問の answer がある | 対応表が壊れている |
| `type` が `noul` でも `choice` でもない | `score` が返る |
| `noul` が 0〜1 の数値でない | `1.4`、文字列 |
| `choice` が空文字 | — |

例外メッセージには**件数だけ**を出し、入力本文を入れない。

### 5.5.5 レスポンス

```ts
type BatchJudgeResponse = {
	requestId: string;
	mode: 'batch';
	theme: BatchTheme;
	model: string;
	datasetFingerprint: string;   // 内容から計算する。手書きのバージョンは古くなる
	referenceDate?: string;       // DEADLINE のときだけ
	caseCount: number;
	questionCount: number;
	latencyMs: number;
	usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
	results: BatchJudgeResult[];
};

type BatchJudgeResult = {
	caseId: string;
	verdict: string;                                   // テーマごとの結論
	signals: { key: string; probability: number }[];   // 判定に使った確率をそのまま持つ
	gold?: string;                                     // fixture を評価したときだけ
	agrees?: boolean;
};
```

`signals` に確率をそのまま持つのは、**閾値を変えるために再実行しなくてよいようにする**ためである。PRIVACY の `sensitive` のように判定には使わないが理由として出すものも含む。

`datasetFingerprint` は fixture の内容から計算する（`datasetFingerprint()`）。手で書くバージョン番号は必ず古くなる。事例を1件でも直せば変わるため、**表示した数値がどのデータに対するものか後から辿れる。**

## 6. UI

速度感を見せることを重視する。

```text
50 CASES
01  ██████████  REVIEW      98%  ✓
02  ██          NO SIGNAL   91%  ✓
03  ████████    REVIEW      86%  ✓
04  ███         NO SIGNAL   72%  ✕
```

**`SAFE` と表示しない**（§3.1）。日本語の画面では `要確認` / `要確認シグナルなし` とする。

下部にsummaryを置く。数値は**実測に差し替える**こと。設計段階で置いた見本の数字をそのまま出さない。

```text
50 decisions
Human ↔ Jev agreement   92%
Latency                 284 ms
Input tokens            （実測）
Estimated cost          （実測）
```

1件あたりの時間を出す場合は注記する。

> 並列評価されたリクエスト全体の時間を件数で割った参考値であり、各判断が逐次実行された意味ではない。

## 7. 精度の表現

**「Jevの精度92%」とは表示しない。** 表示するなら次とする。

> このデモ用50ケースの**暫定ラベル（人手確認前）**との一致率

DX JUDGEは複数Noulなので、単純なaccuracyだけでなく軸ごとの一致、false positive / negative、低confidenceの件数も内部で評価できるようにする。UIが複雑になるなら詳細はdebug表示でよい。

**一致率を出すときは閾値も一緒に出す。** §4.6 の通り、PRIVACYは閾値0.3で92%、0.9で68%になる。閾値を伏せた一致率は数字を選んでいるのと変わらない。

## 8. 共通の計測

SPEC FIND / CITY Semantic Fit と同じ計測項目を使う。既存の `estimateCostUsd` と `JudgeResponse.usage` を再利用し、新しい仕組みを作らない。

```ts
{ latencyMs, inputTokens, outputTokens, estimatedCostUsd, model, candidateCount, questionCount }
```

これによりLOVE / SOCIAL / CITY / SPEC FIND / BATCH JUDGE のJev利用効率を横並びで比較できる。

## 9. 設計上の原則

```text
Knowledge「判断材料」      -> アプリの責任
Context  「何を判断するか」 -> アプリの責任
Decision 「意味的にどう見えるか」-> Jev
Action   「結果をどう使うか」 -> アプリの責任
```

**JevにKnowledge不足を補わせない。** 行政仕様、社内ルール、法的ルールを世界知識から推測させない。

## 10. 実装フェーズ

1. ~~共通schemaとfixtureを作る（Jevを呼ばない）~~ 完了（Phase 11）
2. ~~**benchmarkを実測する。** 件数 × 軸数、参照方式、分割の有無~~ 完了（Phase 12、§4.6）
3. ~~実測値で方式を決め、docsへ残す~~ 完了（§4.7）
4. PRIVACY / DEADLINE / DX JUDGE を実装する。**先にgoldラベルを人が確認する**（§5）
5. feature flagの既定無効で追加し、既存モードを壊さないことを確認する
6. gold caseとの一致、latency、tokens、costを実機で測る

## 11. 完了条件

- 3テーマが動く
- 数十件を一括評価できる
- goldとの一致を確認できる
- latency / tokens / cost を表示できる
- 低confidence・不一致のケースを確認できる
- 既存モードのE2Eとテストが変わらない
- **表示する数値がすべて実測値である**
- **画面に `安全` / `SAFE` / `そのまま入力` と出ていない**（§3.1）
- **入力欄の手前に、入力文がTypeSafe AIへ送信される旨が出ている**（§3.1）
- デモ用の例文があり、自分の文章を貼らなくても動きを確認できる
