/**
 * SPEC FIND コーパスの検証と出典表示。
 *
 * JSONを型へcastするだけでは、壊れたデータがそのままUIと上流APIへ流れる。
 * CITYデータで同じ穴を踏んでいるため、**画面と出典表示で使う全フィールド**を
 * 読み込み時に検証する（docs/CITY_DATA.md の「読み込み時の検証」と同じ方針）。
 */

import type { SpecCorpus, SpecDocument, SpecPassage } from '$lib/types/spec';

/** 1リクエストへ入れる上限。実測の40件に合わせる。 */
export const MAX_PASSAGES = 40;

/** 1 passage の文字数上限。長すぎる断片は複数の意味を混ぜる。 */
export const MAX_PASSAGE_CHARS = 600;

export type SpecValidationOptions = {
	/** `sourceUrl` に許すホスト。空なら URL を持つ文書を拒否する。 */
	allowedHosts: string[];
};

function fail(detail: string): never {
	throw new Error(`spec-corpus の検証に失敗: ${detail}`);
}

function requireString(value: unknown, where: string): string {
	if (typeof value !== 'string' || value.length === 0) fail(`${where} が空でない文字列でない`);
	return value;
}

/** `YYYY-MM-DD` の実在する日付。画面に版の日付として出る。 */
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

function requireDateOrNull(value: unknown, where: string): void {
	if (value === null || value === undefined) return;
	requireDate(value, where);
}

function requireHttpsUrl(value: unknown, where: string, allowedHosts: string[]): string {
	const text = requireString(value, where);
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return fail(`${where} が URL として解釈できない`);
	}
	if (parsed.protocol !== 'https:') fail(`${where} が https でない`);
	if (!allowedHosts.includes(parsed.hostname)) {
		// ホスト名は例外メッセージへ出さない。CITY側と同じ扱いに揃える。
		fail(`${where} のホストが許可されていない`);
	}
	return text;
}

export function validateCorpus(value: unknown, options: SpecValidationOptions): SpecCorpus {
	if (value === null || typeof value !== 'object') fail('オブジェクトでない');
	const corpus = value as Record<string, unknown>;
	if (corpus.schemaVersion !== '1') fail(`schemaVersion が '1' でない`);

	const doc = corpus.document;
	if (doc === null || typeof doc !== 'object') fail('document がオブジェクトでない');
	const document = doc as Record<string, unknown>;
	const documentId = requireString(document.documentId, 'document.documentId');
	requireString(document.title, 'document.title');
	requireString(document.version, 'document.version');
	requireString(document.contentHash, 'document.contentHash');
	requireDate(document.retrievedAt, 'document.retrievedAt');
	requireDateOrNull(document.publishedAt, 'document.publishedAt');
	requireHttpsUrl(document.sourceUrl, 'document.sourceUrl', options.allowedHosts);

	if (!Array.isArray(corpus.passages)) fail('passages が配列でない');
	const passages = corpus.passages as Record<string, unknown>[];
	if (passages.length === 0) fail('passages が空である');
	if (passages.length > MAX_PASSAGES) {
		// 上限を超えるコーパスをリクエストへ入れない。
		fail(`passages が ${passages.length} 件で上限 ${MAX_PASSAGES} を超える`);
	}

	const ids = new Set<string>();
	const texts = new Set<string>();
	for (const passage of passages) {
		const id = requireString(passage.passageId, 'passages[].passageId');
		if (ids.has(id)) fail(`passageId が重複している: ${id}`);
		ids.add(id);

		if (passage.documentId !== documentId) fail(`${id}.documentId が document と一致しない`);

		const text = requireString(passage.text, `${id}.text`);
		if (text.length > MAX_PASSAGE_CHARS) {
			fail(`${id}.text が ${text.length} 文字で上限 ${MAX_PASSAGE_CHARS} を超える`);
		}
		// 同じ要件の重複passageは版内で一つにまとめる（§5.1）。
		if (texts.has(text)) fail(`${id}.text が他のpassageと同一である`);
		texts.add(text);

		requireString(passage.sectionId, `${id}.sectionId`);
		// 出典表示に使う。欠けると画面に undefined が出る。
		requireString(passage.sourceLocator, `${id}.sourceLocator`);

		if (typeof passage.normalized !== 'boolean') {
			// PDL 1.0 の加工表示を出し分けるため、真偽値であることを要求する。
			fail(`${id}.normalized が真偽値でない`);
		}
		if (passage.page !== null && !Number.isInteger(passage.page)) {
			fail(`${id}.page が整数でも null でもない`);
		}
		requireStringArray(passage.headingPath, `${id}.headingPath`);
		requireStringArray(passage.tags, `${id}.tags`, { allowEmpty: true });
	}

	return value as SpecCorpus;
}

function requireStringArray(value: unknown, where: string, options = { allowEmpty: false }): void {
	if (!Array.isArray(value)) fail(`${where} が配列でない`);
	if (!options.allowEmpty && value.length === 0) fail(`${where} が空である`);
	for (const item of value) {
		if (typeof item !== 'string' || item.length === 0) {
			fail(`${where} に空でない文字列でない要素がある`);
		}
	}
}

/**
 * PDL 1.0 が求める出典表示。
 *
 * digital.go.jp は公共データ利用規約（第1.0版）である。正規化したpassageは
 * 加工物にあたるため、無加工の政府資料として見せてはならない
 * （docs/SPEC_FIND_DESIGN.md §2）。
 */
export function attributionFor(document: SpecDocument, passage: SpecPassage): string {
	const base = `「${document.title}」（デジタル庁）（${document.sourceUrl}）`;
	return passage.normalized ? `${base}を加工して作成` : `出典：${base}`;
}
