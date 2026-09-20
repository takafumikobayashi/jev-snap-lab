# デプロイ手順

Vercel への展開手順と受入確認をまとめる。Phase 6 に対応する。

## 1. 前提

- リポジトリは公開（`takafumikobayashi/jev-snap-lab`）
- 公開されるのは**架空のCITYデータのみ**。実データ（`data/city/local-*.json`）はリポジトリに含まれないため、Vercelのビルドからは参照できない
- ブランチ構成: `develop` が作業ブランチ、`main` が本番

## 2. プロジェクトの接続

Vercelダッシュボードで **Add New → Project** から `takafumikobayashi/jev-snap-lab` をimportする。

| 項目 | 値 |
|---|---|
| Framework Preset | SvelteKit（自動検出される） |
| Build Command | 既定のまま |
| Output Directory | 既定のまま |
| Install Command | 既定のまま（pnpmは`packageManager`から検出される） |
| Production Branch | `main` |

`main` をProduction Branchにすると、`develop` への push は自動でPreviewデプロイになる。Previewで確認してから `main` へmergeする流れになる。

## 3. 環境変数

**Production と Preview の両方**に設定する。Developmentは手元の `.env` を使うので不要。

| 変数 | 値 | 必須 | 備考 |
|---|---|---|---|
| `TYPESAFE_API_KEY` | TypeSafe Consoleで発行したキー | **必須** | 未設定だと全判定が500になる |
| `PUBLIC_SITE_URL` | `https://<デプロイ先のドメイン>` | 推奨 | 未設定だとOGP画像のmetaを出力しない |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | 任意 | 未設定でも既定値が同じ |
| `JEV_TIMEOUT_MS` | `3500` | 任意 | 未設定でも既定値が同じ |
| `JEV_TOTAL_TIMEOUT_MS` | `12000` | 任意 | 未設定でも既定値が同じ |
| `APP_RATE_LIMIT_PER_MINUTE` | `10` | 任意 | 正の整数のみ。読めない値は既定値へ戻り、`RATE_LIMIT_INVALID` を警告に出す |

**設定してはいけないもの**

| 変数 | 理由 |
|---|---|
| `CITY_DIRECTORY` | 実データはリポジトリに無いため、指定すると起動時にエラーになる。未設定で架空データが使われる |
| `CITY_SOURCE_HOSTS` | 架空データは出典URLを持たないため不要 |

Previewは複数のURLを持つため、`PUBLIC_SITE_URL` はPreviewごとに一致しない。OGPを厳密に確認したい場合のみ、そのPreview URLを一時的に設定する。

## 4. デプロイ

`develop` を push すればPreviewが作られる。手動デプロイは不要。

```bash
git push origin develop
```

## 5. 受入確認

Preview URLに対してスクリプトを回す。

```bash
pnpm check:deployment https://<preview-url>
```

確認するのは次の24項目である。上流のJevは呼ばないため課金は発生しない。

- トップページの応答
- CSPの各ディレクティブ、`script-src` のnonce、`style-src` の `unsafe-inline`
- `nosniff`、`Referrer-Policy`
- OGPの絶対URL、`og:url`、`twitter:card`
- `og-image.jpg` / `favicon.svg` / `favicon.png` の配信とcontent-type
- `robots.txt` が検索を拒否しSNSを通すこと
- 入力不正が400で、`Cache-Control: no-store` が付くこと
- エラーに内部情報を含まないこと
- 8KB超のボディが400になること

判定の1往復まで確認する場合は `--smoke` を付ける。1回あたり$0.0001未満の課金が発生する。

```bash
pnpm check:deployment https://<preview-url> --smoke
```

この場合、追加で次を確認する。

- 判定が200で、カード・model・usageが返ること
- **CITYが架空データであること**（`city.fictional === true`）
- `city.candidates` が返ること
- 候補に出典が付いていること
- 出典がURLを持たないこと（`city.candidates[].sources[].url === null`）

CITYの確認は `scripts/lib/city-smoke.mjs` に切り出し、単体テストで「壊れたレスポンスを落とせること」を固定している。以前は `city.sources` という存在しないパスを見ており、`?? []` の既定値によって**URLが漏れていても合格する**空振りの検査になっていた。空集合を合格にしないこと、対象の存在を先に確かめることを検査の前提にしている。

### スクリプトで確認できないもの

ブラウザで直接見る必要がある。

- ブラウザコンソールにCSP違反が出ないこと
- 結果カードのバーが幅と色を持って描画されること（CSPで`style-src`が効かないと本番だけ壊れる）
- タイムアウト時に504が返ること（プラットフォームに先に切られていないこと）
- OGPカードの実際の表示（SlackやXにPreview URLを貼る）

## 6. Production への反映

Previewで確認できたら `develop` を `main` へmergeする。

```bash
git checkout main
git merge --ff-only develop
git push origin main
```

Productionのデプロイ後も `pnpm check:deployment` を回す。`PUBLIC_SITE_URL` はProductionのドメインに合わせる。

## 7. 運用

- 月次: Jevのmodel、料金、rate limit、SDK changelogを確認（[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) の §7）
- 四半期: CITYの組織ページと例規集の施行日を確認（[CITY_DATA.md](CITY_DATA.md) の §7）
- データを更新したら `pnpm city:build` で架空版を再生成し、`pnpm city:check-leak` を回してから push する
