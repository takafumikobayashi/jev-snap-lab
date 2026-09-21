/**
 * BATCH JUDGE fixture の検証。
 *
 * SPEC FIND と同じ方針で、**評価と画面で使う全フィールド**を読み込み時に
 * 検証する（[spec-corpus.server.ts](spec-corpus.server.ts) と docs/CITY_DATA.md
 * の「読み込み時の検証」）。castだけで通すと、goldの綴り違いが「不一致」として
 * 集計され、benchmark の結論がデータの壊れ方を測ってしまう。
 */

import {
	BATCH_THEMES,
	DEADLINE_CLASSES,
	DX_CLASSES,
	PRIVACY_VERDICTS,
	type BatchCase,
	type BatchDataset,
	type BatchDifficulty,
	type BatchTheme
} from '$lib/types/batch';

/** 1リクエストへ入れる事例の上限。benchmark の「件数」側の上限。 */
export const MAX_CASES = 50;

/** 1事例の文字数上限。画面の入力上限（280字）に合わせる。 */
export const MAX_CASE_CHARS = 280;

/**
 * 件数と1件あたりの上限から決まる、state 本文の最大文字数。
 *
 * SPEC FIND では総量の上限を別に置いたが、BATCH JUDGE では要らない。
 * 50件 × 280字 = 14,000字が構造上の天井で、SPEC FIND の実測（文字あたり
 * 1.087 state token）から約15,200 tokens、`state` + 最長の質問 32k の
 * 半分以下に収まるためである。
 *
 * **効いてくるのは質問側である。** DX は 50件 × 5軸 = 250問になり、質問
 * 1問あたり113 tokensの実測から約28,000 tokens、リクエスト全体 64k の
 * 44%を占める。`MAX_CASES` を上げる前に docs/BATCH_JUDGE_DESIGN.md §4.1
 * の実測をやり直すこと。state に余裕があることは質問の余裕ではない。
 */
export const MAX_STATE_CHARS_CEILING = MAX_CASES * MAX_CASE_CHARS;

const DIFFICULTIES: BatchDifficulty[] = ['easy', 'medium', 'hard'];

function fail(detail: string): never {
	throw new Error(`batch-dataset の検証に失敗: ${detail}`);
}

/** `YYYY-MM-DD` の実在する日付。gold の基準になるため、形だけでは足りない。 */
function requireDate(value: unknown, where: string): string {
	const text = requireString(value, where);
	const parsed = new Date(`${text}T00:00:00Z`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
		Number.isNaN(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== text
	) {
		fail(`${where} が YYYY-MM-DD の日付でない`);
	}
	return text;
}

function requireString(value: unknown, where: string): string {
	if (typeof value !== 'string' || value.length === 0) fail(`${where} が空でない文字列でない`);
	return value;
}

/** テーマごとの gold の形。ここを緩めると不一致の集計が意味を失う。 */
function validateGold(theme: BatchTheme, gold: unknown, where: string): void {
	const allowed = { privacy: PRIVACY_VERDICTS, deadline: DEADLINE_CLASSES, dx: DX_CLASSES }[theme];
	if (!allowed.includes(gold as never)) fail(`${where} が ${theme} のラベルでない`);
}

export function validateDataset(value: unknown): BatchDataset {
	if (value === null || typeof value !== 'object') fail('オブジェクトでない');
	const dataset = value as Record<string, unknown>;
	if (dataset.schemaVersion !== '1') fail(`schemaVersion が '1' でない`);

	const theme = dataset.theme;
	if (!BATCH_THEMES.includes(theme as never)) fail('theme が既知のテーマでない');
	requireString(dataset.label, 'label');
	// DEADLINE は絶対日付を含む。基準日が無いと gold が再現しない。
	if (theme === 'deadline' || dataset.referenceDate !== undefined) {
		requireDate(dataset.referenceDate, 'referenceDate');
	}

	if (!Array.isArray(dataset.cases)) fail('cases が配列でない');
	const cases = dataset.cases as Record<string, unknown>[];
	if (cases.length === 0) fail('cases が空である');
	if (cases.length > MAX_CASES) {
		fail(`cases が ${cases.length} 件で上限 ${MAX_CASES} を超える`);
	}

	const ids = new Set<string>();
	const texts = new Set<string>();
	for (const item of cases) {
		const id = requireString(item.id, 'cases[].id');
		if (ids.has(id)) fail(`id が重複している: ${id}`);
		ids.add(id);
		// IDはテーマ横断で使う。接頭辞がずれると質問IDの対応表が狂う。
		if (!id.startsWith(`${theme as string}_`)) fail(`${id} が theme の接頭辞で始まっていない`);

		const text = requireString(item.text, `${id}.text`);
		if (text.length > MAX_CASE_CHARS) {
			fail(`${id}.text が ${text.length} 文字で上限 ${MAX_CASE_CHARS} を超える`);
		}
		// 同じ文が二度入ると、一致率がその文の難しさに引きずられる。
		if (texts.has(text)) fail(`${id}.text が他の事例と同一である`);
		texts.add(text);

		if (!DIFFICULTIES.includes(item.difficulty as BatchDifficulty)) {
			fail(`${id}.difficulty が easy / medium / hard でない`);
		}
		if (item.note !== undefined) requireString(item.note, `${id}.note`);
		validateGold(theme as BatchTheme, item.gold, `${id}.gold`);
	}

	return value as BatchDataset;
}

/** 難易度とラベルの内訳。benchmark の結果を難易度別に読むために使う。 */
export function summarizeDataset(dataset: BatchDataset): {
	cases: number;
	difficulty: Record<BatchDifficulty, number>;
	gold: Record<string, number>;
} {
	const difficulty: Record<BatchDifficulty, number> = { easy: 0, medium: 0, hard: 0 };
	const gold: Record<string, number> = {};
	for (const item of dataset.cases as BatchCase[]) {
		difficulty[item.difficulty] += 1;
		gold[item.gold] = (gold[item.gold] ?? 0) + 1;
	}
	return { cases: dataset.cases.length, difficulty, gold };
}
