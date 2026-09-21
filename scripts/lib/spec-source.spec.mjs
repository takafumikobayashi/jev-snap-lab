import { describe, expect, it } from 'vitest';
import { detectVersion, verifySource } from './spec-source.mjs';

const PINNED = {
	title: '地方公共団体情報システム共通機能標準仕様書',
	version: '2.7',
	contentHash: 'sha256-aaa'
};

/** 表紙（1ページ目）と本文を模す。 */
const cover = (version = '2.7') =>
	`地方公共団体情報システム\n 共通機能標準仕様書\n   【第 ${version} 版】\n\n令和８年（2026 年）２月\n\n   デジタル庁\n\f目次\n\f本文`;

describe('verifySource', () => {
	it('固定した出典と一致すれば問題なし', () => {
		expect(verifySource({ contentHash: 'sha256-aaa', text: cover(), pinned: PINNED })).toEqual([]);
	});

	it('hash が違えば拒否し、両方の値を示す', () => {
		// 別のPDFでもメタデータは固定値で名乗ってしまう。生成前に止める。
		const problems = verifySource({ contentHash: 'sha256-bbb', text: cover(), pinned: PINNED });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('sha256-aaa');
		expect(problems[0]).toContain('sha256-bbb');
	});

	it('版が違えば、その版を示して拒否する', () => {
		// hash違いだけでは「何を渡したのか」が分からない。改版なのか
		// 取り違えなのかを切り分けられるようにする。
		const problems = verifySource({
			contentHash: 'sha256-bbb',
			text: cover('2.8'),
			pinned: PINNED
		});
		expect(problems.some((p) => p.includes('2.8'))).toBe(true);
	});

	it('別の文書なら題名で弾く', () => {
		const problems = verifySource({
			contentHash: 'sha256-aaa',
			text: '全く別の資料\n 【第 2.7 版】\n\f本文',
			pinned: PINNED
		});
		expect(problems.some((p) => p.includes('表紙に'))).toBe(true);
	});

	it('版を読み取れなくても素通りさせない', () => {
		const problems = verifySource({
			contentHash: 'sha256-aaa',
			text: `${PINNED.title}\n\f本文`,
			pinned: PINNED
		});
		expect(problems.some((p) => p.includes('読み取れない'))).toBe(true);
	});

	it('表紙より後ろの版表記に釣られない', () => {
		// 本文中に他版への言及があっても、判定は表紙だけで行う。
		const text = `${cover('2.7')}\n第 9.9 版について`;
		expect(verifySource({ contentHash: 'sha256-aaa', text, pinned: PINNED })).toEqual([]);
	});
});

describe('detectVersion', () => {
	it('表紙の【第 X.Y 版】を読む', () => {
		expect(detectVersion(cover('2.7'))).toBe('2.7');
		expect(detectVersion(cover('10.12'))).toBe('10.12');
	});

	it('無ければ null', () => {
		expect(detectVersion('題名だけ\n\f本文')).toBeNull();
	});
});
