/**
 * CITY の根拠ブロックを組み立てる。
 *
 * Jev が返した候補の ID で静的データへ join する。係はローカルのキーワード
 * 一致で解決し、決められない場合は課までに留める（docs/CITY_DATA.md §5）。
 * Jev に係を判定させない。
 *
 * 根拠は**画面に出る上位候補すべて**に付ける。選ばれた1件だけに付けると、
 * 候補が割れた入力ほど比較材料が無くなる。2位・3位は確率だけが並び、
 * 課名も分掌も出典も分からない。判断材料として見せる設計
 * （docs/PRODUCT_SPEC.md §1）と噛み合わない。
 */

import type { CityCandidateEvidence, JudgeResponse } from '$lib/types/judge';
import { displayedOptions } from '$lib/display';
import {
	directoryVersion,
	isFictional,
	resolveUnit,
	sourcesFor
} from '$lib/server/city-directory.server';

/** 担当課候補を載せている Choice カードの ID。 */
const ROUTE_CARD_ID = 'route_to';

export function buildCityBlock(
	results: JudgeResponse['results'],
	text: string
): JudgeResponse['city'] {
	const routeTo = results.find((card) => card.id === ROUTE_CARD_ID);

	return {
		directoryVersion: directoryVersion(),
		fictional: isFictional(),
		candidates:
			routeTo?.kind === 'choice'
				? // 画面が折り畳まずに見せる候補と同じ集合に根拠を付ける。出ていない
					// 候補の根拠は送らない。選ばれた候補は上位に無くても必ず含める。
					displayedOptions(routeTo.options, routeTo.selected).map((option) =>
						evidenceFor(option, routeTo.selected, text)
					)
				: []
	};
}

/**
 * 候補1件ぶんの根拠。
 *
 * 組織データに対応する課が無い候補（`other_or_unclear`、および万一データに
 * 無い ID）は `unroutable` として返す。落とすと、画面の Choice には出ている
 * 候補が根拠欄から消え、下位の候補が答えであるかのように見える。
 */
function evidenceFor(
	option: { key: string; label: string; probability: number },
	selectedId: string,
	text: string
): CityCandidateEvidence {
	const base = {
		candidateId: option.key,
		probability: option.probability,
		selected: option.key === selectedId
	};

	const resolved = resolveUnit(option.key, text);
	if (!resolved) return { ...base, kind: 'unroutable', label: option.label };

	return {
		...base,
		kind: 'unit',
		// 係まで絞れた場合だけ係を含む名称になる。絞れなければ課まで。
		officialName: resolved.unit?.officialName ?? resolved.sectionOfficialName,
		section: resolved.section,
		unit: resolved.unit?.name ?? null,
		// 一致した分掌事務。空なら課までしか絞れていない。
		matchedResponsibilities: resolved.matched.map((responsibility) => ({
			officialText: responsibility.officialText,
			responsibilityId: responsibility.responsibilityId
		})),
		sources: sourcesFor(option.key)
	};
}
