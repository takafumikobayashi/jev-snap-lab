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
| `JEV_TOTAL_TIMEOUT_MS` | `12000` | 任意 | 未設定でも既定値が同じ。**16,000msで頭打ち**（リクエスト全体の予算。`maxDuration` 20,000msから逆算） |
| `APP_RATE_LIMIT_PER_MINUTE` | `10` | 任意 | 正の整数のみ。読めない値は既定値へ戻り、`RATE_LIMIT_INVALID` を警告に出す |
| `SPEC_FIND_ENABLED` | `true` | **推奨** | SPEC FINDを有効にする。未設定なら無効で、タブも出ない。明示的な `true` だけを有効とする。1問あたり約0.13円と他モードより高い（[SPEC_FIND_DESIGN.md](SPEC_FIND_DESIGN.md) §8.1） |
| `CITY_SEMANTIC_EXPERIMENT` | `true` | 任意 | CITY Stage 2 の shadow 実験を有効にする。**本番では設定しない**（下記） |

### `CITY_SEMANTIC_EXPERIMENT` を本番へ設定しない理由

有効にすると1リクエストで上流を2回呼ぶ。結果は**画面に出さず観測ログだけ残す**ため、利用者は待ち時間（約1.5〜1.8倍）とコスト（約1.25倍）を払って見返りが無い。

| 状態 | Stage 2 | 利用者への影響 |
|---|---|---|
| 未設定（本番） | 呼ばれない | 追加コスト・待ち時間ゼロ |
| `true`（shadow） | 呼ばれる | 待ち時間を払うが画面は変わらない |

設定する意味があるのは、**Preview で一時的にデータを集めたいとき**だけである。実機の評価は `LIVE_JEV=1 pnpm vitest run src/lib/server/city-fitgap.live.spec.ts` で行えるため、常時有効にする必要はない。採否の判断は [CITY_SEMANTIC_EXPERIMENT.md](CITY_SEMANTIC_EXPERIMENT.md) §7.3 に記録している。

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

受入確認は同じ送信元から `/api/judge` を複数回叩く。APIはレート制限を入力検証より先に評価するため、不正リクエストの確認も枠を消費する。`APP_RATE_LIMIT_PER_MINUTE` を 1 や 2 にしていると**受入確認が自分自身を締め出す**ので、429 を受けたら `Retry-After` を待って一度だけやり直す。その間 `..  レート制限に当たった。N 秒待って再試行する` と表示される。上限1なら1〜2分（`--smoke` 付きで3分ほど）かかるが、異常ではない。429 のまま再試行が失敗した場合は不合格として報告する（無条件に合格扱いにすると検査が空振りになる）。

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
- データを更新したら架空版を再生成し、`pnpm city:check-leak` を回してから push する

  ```bash
  pnpm city:build data/city/local-<自治体>-<施行日>.json
  pnpm city:check-leak
  ```

  対応表（`scripts/city-name-map.local.json`）と出力先（`data/city/fictional-m-city.json`）は既定値を使う。元データのパスだけ渡す。ファイル名に自治体名と施行日が入るため、`package.json` へ既定値として書くとそれ自体が漏えいになる。
