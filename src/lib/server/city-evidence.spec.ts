import { describe, expect, it } from 'vitest';
import { buildCityBlock } from './city-evidence.server';
import { DISPLAYED_CHOICE_OPTIONS, type ResultCard } from '$lib/types/judge';
import { routeCriteria } from './city-directory.server';

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
			label: key,
			probability: (keys.length - index) / keys.length
		}))
	};
}

const candidateIds = Object.keys(routeCriteria());

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

	it('データセットに無い候補は落とす', () => {
		// criteria はデータから生成しているため通常は起きないが、
		// 返ってきた ID を無条件に信用しない。
		const city = buildCityBlock([routeCard(['no-such-candidate', candidateIds[0]])], 'x');
		expect(city?.candidates.map((c) => c.candidateId)).toEqual([candidateIds[0]]);
	});

	it('route_to カードが無ければ候補を空にする', () => {
		const city = buildCityBlock([], 'x');
		expect(city?.candidates).toEqual([]);
		// バージョンと架空フラグは候補の有無に関わらず返す。
		expect(city?.directoryVersion).toBe('mcity-2026-04-01');
		expect(city?.fictional).toBe(true);
	});
});
