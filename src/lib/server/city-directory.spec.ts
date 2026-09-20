import { describe, expect, it } from 'vitest';
import {
	categoryCriteria,
	directoryVersion,
	getDirectory,
	jurisdictionName,
	OTHER_OR_UNCLEAR,
	resolveUnit,
	routeCandidates,
	routeCriteria,
	isFictional,
	routeLabels,
	sourcesFor
} from './city-directory.server';
import { MAX_CHOICE_OPTIONS } from './question-validation.server';

const directory = getDirectory();

describe('city-directory.json の健全性', () => {
	it('既定は架空の自治体データである', () => {
		// CITY_DIRECTORY の設定漏れで実在の自治体データが公開されないよう、
		// 既定値を架空版にしている（docs/CITY_DATA.md §10）。
		expect(isFictional()).toBe(true);
		expect(directory.jurisdiction).toBe('mcity');
		expect(jurisdictionName()).toBe('M市');
		expect(directoryVersion()).toBe('mcity-2026-04-01');
	});

	it('架空データに外部 URL が含まれない', () => {
		// リンク先から実在の自治体が判明するため、架空版には URL を残さない。
		// 実在の固有名詞そのものの検出は、対応表を持つ生成スクリプト
		// （scripts/build-fictional-city.mjs）が担当する。このリポジトリに
		// 実名を書かないため、ここでは構造だけを見る。
		expect(JSON.stringify(directory)).not.toMatch(/https?:\/\//);
	});

	it('取得日と有効日を持つ', () => {
		expect(directory.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(directory.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('架空データの出典は URL を持たない', () => {
		// リンク先から実在の自治体が判明するため、架空版では URL を落とす。
		for (const source of directory.sourceIndex) {
			expect(source.url, source.sourceId).toBeNull();
		}
	});

	it('URL を持つ場合は https に限る', () => {
		// 手元で実データを使うときの防波堤（docs/ARCHITECTURE.md §8）。
		// 架空データでは URL が無いため、対象ゼロでも成立するよう件数で示す。
		const withUrl = directory.sourceIndex.filter((source) => source.url !== null);
		expect(withUrl.every((source) => new URL(source.url as string).protocol === 'https:')).toBe(
			true
		);
	});

	it('すべての organization の sourceRefs が sourceIndex に存在する', () => {
		const known = new Set(directory.sourceIndex.map((s) => s.sourceId));
		for (const unit of directory.organizations) {
			for (const ref of unit.sourceRefs) expect(known, unit.organizationUnitId).toContain(ref);
			for (const r of unit.responsibilities) {
				for (const ref of r.sourceRefs) expect(known, r.responsibilityId).toContain(ref);
			}
		}
	});

	it('organizationUnitId が一意である', () => {
		const ids = directory.organizations.map((u) => u.organizationUnitId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('routingCategories が categories の部分集合である', () => {
		const known = new Set(directory.categories.map((c) => c.id));
		for (const unit of directory.organizations) {
			for (const category of unit.routingCategories) {
				expect(known, `${unit.organizationUnitId}: ${category}`).toContain(category);
			}
		}
	});

	it('同じ課の全レコードが同じ section を指す', () => {
		const sections = new Map<string, Set<string>>();
		for (const unit of directory.organizations) {
			const set = sections.get(unit.routingCandidateId) ?? new Set();
			set.add(unit.section);
			sections.set(unit.routingCandidateId, set);
		}
		for (const [candidate, set] of sections) expect(set.size, candidate).toBe(1);
	});

	it('公式資料で確認できない係は null であり、空文字で埋めていない', () => {
		for (const unit of directory.organizations) {
			expect(unit.unit === null || unit.unit.length > 0, unit.organizationUnitId).toBe(true);
		}
	});

	it('外部事業体を市の課と区別している', () => {
		const water = directory.organizations.find((u) => u.routingCandidateId === 'water_enterprise');
		expect(water?.organizationType).toBe('external_operator');
		expect(water?.department).toBeNull();
	});

	it('分掌事務の officialText が条文の形を保っている', () => {
		// 要約や言い換えをしていないことの粗い確認。
		const cityUnits = directory.organizations.filter(
			(u) => u.organizationType === 'city_department'
		);
		const texts = cityUnits.flatMap((u) => u.responsibilities.map((r) => r.officialText));
		expect(texts.length).toBeGreaterThan(500);
		expect(texts.filter((t) => t.endsWith('こと。')).length / texts.length).toBeGreaterThan(0.9);
	});
});

describe('routeCriteria / routeLabels', () => {
	it('候補を課レベルに保ち、係で分割しない', () => {
		const criteria = routeCriteria();
		for (const key of Object.keys(criteria)) {
			expect(key, `${key} は課レベルのキーであるべき`).not.toMatch(/\./);
		}
	});

	it('絞り込めない候補を必ず含む', () => {
		expect(Object.keys(routeCriteria())).toContain(OTHER_OR_UNCLEAR);
		expect(routeLabels()[OTHER_OR_UNCLEAR]).toBe('絞り込めない');
	});

	it('候補数が Choice の上限以内', () => {
		expect(Object.keys(routeCriteria()).length).toBeLessThanOrEqual(MAX_CHOICE_OPTIONS);
	});

	it('全候補にラベルがあり、過不足がない', () => {
		expect(Object.keys(routeLabels()).sort()).toEqual(Object.keys(routeCriteria()).sort());
	});

	it('候補説明が長くなりすぎない', () => {
		// state と最長の質問で 32k tokens の制限がある（docs/JEV_DESIGN.md §2）。
		// 分掌事務を載せる分だけ長くなるが、1候補あたりの上限は設けている。
		for (const [key, description] of Object.entries(routeCriteria())) {
			expect(description.length, key).toBeLessThan(600);
		}
	});

	it('候補説明に代表的な分掌事務が載る', () => {
		// publicSummary だけでは条文にある事務が Jev へ届かない。
		const criteria = routeCriteria();
		expect(criteria.policy_planning).toContain('主な分掌');
		expect(criteria.crisis_management).toContain('防犯施設の設置及び管理');
	});

	it('どの課にも現れる定型の分掌を説明へ入れない', () => {
		for (const [key, description] of Object.entries(routeCriteria())) {
			expect(description.includes('課の事務の調整'), key).toBe(false);
		}
	});

	it('主要な担当課が候補に含まれる', () => {
		const labels = Object.values(routeLabels());
		for (const name of ['危機管理課', '建設課', '環境政策課', '市民課', 'こども家庭センター']) {
			expect(labels).toContain(name);
		}
	});

	it('カテゴリは city-directory.json のみを出所とする', () => {
		expect(Object.keys(categoryCriteria()).sort()).toEqual(
			directory.categories.map((c) => c.id).sort()
		);
	});

	it('候補と組織単位の対応が取れている', () => {
		const candidates = routeCandidates();
		expect(candidates.length).toBeGreaterThan(20);
		for (const candidate of candidates) expect(candidate.units.length).toBeGreaterThan(0);
	});
});

describe('resolveUnit', () => {
	it('防犯灯から危機管理課の係と分掌事務を特定する', () => {
		const resolved = resolveUnit('crisis_management', '家の前の防犯灯が切れてます');
		expect(resolved?.unit?.name).toBe('防災・生活安全係');
		expect(resolved?.matched.map((r) => r.officialText)).toContain(
			'防犯施設の設置及び管理に関すること。'
		);
	});

	it('道路の穴から建設課の維持係を特定する', () => {
		const resolved = resolveUnit('construction_works', '道路に大きな穴があって危ない');
		expect(resolved?.unit?.name).toBe('維持係');
		expect(resolved?.matched.length).toBeGreaterThan(0);
	});

	it('ごみから環境政策課の一般廃棄物の分掌へ辿り着く', () => {
		const resolved = resolveUnit('environment_policy', 'ごみの分別方法が分かりません');
		expect(resolved?.matched.some((r) => r.officialText.includes('一般廃棄物'))).toBe(true);
	});

	it('住民票から市民課の窓口係を特定する', () => {
		const resolved = resolveUnit('citizen_services', '住民票を取りたい');
		expect(resolved?.unit?.name).toBe('窓口係');
	});

	it('係まで絞れたときは名称に係を含む', () => {
		const resolved = resolveUnit('citizen_services', '住民票を取りたい');
		expect(resolved?.unit?.officialName).toContain('窓口係');
	});

	it('手がかりが無ければ係を返さない', () => {
		// 配下の係を1つ選んで返すと、判定していない係名を名指しすることに
		// なる。実際に一致0件のまま先頭の係を返し、正しい係と食い違っていた。
		const resolved = resolveUnit('social_welfare', 'よく分からない用件です');
		expect(resolved?.matched).toEqual([]);
		expect(resolved?.unit).toBeNull();
	});

	it('係を返さない場合も課の名称は返す', () => {
		const resolved = resolveUnit('social_welfare', 'よく分からない用件です');
		expect(resolved?.section).toBeTruthy();
		expect(resolved?.sectionOfficialName).toContain(resolved?.section ?? '');
	});

	it('係を返さない場合の名称に係名が混ざらない', () => {
		// 複数の係を持つ課で、どれかの名前が漏れていないことを確かめる。
		const resolved = resolveUnit('social_welfare', 'よく分からない用件です');
		const units = getDirectory()
			.organizations.filter((u) => u.routingCandidateId === 'social_welfare')
			.map((u) => u.unit)
			.filter((u): u is string => u !== null);
		expect(units.length).toBeGreaterThan(1);
		for (const name of units) {
			expect(resolved?.sectionOfficialName.includes(name), name).toBe(false);
		}
	});

	it('未知の候補では null を返す', () => {
		expect(resolveUnit('no_such_candidate', 'x')).toBeNull();
	});
});

describe('sourcesFor', () => {
	it('候補に組織ページと事務組織規則の両方を付ける', () => {
		const sources = sourcesFor('crisis_management');
		expect(sources).toHaveLength(2);
		expect(sources.some((source) => source.sourceId.includes('organization-page'))).toBe(true);
		expect(sources.some((source) => source.sourceId.includes('business-rules'))).toBe(true);
	});

	it('出典に取得日と根拠箇所が入る', () => {
		for (const source of sourcesFor('construction_works')) {
			expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(source.locator.length).toBeGreaterThan(0);
		}
	});

	it('未知の候補では空配列', () => {
		expect(sourcesFor('no_such_candidate')).toEqual([]);
	});
});
