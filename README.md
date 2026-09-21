# Jev Snap Lab

**Tiny inputs. Instant decisions.**

短い文章を入力すると、TypeSafe AI の Jev に複数の小さな判断を同時に行わせ、確率・スコア・選択肢として可視化する小型 Web アプリです。

これは長文生成アプリではありません。入力を説明文へ変換するのではなく、曖昧な人間の直感をソフトウェアで扱える構造化された判断へ変換することを目的にしています。

## MVP のモード

- **LOVE** — 短文の恋愛的な含意を複数軸で判定
- **SOCIAL** — SNS 投稿らしさ、ユーモア、議論性、反応誘発性などを判定
- **CITY** — M市の現行組織・事務分掌をモデルケースに、行政問い合わせの担当候補などを判定

CITY は正式な行政案内サービスではなく、Jev と根拠付きルーティングの技術デモです。Jev の出力だけを正解とみなさず、公式の組織・分掌データを併記します。

## 次期拡張（設計中）

- **CITY Semantic Fit** — 現行の課レベルChoiceを既定経路として残し、候補を限定した分掌適合度の実験を行う。追加呼び出し、全分掌の送信、正式な担当確定はMVPに含めない。
- **SPEC FIND** — デジタル庁の共通機能標準仕様書第2.7版の公式PDFだけを対象に、短い要望から関連passageと出典箇所を探す。回答生成、適合性判定、Excel対応は後続検討とする。

設計と評価結果は [CITY Semantic Fit](docs/CITY_SEMANTIC_EXPERIMENT.md) と [SPEC FIND](docs/SPEC_FIND_DESIGN.md) を参照してください。

| 機能              | 状態                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| SPEC FIND         | **実装済み**。`SPEC_FIND_ENABLED=true` で有効。本番で有効にする                            |
| CITY Semantic Fit | **実装済み（shadow）**。`CITY_SEMANTIC_EXPERIMENT=true` で有効。本番では無効のまま据え置く |
| BATCH JUDGE       | 着手前。設計は [BATCH_JUDGE_DESIGN.md](docs/BATCH_JUDGE_DESIGN.md)                         |
| SPEC FIND v1      | 着手前。設計は [SPEC_FIND_DESIGN.md](docs/SPEC_FIND_DESIGN.md) の §10                      |

実装済みの2つはどちらも既定が無効で、既存のLOVE / SOCIAL / CITYの動作は変わりません。

## 設計ドキュメント

- [プロダクト仕様](docs/PRODUCT_SPEC.md)
- [Jev 設計](docs/JEV_DESIGN.md)
- [CITY データ設計](docs/CITY_DATA.md)
- [CITY Semantic Fit 実験設計](docs/CITY_SEMANTIC_EXPERIMENT.md)
- [SPEC FIND 設計](docs/SPEC_FIND_DESIGN.md)
- [アーキテクチャ](docs/ARCHITECTURE.md)
- [実装計画](docs/IMPLEMENTATION_PLAN.md)
- [デプロイ手順](docs/DEPLOY.md)

## 技術構成の推奨案

実装時の推奨構成は以下です。小規模な構成を保ちつつ、Jev API キーをサーバー側に閉じ込め、Vercel へ容易にデプロイできることを優先します。

- SvelteKit + TypeScript
- Tailwind CSS
- Node.js 22.12 以上 / pnpm
- TypeSafe 公式 JavaScript SDK (`@typesafe-ai/sdk`)
- Vercel (`@sveltejs/adapter-vercel`)
- 永続データベースなし。CITY データはバージョン管理する静的 JSON

採用理由と代替案は [アーキテクチャ](docs/ARCHITECTURE.md) に記載しています。

## ローカル実行方法

パッケージマネージャは **pnpm** です。**Node.js 22.12 以上**が必要で、`engine-strict=true` により満たさない環境では `pnpm install` が失敗します。

Node 20 は 2026-04-30 にサポートが終了しています。加えて `pnpm spec:build` が TypeScript の型ストリップ（Node 22.6 以降）を使うため、下限を 22.12 にしています。CI と Vercel の実行環境もいずれも Node 22 です。

pnpm を採用したのは、この構成の依存を npm でインストールできなかったためです。開発環境（macOS / Node 22.19.0 / npm 10.9.3）で `npm install` が arborist の peer 解決中に `Cannot read properties of null (reading 'edgesOut')` で異常終了しました。`--legacy-peer-deps` を付けると解決できたため依存の衝突ではありませんが、他のバージョンや環境での再現性は確認していません。pnpm では問題なくインストールできます。

```bash
corepack enable          # pnpm が未導入の場合のみ
pnpm install
cp .env.example .env
# .env に TYPESAFE_API_KEY を設定
pnpm dev
```

| コマンド       | 内容                             |
| -------------- | -------------------------------- |
| `pnpm dev`     | 開発サーバー                     |
| `pnpm build`   | 本番ビルド                       |
| `pnpm preview` | 本番ビルドのプレビュー           |
| `pnpm check`   | TypeScript / Svelte の型チェック |
| `pnpm lint`    | Prettier + ESLint                |
| `pnpm format`  | 整形の適用                       |
| `pnpm test`    | ユニットテスト                   |

主な環境変数は次のとおりです。全項目は `.env.example` を参照してください。

```dotenv
TYPESAFE_API_KEY=your_server_side_key
TYPESAFE_DEFAULT_MODEL=jev-latest
JEV_TIMEOUT_MS=3500
JEV_TOTAL_TIMEOUT_MS=12000
```

API キーはブラウザへ渡さず、サーバーの API route からのみ使用します。環境変数名、タイムアウト、レート制限、コスト計算の詳細は [アーキテクチャ](docs/ARCHITECTURE.md) と [Jev 設計](docs/JEV_DESIGN.md) を参照してください。

## 現時点の非ゴール

- ユーザー入力の永続保存、アカウント、履歴機能
- 歌詞や第三者コンテンツの収集・保存・提供
- 自治体への自動通報・申請・予約
- Jev の判断理由を長文生成すること
- 医療、法律、行政上の正式な判断を代行すること

## ライセンスとデータ出典

アプリ固有のライセンスは実装時に決定します。

CITY のデータセットは 2 種類あります。

|            | 公開用                                       | 手元の検証用                 |
| ---------- | -------------------------------------------- | ---------------------------- |
| ファイル   | `data/city/fictional-m-city.json`            | `data/city/local-*.json`     |
| 内容       | **架空の市**。組織名・分掌・条文はすべて架空 | 実在する自治体の公開情報     |
| 出典 URL   | 持たない                                     | 公式ページと例規集へのリンク |
| リポジトリ | コミットする                                 | `.gitignore` で除外          |

**公開されるのは架空データだけです。** 実データは精度の検証のために手元でのみ使い、リポジトリにもビルド成果物にも含めません。切り替えと漏えい検査の手順は [CITY データ設計](docs/CITY_DATA.md) の §9 にまとめています。
