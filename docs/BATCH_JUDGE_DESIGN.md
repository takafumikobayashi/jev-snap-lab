# BATCH JUDGE Design

## 1. 位置づけ

BATCH JUDGEは、短い文章を数十件まとめてJevへ渡し、意味判断を一度に構造化するモードである。**設計段階であり未実装。**

既存モードとJevの使い方が逆になる。

```text
SPEC FIND    少数のQuery  × 多くのKnowledge  -> 読むべき根拠を探す
BATCH JUDGE  多数のInput  × 少数の判断基準    -> 大量の意味判断を高速に行う
```

同じLabで両方を測り、**どの問題構造でSystem One Modelが効くのか**を比較できる状態にすることが目的である。「AIが文章を書く」デモにはしない。

## 2. 非目的

- 個人情報該当性の正式な判定
- 法的・行政的な判断
- DX施策の自動決定、自動承認、自動実行
- 日時文字列の厳密なparse
- Jevによる長文生成

BATCH JUDGEが返すのは**仕分けの候補**であり、確定ではない。

## 3. 判定テーマ

初期版は3テーマ。

### 3.1 PRIVACY「AIにそのまま入れてよい？」

短文について `SAFE` / `REVIEW` 相当を示す。Jevへは原子的な問いに分けて聞く。

- 個人を識別できそうか
- 個人の事情・属性を含みそうか
- 慎重に扱うべき情報を含みそうか

**「個人情報です／違います」と断定しない。** 画面は `そのまま入力` / `要確認` の二値に留める。

電話番号、メールアドレス、マイナンバーのように決定的な規則で検出できるものは、将来regex/DLPとのhybridにできる設計にする。**Jevを唯一の制御にしない。** この点は注意文としても画面に常時出す（SPEC FINDの「適合度（実験値）」と同じ水準）。

### 3.2 DEADLINE「いつまでに対応が必要？」

期限の明示、急ぎ度、対応期限の意味カテゴリを判断する。

```text
NOW / TODAY / SOON / LATER / NO_DEADLINE
```

**calendar parserを作るモードではない。** 「9月25日17時」のような具体的な日時の抽出はJevにさせず、必要ならアプリ側のparserとのhybridを検討する。

### 3.3 DX JUDGE「この業務課題、何から手を付ける？」

短い相談文から検討方向の候補を仕分ける。単一Choiceへ押し込まず、**独立Noul**を基本とする。

```text
BPR_FIRST / AUTOMATION / AI_CANDIDATE / SYSTEM_CHANGE / HUMAN_REVIEW
```

複数が同時に高くてよい。正式なDXコンサルティング判断ではない。

## 4. 実測が要る前提

### 4.1 「件数 × 軸数」で質問数が決まる

§3の3テーマは軸の数が違う。**1リクエストの質問数は件数そのものではない。**

| テーマ | 1件あたりの質問 | 50件での質問数 |
|---|---|---|
| PRIVACY | 3〜4（原子的な問い） | 150〜200 |
| DEADLINE | 1〜3（Choice + Noul + Score） | 50〜150 |
| DX JUDGE | 5（独立Noul） | **250** |

**測定済みの上限は40問である**（[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §8.1）。250問はその6倍で、外挿できない。

実測値から見積もると、質問1問あたりの増分は113 tokens。250問なら質問だけで約28,000 tokens（リクエスト上限64kの44%）になる。stateは短文50件なので小さいが、合計では未測定の領域へ入る。

**benchmarkは「件数」ではなく「件数 × 軸数」で行う。** 50×1 と 50×5 は別物として測る。

### 4.2 分割は最後の手段

SPEC FINDの実測で、同じ候補数を1問ずつ分けて送ると**latencyが22倍、入力tokenが2.5倍**になった（stateを毎回送り直すため）。最初からchunkしない。

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

## 5. Dataset

各テーマ30〜50件のfixtureを人手で作る。

```ts
type BatchJudgeCase = {
	id: string;
	text: string;
	gold: unknown;
	difficulty?: 'easy' | 'medium' | 'hard';
};
```

**Jev自身が作った答えをgoldにしない。** 曖昧なケースも意図的に入れる。

## 6. UI

速度感を見せることを重視する。

```text
50 CASES
01  ██████████  REVIEW  98%  ✓
02  ██          SAFE    91%  ✓
03  ████████    REVIEW  86%  ✓
04  ███         SAFE    72%  ✕
```

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

> このデモ用50ケースに対する、人手で作った正解ラベルとの一致率

DX JUDGEは複数Noulなので、単純なaccuracyだけでなく軸ごとの一致、false positive / negative、低confidenceの件数も内部で評価できるようにする。UIが複雑になるなら詳細はdebug表示でよい。

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

## 10. 実装フェーズ（未着手）

1. 共通schemaとfixtureを作る（Jevを呼ばない）
2. **benchmarkを実測する。** 件数 × 軸数、参照方式、分割の有無
3. 実測値で方式を決め、docsへ残す
4. PRIVACY / DEADLINE / DX JUDGE を実装する
5. feature flagの既定無効で追加し、既存モードを壊さないことを確認する
6. gold caseとの一致、latency、tokens、costを実機で測る

## 11. 完了条件

- 3テーマが動く
- 数十件を一括評価できる
- 人手のgoldとの一致を確認できる
- latency / tokens / cost を表示できる
- 低confidence・不一致のケースを確認できる
- 既存モードのE2Eとテストが変わらない
- **表示する数値がすべて実測値である**
