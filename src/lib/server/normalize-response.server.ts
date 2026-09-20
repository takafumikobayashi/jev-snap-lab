/**
 * TypeSafe のレスポンスを検証し、UI 用の `ResultCard` へ正規化する。
 *
 * 生レスポンスはブラウザへ渡さない。typed output は「形」を保証するが
 * 「中身の正しさ」は保証しないため、確率の範囲と合計、候補キーの一致、
 * legend の段数をサーバー側で確認する。出所は docs/JEV_DESIGN.md の §8 / §10。
 */

import type { Question, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { ChoiceCard, NoulCard, ResultCard, ScoreCard } from '$lib/types/judge';
import { JudgeError } from './errors.server';
import type { QuestionCatalog } from './question-catalog.server';

/**
 * 確率の合計が 1 からどれだけずれてよいか。
 *
 * 公式は「floats that sum to 1」と定めている。JSON の丸めを吸収しつつ、
 * 実際の破綻（候補の欠落、正規化漏れ）は捕まえられる幅にする。
 */
const PROBABILITY_SUM_TOLERANCE = 1e-3;

/** トークン数は 0 以上の有限な整数で返る。 */
function assertTokenCount(value: unknown, where: string): void {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw contractError(`${where} が 0 以上の数値でない`);
	}
}

/** 上流の応答が契約に反した場合。再試行可能な上流障害として扱う。 */
function contractError(detail: string): JudgeError {
	return new JudgeError('UPSTREAM_UNAVAILABLE', `Jev レスポンスの契約違反: ${detail}`);
}

function assertProbability(value: unknown, where: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
		throw contractError(`${where} の確率が 0..1 の数値でない`);
	}
	return value;
}

/**
 * オブジェクトのキー集合が期待と完全に一致するか。
 *
 * 必要なキーの存在だけを見ると、余分なキーや想定外のキーを見逃す。
 * 上流が別の尺度で答えている可能性があるため、過不足の両方を見る。
 */
function assertExactKeys(
	value: unknown,
	expected: string[],
	where: string
): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw contractError(`${where} がオブジェクトでない`);
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record);
	const missing = expected.filter((key) => !actual.includes(key));
	const unexpected = actual.filter((key) => !expected.includes(key));
	if (missing.length > 0 || unexpected.length > 0) {
		throw contractError(
			`${where} のキーが一致しない (欠落: ${missing.join(',') || 'なし'} / 余分: ${unexpected.join(',') || 'なし'})`
		);
	}
	return record;
}

function assertProbabilitySum(probabilities: number[], where: string): void {
	const sum = probabilities.reduce((total, value) => total + value, 0);
	if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
		throw contractError(`${where} の確率の合計が ${sum} で 1 から離れている`);
	}
}

function normalizeChoice(
	id: string,
	question: Extract<Question, { type: 'choice' }>,
	answer: Record<string, unknown>,
	catalog: QuestionCatalog
): ChoiceCard {
	const criteriaKeys = Object.keys(question.criteria);
	const record = assertExactKeys(answer.probabilities, criteriaKeys, `${id} の候補`);

	const selected = answer.choice;
	if (typeof selected !== 'string' || !criteriaKeys.includes(selected)) {
		// 送っていない候補が返るのは契約違反。そのまま画面へ出さない。
		throw contractError(`${id} の choice が criteria に存在しない`);
	}

	const labels = catalog.optionLabels[id] ?? {};
	const options = criteriaKeys.map((key) => ({
		key,
		label: labels[key] ?? key,
		probability: assertProbability(record[key], `${id}.${key}`)
	}));

	assertProbabilitySum(
		options.map((option) => option.probability),
		id
	);

	// 確率の降順で返す。UI は上位 N 件を出すだけでよくなる。
	options.sort((a, b) => b.probability - a.probability);

	return {
		id,
		label: catalog.labels[id] ?? id,
		kind: 'choice',
		selected,
		options,
		confidence: assertProbability(answer.confidence, `${id}.confidence`)
	};
}

function normalizeScore(
	id: string,
	question: Extract<Question, { type: 'score' }>,
	answer: Record<string, unknown>,
	catalog: QuestionCatalog
): ScoreCard {
	const levelCount = question.criteria.length;
	const scoreLabels = catalog.scoreLabels[id];

	if (!scoreLabels || scoreLabels.length !== levelCount) {
		// カタログ側の不整合。上流ではなくアプリのバグ。
		throw new JudgeError(
			'QUESTION_DEFINITION_ERROR',
			`${id} の scoreLabels が criteria と一致しない`
		);
	}

	// レベル番号は 0 始まりの連番。余分なキーや飛びを許さない。
	const levels = Array.from({ length: levelCount }, (_, level) => String(level));
	assertExactKeys(answer.legend, levels, `${id}.legend`);
	const record = assertExactKeys(answer.probabilities, levels, `${id}.probabilities`);

	const byLevel: Record<string, number> = {};
	for (const level of levels) {
		byLevel[level] = assertProbability(record[level], `${id}.${level}`);
	}
	assertProbabilitySum(Object.values(byLevel), id);

	const score = answer.score;
	if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > levelCount - 1) {
		throw contractError(`${id} の score が 0..${levelCount - 1} の範囲外`);
	}

	// 表示ラベルは legend（英語がそのまま返る）ではなく、日本語の
	// scoreLabels から取る。どのレベルを指すかは score の丸めではなく
	// probabilities の最大値で決める（docs/JEV_DESIGN.md §8）。
	const japaneseLegend: Record<string, string> = {};
	for (let level = 0; level < levelCount; level += 1) {
		japaneseLegend[String(level)] = scoreLabels[level];
	}

	return {
		id,
		label: catalog.labels[id] ?? id,
		kind: 'score',
		score,
		legend: japaneseLegend,
		probabilities: byLevel,
		confidence: assertProbability(answer.confidence, `${id}.confidence`)
	};
}

function normalizeNoul(
	id: string,
	answer: Record<string, unknown>,
	catalog: QuestionCatalog
): NoulCard {
	return {
		id,
		label: catalog.labels[id] ?? id,
		kind: 'noul',
		yesProbability: assertProbability(answer.noul, `${id}.noul`)
	};
}

/**
 * 最大確率のレベル番号。同率なら小さいレベルを採る。
 *
 * `Math.round(score)` を使わないのは、分布が二峰性のとき丸めた値が
 * 最大確率のレベルと一致しないことがあるため。
 */
export function dominantLevel(probabilities: Record<string, number>): string {
	let best = '0';
	let bestValue = -1;
	for (const level of Object.keys(probabilities).sort((a, b) => Number(a) - Number(b))) {
		if (probabilities[level] > bestValue) {
			best = level;
			bestValue = probabilities[level];
		}
	}
	return best;
}

/** Score カードの表示ラベル。 */
export function scoreDisplayLabel(card: ScoreCard): string {
	return card.legend[dominantLevel(card.probabilities)];
}

/**
 * 全質問の答えを検証して `ResultCard[]` にする。
 *
 * カードの順序は質問定義の順序に従う。欠けている答えがあればエラーにする。
 */
export function normalizeAnswers(
	catalog: QuestionCatalog,
	result: SystemOneResult<Questions>
): ResultCard[] {
	// 上流の応答の骨格から確認する。null や配列が来た場合に内部例外へ
	// 流さず、契約違反として扱う。
	if (typeof result.model !== 'string' || result.model.length === 0) {
		throw contractError('model が空でない文字列でない');
	}
	assertTokenCount(result.usage?.input_tokens, 'usage.input_tokens');
	assertTokenCount(result.usage?.output_tokens, 'usage.output_tokens');

	const source = result.answers as unknown;
	if (source === null || typeof source !== 'object' || Array.isArray(source)) {
		throw contractError('answers がオブジェクトでない');
	}

	const answers = source as Record<string, unknown>;
	const cards: ResultCard[] = [];

	for (const [id, question] of Object.entries(catalog.questions)) {
		const answer = answers[id];
		if (answer === null || typeof answer !== 'object') {
			throw contractError(`${id} の答えが無い`);
		}

		const record = answer as Record<string, unknown>;
		if (record.type !== question.type) {
			throw contractError(`${id} の type が ${String(record.type)} で質問と一致しない`);
		}

		if (question.type === 'choice') cards.push(normalizeChoice(id, question, record, catalog));
		else if (question.type === 'score') cards.push(normalizeScore(id, question, record, catalog));
		else cards.push(normalizeNoul(id, record, catalog));
	}

	return cards;
}
