import { describe, expect, it } from 'vitest';
import { buildCityBlock } from './city-evidence.server';
import { DISPLAYED_CHOICE_OPTIONS, type ResultCard } from '$lib/types/judge';
import { routeCriteria, routeLabels } from './city-directory.server';
import { cityChecks } from '../../../scripts/lib/city-smoke.mjs';

/** 実データの候補キーで Choice カードを組み立てる。確率は降順。 */
function routeCard(keys: string[]): ResultCard {
	return {
		id: 'route_to',
		kind: 'choice',
		label: '担当課候補',
		selected: keys[0],
		confidence: 0.8,
		options: keys.map((key, index) => ({
			key,
			label: routeLabels()[key] ?? key,
			probability: (keys.length - index) / keys.length
		}))
	};
}

// other_or_unclear は組織に紐づかないため、課の候補としては除く。
const candidateIds = Object.keys(routeCriteria()).filter((key) => key !== 'other_or_unclear');

describe('buildCityBlock', () => {
	it('画面に出る件数ぶんだけ根拠を返す', () => {
		const keys = candidateIds.slice(0, DISPLAYED_CHOICE_OPTIONS + 2);
		const city = buildCityBlock([routeCard(keys)], '防犯灯が切れています');

		expect(city?.candidates).toHaveLength(DISPLAYED_CHOICE_OPTIONS);
		// 出ていない候補の根拠は送らない。レスポンスが無駄に膨らむ。
		expect(city?.candidates.map((c) => c.candidateId)).toEqual(
			keys.slice(0, DISPLAYED_CHOICE_OPTIONS)
		);
	});

	it('候補が3件未満でも落ちない', () => {
		const city = buildCityBlock([routeCard(candidateIds.slice(0, 2))], 'x');
		expect(city?.candidates).toHaveLength(2);
	});

	it('2位・3位にも課名と出典を付ける', () => {
		const city = buildCityBlock([routeCard(candidateIds.slice(0, 3))], 'x');
		for (const candidate of city?.candidates ?? []) {
			expect(candidate.kind).toBe('unit');
			if (candidate.kind !== 'unit') continue;
			expect(candidate.officialName).not.toBe('');
			expect(candidate.section).not.toBe('');
			expect(candidate.sources.length).toBeGreaterThan(0);
		}
	});

	it('選ばれた候補だけに印が付く', () => {
		const city = buildCityBlock([routeCard(candidateIds.slice(0, 3))], 'x');
		expect(city?.candidates.filter((c) => c.selected)).toHaveLength(1);
		expect(city?.candidates[0].selected).toBe(true);
	});

	it('選ばれた候補が上位3件の外でも根拠を返す', () => {
		// selected はモデルの回答であり、分布の最大とは限らない。上位だけで
		// 切ると、Choice の選択チップに出ている候補の課名も出典も無くなる。
		const keys = candidateIds.slice(0, 6);
		const card = routeCard(keys);
		if (card.kind !== 'choice') throw new Error('choice でない');
		card.selected = keys[4];

		const city = buildCityBlock([card], 'x');
		const marked = city?.candidates.filter((c) => c.selected) ?? [];
		expect(marked).toHaveLength(1);
		expect(marked[0].candidateId).toBe(keys[4]);
		// 上位3件は落とさず、選ばれた候補を足す。
		expect(city?.candidates.map((c) => c.candidateId)).toEqual([...keys.slice(0, 3), keys[4]]);
	});

	it('組織データに紐づかない候補は unroutable にする', () => {
		// other_or_unclear は「絞り込めない」を表す正規の候補。落とすと、
		// 画面の Choice には出ているのに根拠欄から消える。unit として返すと
		// 出典が空の課になり「出典データ未登録」と誤った原因を示す。
		const city = buildCityBlock([routeCard(['other_or_unclear', candidateIds[0]])], 'x');
		expect(city?.candidates.map((c) => c.candidateId)).toEqual([
			'other_or_unclear',
			candidateIds[0]
		]);

		const [unclear, unit] = city?.candidates ?? [];
		expect(unclear.kind).toBe('unroutable');
		expect(unit.kind).toBe('unit');
		// 画面に出す名前は持たせる。無名の行にしない。
		if (unclear.kind === 'unroutable') expect(unclear.label).toBe('絞り込めない');
	});

	it('other_or_unclear が正規の候補として存在する', () => {
		// この前提が崩れると上のテストが意味を失う（docs/JEV_DESIGN.md §7）。
		expect(Object.keys(routeCriteria())).toContain('other_or_unclear');
	});

	it('データセットに無い候補も落とさず unroutable にする', () => {
		const city = buildCityBlock([routeCard(['no-such-candidate'])], 'x');
		expect(city?.candidates.map((c) => c.kind)).toEqual(['unroutable']);
	});

	it('route_to カードが無ければ候補を空にする', () => {
		const city = buildCityBlock([], 'x');
		expect(city?.candidates).toEqual([]);
		// バージョンと架空フラグは候補の有無に関わらず返す。
		expect(city?.directoryVersion).toBe('mcity-2026-04-01');
		expect(city?.fictional).toBe(true);
	});
});

/**
 * 受入確認を本物のレスポンスに当てる。
 *
 * scripts/check-deployment.mjs は型検査の外にあり、CI でも動かない
 * （デプロイ先の URL が要る）。レスポンスの形を変えたときに気付けるよう、
 * 実際の組み立て結果を通す。以前 `city.sources` を見たままになっていて、
 * URL が漏れていても合格する検査になっていた。
 */
describe('受入確認との整合', () => {
	it('実際のレスポンスが check-deployment の検査を通る', () => {
		const city = buildCityBlock([routeCard(candidateIds.slice(0, 3))], '防犯灯が切れています');
		const results = cityChecks({ city });
		expect(results.filter((result) => !result.ok)).toEqual([]);
	});

	it('URL を持つ出典を混ぜると落ちる（空振りでないこと）', () => {
		const city = buildCityBlock([routeCard(candidateIds.slice(0, 3))], 'x');
		const first = city?.candidates[0];
		if (first?.kind !== 'unit') throw new Error('unit でない');
		first.sources[0].url = 'https://example.test/soshiki';

		const failed = cityChecks({ city }).filter((result) => !result.ok);
		expect(failed.map((result) => result.name)).toEqual(['出典に URL を持たない']);
	});
});
