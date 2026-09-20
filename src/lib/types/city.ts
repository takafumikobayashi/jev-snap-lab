/**
 * `city-directory.json` のスキーマ。
 *
 * 出所は docs/CITY_DATA.md の §4。データは実行時にスクレイピングせず、
 * バージョン管理された静的 JSON として持つ（同 §7）。
 */

export type CitySourceRecord = {
	sourceId: string;
	title: string;
	/** 架空データでは null。 */
	url: string | null;
	sourceType: 'organization_page' | 'ordinance' | 'rule' | 'council_material';
	locator: string;
	publishedOrUpdatedAt: string | null;
	retrievedAt: string;
	effectiveFrom: string | null;
	notes: string | null;
};

export type CityResponsibility = {
	responsibilityId: string;
	/** 規則の条文そのまま。要約や言い換えをしない。 */
	officialText: string;
	publicSummary: string;
	/** 係を特定するための手がかり。空配列なら課までの表示に留める。 */
	keywords: string[];
	sourceRefs: string[];
};

export type CityOrganizationUnit = {
	/** 課.係の粒度。表示と根拠 join に使う。 */
	organizationUnitId: string;
	/** 課レベル。route_to Choice の criteria key に使う。 */
	routingCandidateId: string;
	organizationType: 'city_department' | 'external_operator' | 'branch' | 'committee' | 'facility';
	department: string | null;
	section: string;
	/** 係。公式資料で確認できない場合は null。名称を推測して埋めない。 */
	unit: string | null;
	officialName: string;
	publicSummary: string;
	responsibilities: CityResponsibility[];
	routingCategories: string[];
	sourceRefs: string[];
	effectiveFrom: string;
	effectiveTo: string | null;
	active: boolean;
};

export type CityCategory = {
	id: string;
	label: string;
};

export type CityDirectory = {
	schemaVersion: '1';
	/**
	 * 架空の自治体データか。
	 *
	 * 公開用のデータセットは実在の自治体の公開情報をもとに生成した架空
	 * データで、条文も実物ではない。UI はこれを明示する（docs/CITY_DATA.md §10）。
	 */
	fictional?: boolean;
	jurisdiction: string;
	displayName: string;
	effectiveFrom: string;
	retrievedAt: string;
	sourceIndex: CitySourceRecord[];
	organizations: CityOrganizationUnit[];
	categories: CityCategory[];
};
