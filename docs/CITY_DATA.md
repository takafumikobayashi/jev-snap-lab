# CITY Data Design

## 1. 方針

CITYは架空の自治体組織ではなく、安芸高田市の現行公開情報をモデルケースにする。Webアプリの画面では、安芸高田市専用の正式サービスと誤認させず、技術検証用の「担当候補判定」として扱う。

データはJevの質問文へ直接ベタ書きしない。次の二つを分離する。

1. **公式根拠データ**: 部、課、係、分掌事務、市民向け説明、URL、有効日、取得日。
2. **アプリ用の正規化データ**: 安定したカテゴリ、候補キー、Jevへ渡す短い説明、表示ラベル。

Jevが返すのは候補の確率であり、公式な担当課の確定ではない。担当候補の表示は、Jevのanswerと公式根拠データを同じIDでjoinした場合だけ行う。

## 2. 調査結果（2026-09-20時点）

### 一次情報

- [安芸高田市「組織」](https://www.akitakata.jp/ja/shisei/section/)
  - ページ上の更新表示: 2026年6月1日更新
  - 市民向けに課の説明と窓口電話を公開
- [安芸高田市事務組織規則](https://www1.g-reiki.net/akitakata/reiki_honbun/r382RG00000044.html)
  - 平成16年規則第4号
  - 検索結果上の現行表示: 令和8年4月1日施行
  - 係と分掌事務を条文単位で定義
- [安芸高田市例規集の体系目次](https://www1.g-reiki.net/akitakata/reiki_taikei/r_taikei_03.html)
  - 例規集の内容現在は令和8年4月1日と表示
- [安芸高田市事務分掌条例の改正議案ページ](https://www.akitakata.jp/ja/parliament/giketu/izen/a163/w741-copy/)
  - 条例改正の経緯を確認する補助出典。現行データの主出典は事務組織規則と組織ページ。

### 構造の読み方

現行規則の目次上は、危機管理監、総務部、企画部、市民部、福祉保健部、産業部、建設部、会計課、支所・事業所・公の施設が整理されている。危機管理課は部配下ではなく危機管理監に置かれる課として定義される。

内部データでは次の階層を採用する。

```text
jurisdiction
└── department（部または危機管理監等）
    └── section（課・センター・事務所）
        └── unit（係・担当。存在しない場合は null）
            └── responsibility（個別の分掌事務）
```

## 3. 現行組織の初期カタログ

これは「Jev候補を作るための初期カタログ」であり、職員名簿ではない。窓口電話など変動しやすい情報は、ルーティングの入力に含めず、必要になったときだけ公式組織ページから別フィールドとして取り込む。

| 上位 | 課・組織 | 初期ルーティング用途 | 係の扱い |
|---|---|---|---|
| 危機管理監 | 危機管理課 | 防犯、防災、交通安全、消費生活、消防団 | 防災・生活安全係 / 消防団係を規則から確認済み |
| 総務部 | 総務課 | 総務、例規、情報公開、個人情報、行政組織 | 行政係、職員係、法務管理担当などを規則から取り込む |
| 総務部 | 秘書広報課 | 広報、報道、市長・副市長秘書、要望・陳情 | 規則から全係を取り込む。実装前に要確認 |
| 総務部 | 財産管理課 | 庁舎、公共施設、市有財産、修繕、公用車 | 管理・営繕係を確認済み |
| 企画部 | 財政課 | 予算、決算、入札、契約、工事検査 | 財政係 / 入札・検査係を確認済み |
| 企画部 | 政策企画課 | 総合計画、地方創生、定住、住民自治、NPO | 企画調整係 / まちづくり推進係などを確認済み |
| 企画部 | DX推進課 | 庁内ネットワーク、情報システム、DX、光ネットワーク | 規則から取り込む。実装前に要確認 |
| 市民部 | 市民課 | 戸籍、住民票、印鑑、パスポート、マイナンバー | 窓口係を確認済み |
| 市民部 | 税務課 | 市民税、県民税、固定資産税、納税相談 | 市民税係 / 資産税係等を確認済み |
| 市民部 | 環境政策課 | ごみ、資源回収、公害、不法投棄、犬、墓地 | 規則から取り込む。実装前に要確認 |
| 市民部 | 人権多文化共生推進課 | 人権相談、多文化共生、男女共同参画、犯罪被害者支援 | 規則から取り込む。実装前に要確認 |
| 福祉保健部 | 社会福祉課 | 地域福祉、生活保護、障害、高齢者福祉 | 地域福祉係 / 生活福祉係 / 障害者福祉係を確認済み |
| 福祉保健部 | こども家庭センター | 妊娠、子どもの健診、予防接種、子育て相談、家庭児童相談 | 規則・公式ページから取り込む。実装前に要確認 |
| 福祉保健部 | 健康推進課 | 成人健診、感染症、予防接種、精神保健、健康づくり | 健康推進係を確認済み |
| 福祉保健部 | 保険医療課 | 国保、医療費、後期高齢者医療、国民年金、介護保険 | 医療保険年金係 / 介護保険係を公式ページで確認。規則との対応を要確認 |
| 産業部 | 地域営農課 | 農業経営、新規就農、農産物、畜産、有害鳥獣 | 営農支援係などを規則から取り込む |
| 産業部 | 農林水産課 | 農村整備、農道・林道、治山、森林、水産、地籍 | 規則から取り込む。実装前に要確認 |
| 産業部 | 商工観光課 | 商工業、企業立地、雇用、観光、観光施設 | 商工係 / 観光係を確認済み |
| 建設部 | 管理課 | 道路・河川の占用、台帳、都市計画、建築確認、住宅、空き家 | 建設管理係を確認済み |
| 建設部 | 建設課 | 道路・橋りょうの新設改良、維持、水防、災害復旧 | 工務係 / 維持係を確認済み |
| 建設部 | 下水道課 | 下水道料金、排水設備、下水道施設、浄化槽、し尿処理 | 規則から取り込む。実装前に要確認 |
| 会計管理者 | 会計課 | 出納、決算、支出、指定金融機関、備品 | 出納係を確認済み |
| 出先機関 | 八千代・美土里・高宮・甲田・向原支所 | 支所窓口、各種申請の一次受付 | 窓口係 |
| 外部事業体 | 広島県水道広域連合企業団安芸高田事務所 | 水道料金、給水装置、水道施設、水質 | 市の課と別の `external_operator` として扱う |
| その他 | 教育委員会、消防本部、農業委員会、行政委員会総合事務局 | CITYの初期ルーティング候補。詳細は各公式組織・規程を追加調査 | `organization_type`で区別 |

公開組織ページには課ごとの市民向け説明が掲載されており、例えば防犯灯の設置・管理は危機管理課、道路・橋りょうの維持は建設課、ごみ・資源回収は環境政策課、水道は広島県水道広域連合企業団安芸高田事務所、戸籍・住民登録は市民課として示されている。[組織ページ](https://www.akitakata.jp/ja/shisei/section/)

## 4. CITYデータの型

`categories` はカテゴリの **single source of truth** である。`request_category` Choiceの候補、`CityOrganizationUnit.routingCategories` の値、画面のカテゴリ表示ラベルは、すべてこの配列から生成する。[JEV_DESIGN.md](JEV_DESIGN.md) を含め、他のドキュメントやコードにカテゴリ一覧を二重定義しない。

### TypeScript相当

```ts
type CityDirectory = {
  schemaVersion: "1";
  jurisdiction: "akitakata";
  displayName: "安芸高田市";
  effectiveFrom: string;       // 例: 2026-04-01
  retrievedAt: string;         // ISO 8601 date
  sourceIndex: CitySource[];
  organizations: CityOrganizationUnit[];
  categories: CityCategory[];
};

type CityOrganizationUnit = {
  organizationUnitId: string;  // 課.係の粒度。表示と根拠joinに使う
  routingCandidateId: string;  // 課レベル。route_to Choiceのcriteria keyに使う（§5）
  organizationType: "city_department" | "external_operator" | "branch" | "committee" | "facility";
  department: string | null;  // 部、監、会計管理者など
  section: string;             // 課、センター、事務所など
  unit: string | null;         // 係、担当。未確認はnullであり推測しない
  officialName: string;
  publicSummary: string;
  responsibilities: CityResponsibility[];
  routingCategories: string[];
  sourceRefs: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
};

type CityResponsibility = {
  responsibilityId: string;
  officialText: string;
  publicSummary: string;
  keywords: string[];
  sourceRefs: string[];
};

type CityCategory = {
  id: string;                  // request_category Choiceのcriteria key
  label: string;               // 画面表示ラベル
};

type CitySource = {
  sourceId: string;
  title: string;
  url: string;
  sourceType: "organization_page" | "ordinance" | "rule" | "council_material";
  locator: string;             // 例: 事務組織規則 第7条の2 防災・生活安全係
  publishedOrUpdatedAt: string | null;
  retrievedAt: string;
  effectiveFrom: string | null;
  notes: string | null;
};
```

### JSON例

```json
{
  "schemaVersion": "1",
  "jurisdiction": "akitakata",
  "displayName": "安芸高田市",
  "effectiveFrom": "2026-04-01",
  "retrievedAt": "2026-09-20",
  "sourceIndex": [
    {
      "sourceId": "akitakata-organization-page-2026-06-01",
      "title": "組織 | 安芸高田市",
      "url": "https://www.akitakata.jp/ja/shisei/section/",
      "sourceType": "organization_page",
      "locator": "危機管理課 / 防犯灯の設置及び管理",
      "publishedOrUpdatedAt": "2026-06-01",
      "retrievedAt": "2026-09-20",
      "effectiveFrom": null,
      "notes": "市民向け課説明"
    },
    {
      "sourceId": "akitakata-business-rules-2026-04-01",
      "title": "安芸高田市事務組織規則",
      "url": "https://www1.g-reiki.net/akitakata/reiki_honbun/r382RG00000044.html",
      "sourceType": "rule",
      "locator": "第7条の2 防災・生活安全係",
      "publishedOrUpdatedAt": null,
      "retrievedAt": "2026-09-20",
      "effectiveFrom": "2026-04-01",
      "notes": "係と分掌事務の根拠"
    }
  ],
  "organizations": [
    {
      "organizationUnitId": "crisis_management.safety_living",
      "routingCandidateId": "crisis_management",
      "organizationType": "city_department",
      "department": "危機管理監",
      "section": "危機管理課",
      "unit": "防災・生活安全係",
      "officialName": "安芸高田市 危機管理監 危機管理課 防災・生活安全係",
      "publicSummary": "防犯、防災、交通安全、警察連携、防犯施設、消費生活相談を担当する候補。",
      "responsibilities": [
        {
          "responsibilityId": "crisis_management.safety_living.security_lights",
          "officialText": "防犯施設の設置及び管理に関すること。",
          "publicSummary": "防犯施設の設置・管理。",
          "keywords": ["防犯灯", "防犯施設", "街灯", "安全"],
          "sourceRefs": ["akitakata-organization-page-2026-06-01", "akitakata-business-rules-2026-04-01"]
        }
      ],
      "routingCategories": ["safety_security", "disaster"],
      "sourceRefs": ["akitakata-organization-page-2026-06-01", "akitakata-business-rules-2026-04-01"],
      "effectiveFrom": "2026-04-01",
      "effectiveTo": null,
      "active": true
    },
    {
      "organizationUnitId": "construction.maintenance",
      "routingCandidateId": "construction_works",
      "organizationType": "city_department",
      "department": "建設部",
      "section": "建設課",
      "unit": "維持係",
      "officialName": "安芸高田市 建設部 建設課 維持係",
      "publicSummary": "道路、橋りょう、河川の維持や道路パトロールを担当する候補。",
      "responsibilities": [
        {
          "responsibilityId": "construction.maintenance.road_bridge",
          "officialText": "道路、橋りょう及び河川の維持工事に関すること。",
          "publicSummary": "道路・橋りょう・河川の維持工事。",
          "keywords": ["道路", "橋", "穴", "舗装", "河川", "道路パトロール"],
          "sourceRefs": ["akitakata-business-rules-2026-04-01", "akitakata-organization-page-2026-06-01"]
        }
      ],
      "routingCategories": ["road_bridge"],
      "sourceRefs": ["akitakata-business-rules-2026-04-01", "akitakata-organization-page-2026-06-01"],
      "effectiveFrom": "2026-04-01",
      "effectiveTo": null,
      "active": true
    }
  ],
  "categories": [
    { "id": "safety_security", "label": "防犯・市民安全" },
    { "id": "road_bridge", "label": "道路・橋りょう・河川" },
    { "id": "waste_environment", "label": "ごみ・環境" },
    { "id": "water_sewer", "label": "水道・下水道" },
    { "id": "housing_building", "label": "住宅・建築・空き家" },
    { "id": "resident_records", "label": "戸籍・住民登録" },
    { "id": "tax", "label": "税" },
    { "id": "welfare", "label": "福祉・障害・高齢者" },
    { "id": "childcare", "label": "子育て・こども" },
    { "id": "health", "label": "健康・医療・保険" },
    { "id": "agriculture", "label": "農林水産" },
    { "id": "commerce_tourism", "label": "商工・観光" },
    { "id": "disaster", "label": "防災・災害" },
    { "id": "other", "label": "その他・判定不能" }
  ]
}
```

## 5. CITYからJevへ渡す方法

### 推奨案: 課・外部事業体をChoice候補、根拠はローカルjoin

1. `city-directory.json`から `active: true` かつMVP対象の組織単位を読む。
2. `routingCandidateId`（課レベル）でグルーピングする。同じ課に属する複数の係は1候補へまとめる。
3. 各候補について、課名、`publicSummary`、配下の代表的なresponsibilityの短い説明をcriteria valueへまとめる。**係名は候補の説明に含めてよいが、候補そのものを係で割らない。**
4. `route_to` Choiceのcriteria keyには `routingCandidateId` を使う。
5. Jevレスポンスの確率分布を取得する。
6. keyを元にローカルデータへjoinし、配下の係、source URL / locator / retrievedAtを表示する。係の特定はJevではなくローカルのkeyword / responsibilityマッチで行い、決められない場合は課までの表示に留める。

これにより、JevにURL本文を毎回読ませず、回答の根拠はアプリ内のバージョン管理された公式データになる。大きな全分掌表を毎回stateへ送る必要もない。

**候補を課レベルに保つ理由。** Choiceの `probabilities` は合計1になる。一つの課を係ごとに3候補へ分割すると、課としての確度がそのまま3分割される。危機管理課が78%で選ばれるはずの入力が26%×3になり、`confidence` も下がるため、UIが「判断が割れています」と誤表示する。係の粒度はJevに判定させず、選ばれた課の配下でローカルに解決する。[JEV_DESIGN.md](JEV_DESIGN.md) の §7 も参照。

### 代替案: 全分掌事務をstateに入れる

全課の全分掌事務をstateに入れると、候補説明の漏れは減るが、短文デモには過剰で、入力tokenと候補の紛らわしさが増す。MVPでは採用しない。候補が絞れないカテゴリだけ、将来の2段階判定で追加情報を送る。

## 6. 初期の受入テスト用問い合わせ

| 入力例 | 期待する主候補 | 根拠となる分掌 | 注意 |
|---|---|---|---|
| 家の前の防犯灯が切れてます | 危機管理課（係=防災・生活安全係はローカルjoinで付与） | 防犯施設の設置・管理、防犯灯の設置・管理 | 現地確認はJevのNoul。緊急通報とは別。 |
| 道路に大きな穴があって危ない | 建設課（係=維持係はローカルjoinで付与） | 道路・橋りょう・河川の維持工事、道路パトロール | 危険度と担当課候補を分ける。 |
| ごみの分別方法が分かりません | 環境政策課 | ごみ・資源回収 | 収集日や地域別ルールは別データであり、MVPでは回答しない。 |
| 水道料金の支払いについて | 広島県水道広域連合企業団安芸高田事務所 | 水道料金 | 市の課と外部事業体を区別する。 |
| 住民票を取りたい | 市民課 / 窓口係 | 戸籍・住民基本台帳・証明書交付 | 正確な手続き案内は公式ページへの導線が必要。 |
| 子どもの予防接種について聞きたい | こども家庭センターまたは健康推進課 | 子どもの定期予防接種 / 予防接種 | 候補確率が割れたら両方を表示する。 |
| 道路の街路樹を切ってほしい | 管理課または建設課 | 道路・河川等の管理、維持 | 分掌境界は実機・担当者レビューが必要。 |

## 7. 更新方法

### 更新トリガー

- 毎四半期の定期確認
- 安芸高田市の組織ページの更新日が変わった場合
- 例規集の内容現在または事務組織規則の施行日が変わった場合
- 議会資料で組織改編・課名変更を確認した場合

### 更新手順

1. 公式組織ページと例規集の現行表示を確認する。
2. 変更前の `city-directory.json` をコピーして、`effectiveTo`を設定する。
3. 新しい課・係・分掌レコードに新しい `effectiveFrom`、`retrievedAt`、`sourceRefs`を付ける。
4. 既存の `organizationUnitId`を変更する場合は、名称変更と担当変更を区別するため、原則として新IDを発行する。
5. 受入テストの期待候補、Jev criteria生成、画面の出典表示を更新する。
6. `route_to`の候補数、質問token数、429発生率、confidenceの変化を比較する。
7. 変更PRに、URL、ページの更新日、規則の施行日、取得日、差分の要約を記録する。

### ランタイムでスクレイピングしない理由

- 公式ページの一時障害でJUDGE結果が変わらないようにする。
- HTMLの文言変更でJevの質問候補が予期せず変わらないようにする。
- 回答と根拠データのバージョンを再現できるようにする。

## 8. 未確認・要実装前確認

- 例規集の全条文から全課・全係・全分掌を機械的に抽出した完全な初期JSONは、アプリ実装前のデータ整備フェーズで作成する。
- 公開組織ページと事務組織規則で名称・担当が異なる場合の優先順位は、現行規則を組織の法的根拠、市民向けページを表示説明として扱う。
- 水道事業は市の課と同列に見せず、広島県水道広域連合企業団の外部事業体として表示する。問い合わせ先の最新窓口は実装前に公式ページで再確認する。
- 教育委員会、消防本部、農業委員会、行政委員会総合事務局は初期候補に含めるが、各組織の個別規程までCITY_DATAへ取り込む範囲は実装開始時に確定する。
- 係が公式資料で確認できないレコードの `unit` はnullとし、名称を推測して埋めない。
- `routingCandidateId` の初期値は [JEV_DESIGN.md](JEV_DESIGN.md) の §7 の論理キー例を出発点とし、データ整備フェーズで確定する。同じ課に属する全レコードが同じ値を持つことをdata testで検証する。

## 9. データの正しさに関する表示

画面の根拠表示は次の文言を使う。

> 根拠データ: 安芸高田市公式公開情報（取得日: YYYY-MM-DD / 有効日: YYYY-MM-DD）

> これはJevによる担当候補の技術検証です。正式な担当部署・緊急対応・手続きは、必ず公式窓口で確認してください。
