import { describe, it, expect } from 'vitest';
import {
  parseAiCapacityJsonl,
  toItemNameEntry,
  aggregateItemNames,
  buildItemNameRows,
  summarizeCoverage,
  formatCoverageReport,
  toSlug,
} from '../scripts/lib/item-names.ts';

const itemUrl = (shop: string, code: string) => `https://item.rakuten.co.jp/${shop}/${code}/`;

const affiliateUrl = (shop: string, code: string) =>
  `https://hb.afl.rakuten.co.jp/hgc/xxx/?pc=${encodeURIComponent(itemUrl(shop, code))}&m=x`;

const record = (over: Record<string, unknown> = {}) => ({
  articleFile: 'src/content/articles/laundry-gel-ball-comparison.md',
  rank: 1,
  category: 'laundry-gel-ball',
  method: '[Item/Get]',
  current: { name: 'ボールド ジェルボール', rakutenUrl: affiliateUrl('shopA', 'item1') },
  api: { itemName: 'ボールド ジェルボール 4D 70個', itemUrl: affiliateUrl('shopA', 'item1') },
  ...over,
});

describe('parseAiCapacityJsonl', () => {
  it('壊れた行を捨てて有効な行だけ返す', () => {
    const text = `${JSON.stringify(record())}\n\n{"broken": \n${JSON.stringify(record({ rank: 2 }))}\n`;
    const parsed = parseAiCapacityJsonl(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].rank).toBe(2);
  });
});

describe('toItemNameEntry', () => {
  it('current.rakutenUrl から shopCode/itemCode をキーにする', () => {
    const entry = toItemNameEntry(record(), '2026-08-22');
    expect(entry).not.toBeNull();
    expect(entry!.key).toBe('shopa/item1');
    expect(entry!.keySource).toBe('current.rakutenUrl');
    expect(entry!.sourceDate).toBe('2026-08-22');
  });

  it('method を必ず保持する（[Search] 由来を [Item/Get] と混ぜないため）', () => {
    const entry = toItemNameEntry(record({ method: '[Search]' }), '2026-08-22');
    expect(entry!.method).toBe('[Search]');
  });

  it('current.rakutenUrl が欠けていれば api.itemUrl にフォールバックする', () => {
    const entry = toItemNameEntry(
      record({ current: { name: 'x', rakutenUrl: null } }),
      '2026-08-22'
    );
    expect(entry!.key).toBe('shopa/item1');
    expect(entry!.keySource).toBe('api.itemUrl');
  });

  it('api.itemName が無いレコードは捨てる', () => {
    expect(toItemNameEntry(record({ api: { itemUrl: itemUrl('shopA', 'item1') } }), '2026-08-22')).toBeNull();
  });

  it('どちらの URL からもキーが取れなければ捨てる', () => {
    const entry = toItemNameEntry(
      record({ current: { name: 'x', rakutenUrl: 'https://example.com/x' }, api: { itemName: 'y', itemUrl: null } }),
      '2026-08-22'
    );
    expect(entry).toBeNull();
  });
});

describe('aggregateItemNames', () => {
  it('同一キーは最新ファイルの値を採る（rank が入れ替わっても壊れない）', () => {
    const aggregated = aggregateItemNames([
      {
        date: '2026-08-22',
        text: JSON.stringify(record({ rank: 7, api: { itemName: '新しい出品名', itemUrl: itemUrl('shopA', 'item1') } })),
      },
      {
        date: '2026-05-11',
        text: JSON.stringify(record({ rank: 1, api: { itemName: '古い出品名', itemUrl: itemUrl('shopA', 'item1') } })),
      },
    ]);
    expect(aggregated.size).toBe(1);
    expect(aggregated.get('shopa/item1')!.itemName).toBe('新しい出品名');
    expect(aggregated.get('shopa/item1')!.sourceDate).toBe('2026-08-22');
  });

  it('大文字小文字が違う shopCode/itemCode を同一キーに束ねる', () => {
    const aggregated = aggregateItemNames([
      { date: '2026-05-11', text: JSON.stringify(record({ current: { name: 'a', rakutenUrl: itemUrl('ShopA', 'Item1') } })) },
      { date: '2026-08-22', text: JSON.stringify(record({ current: { name: 'b', rakutenUrl: itemUrl('shopa', 'item1') } })) },
    ]);
    expect([...aggregated.keys()]).toEqual(['shopa/item1']);
  });
});

describe('toSlug', () => {
  it('記事パスから slug を取り出す', () => {
    expect(toSlug('src/content/articles/laundry-gel-ball-comparison.md')).toBe('laundry-gel-ball');
    expect(toSlug('src/content/articles/reviews/foo.mdx')).toBe('foo');
    expect(toSlug(null)).toBeNull();
  });
});

describe('buildItemNameRows / summarizeCoverage', () => {
  const currentProducts = [
    {
      articleFile: 'src/content/articles/laundry-gel-ball-comparison.md',
      slug: 'laundry-gel-ball',
      rank: 1,
      name: 'ボールド ジェルボール',
      rakutenUrl: affiliateUrl('shopA', 'item1'),
    },
    {
      articleFile: 'src/content/articles/laundry-gel-ball-comparison.md',
      slug: 'laundry-gel-ball',
      rank: 2,
      name: 'アリエール ジェルボール',
      rakutenUrl: affiliateUrl('shopB', 'item2'),
    },
  ];

  const aggregated = aggregateItemNames([
    { date: '2026-08-22', text: JSON.stringify(record()) },
    {
      // 記事から削除済みの商品（是正前 gel-ball 相当）。集約にしか残らない
      date: '2026-07-01',
      text: JSON.stringify(
        record({
          rank: 3,
          method: '[Search]',
          current: { name: 'さらさ ジェルボール', rakutenUrl: itemUrl('shopC', 'item3') },
          api: { itemName: 'JK-0.5芯 サラサ3 ジェル ボールペン替え芯', itemUrl: itemUrl('shopC', 'item3') },
        })
      ),
    },
  ]);

  it('現商品を母数にし、取れなかった商品は known:false（判定不能）にする', () => {
    const rows = buildItemNameRows(aggregated, currentProducts);
    const current = rows.filter(r => r.inCurrent);
    expect(current).toHaveLength(2);
    expect(current[0]).toMatchObject({ known: true, method: '[Item/Get]', itemName: 'ボールド ジェルボール 4D 70個' });
    expect(current[1]).toMatchObject({ known: false, itemName: null, method: null });
  });

  it('現商品に紐づかない履歴エントリも inCurrent:false で残す（削除済み商品の実出品名）', () => {
    const rows = buildItemNameRows(aggregated, currentProducts);
    const historical = rows.filter(r => !r.inCurrent);
    expect(historical).toHaveLength(1);
    expect(historical[0]).toMatchObject({
      key: 'shopc/item3',
      slug: 'laundry-gel-ball',
      currentName: null,
      method: '[Search]',
    });
    expect(historical[0].itemName).toContain('ボールペン替え芯');
  });

  it('includeHistorical:false で履歴を落とせる', () => {
    const rows = buildItemNameRows(aggregated, currentProducts, { includeHistorical: false });
    expect(rows.every(r => r.inCurrent)).toBe(true);
  });

  it('カバー率は現商品だけを母数にする（履歴で水増ししない）', () => {
    const summary = summarizeCoverage(buildItemNameRows(aggregated, currentProducts));
    expect(summary.total).toBe(2);
    expect(summary.known).toBe(1);
    expect(summary.unknown).toBe(1);
    expect(summary.coverage).toBeCloseTo(0.5);
    expect(summary.historical).toBe(1);
    expect(summary.byMethod).toEqual([{ method: '[Item/Get]', count: 1 }]);
    expect(summary.unknownBySlug).toEqual([{ slug: 'laundry-gel-ball', unknown: 1, total: 2 }]);
  });

  it('レポート冒頭に母数と unknown を明示する', () => {
    const summary = summarizeCoverage(buildItemNameRows(aggregated, currentProducts));
    const report = formatCoverageReport(summary, {
      today: '2026-08-23',
      sourceFileCount: 85,
      jsonlPath: 'reports/item-names/item-names-2026-08-23.jsonl',
    });
    expect(report).toContain('母数（現 frontmatter の商品数）: **2**');
    expect(report).toContain('unknown（実出品名なし＝判定不能）: 1');
    expect(report).toContain('判定不能');
  });
});
