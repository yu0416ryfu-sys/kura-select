import { describe, it, expect } from "vitest";
import {
  extractRakutenItemCode,
  buildProductKey,
  buildRecordsFromArticle,
  mergeRecords,
  serializeJsonl,
  parseJsonl,
  summarizePriceHistory,
  summarizeByProduct,
  type PriceHistoryRecord,
} from "../scripts/lib/price-history";

const AFFILIATE_URL =
  "https://hb.afl.rakuten.co.jp/hgc/g00po93n.3rdw6ce8.g00po93n.3rdw7d35/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fi-order%2F501277%2F&m=http%3A%2F%2Fm.rakuten.co.jp%2Fi-order%2Fi%2F10000833%2F&rafcid=wsc_i_is_42b71141-7589-447e-ab9f-1c5e97e9d61f";

function article(products: string): string {
  return `---
title: "テスト記事"
products:
${products}
---

本文。
`;
}

function record(overrides: Partial<PriceHistoryRecord> = {}): PriceHistoryRecord {
  return {
    articleId: "dish-detergent-comparison",
    capturedAt: "2026-08-01",
    commit: null,
    productKey: "rk:i-order/501277",
    itemCode: "i-order/501277",
    name: "テスト商品",
    rank: 1,
    provider: "rakuten",
    price: 1000,
    capacity: "4000mL",
    ...overrides,
  };
}

describe("extractRakutenItemCode", () => {
  it("アフィリエイトURLの pc= から shop/code を取り出す", () => {
    expect(extractRakutenItemCode(AFFILIATE_URL)).toBe("i-order/501277");
  });

  it("pc= が無い / 対象外ホスト / 空文字は null", () => {
    expect(extractRakutenItemCode("https://hb.afl.rakuten.co.jp/hgc/abc/")).toBeNull();
    expect(extractRakutenItemCode("https://example.com/foo/bar/")).toBeNull();
    expect(extractRakutenItemCode("")).toBeNull();
  });
});

describe("buildProductKey", () => {
  it("itemCode があれば rk: 前置（大文字小文字を揃える）", () => {
    expect(buildProductKey(AFFILIATE_URL, "無関係な名前")).toBe("rk:i-order/501277");
    expect(buildProductKey("https://item.rakuten.co.jp/I-Order/501277/", "x")).toBe(
      "rk:i-order/501277"
    );
  });

  it("itemCode が取れなければ nm: 前置で normalizeItemName を通す", () => {
    // 全角英数字は normalizeItemName で半角化される
    expect(buildProductKey(null, "ダウニー２．８Ｌ")).toBe("nm:ダウニー2.8L");
  });
});

describe("buildRecordsFromArticle", () => {
  const content = article(`  - rank: 1
    name: "チャーミーグリーン 4L"
    price: 1876
    capacity: "4000mL"
    rakutenUrl: "${AFFILIATE_URL}"
    offers:
      - provider: "yahoo"
        price: 1990
        url: "https://example.com/y"
      - provider: "amazon"
        url: "https://example.com/a"`);

  it("rakuten 1行 + price を持つ offer の行が出る", () => {
    const records = buildRecordsFromArticle("dish-detergent-comparison", content, "2026-08-17", "cf7c256");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      articleId: "dish-detergent-comparison",
      capturedAt: "2026-08-17",
      commit: "cf7c256",
      productKey: "rk:i-order/501277",
      itemCode: "i-order/501277",
      rank: 1,
      provider: "rakuten",
      price: 1876,
      capacity: "4000mL",
    });
    expect(records[1]).toMatchObject({ provider: "yahoo", price: 1990 });
  });

  it("offers[].price が無い offer は行を出さない", () => {
    const records = buildRecordsFromArticle("a", content, "2026-08-17", null);
    expect(records.some(r => r.provider === "amazon")).toBe(false);
  });

  it("price: 0 は行を出さない", () => {
    const zero = article(`  - rank: 1
    name: "無価格商品"
    price: 0
    capacity: "1L"
    rakutenUrl: "${AFFILIATE_URL}"`);
    expect(buildRecordsFromArticle("a", zero, "2026-08-17", null)).toHaveLength(0);
  });

  it("capacity が取れない商品は capacity: null をキーとして持つ", () => {
    const noCapacity = article(`  - rank: 2
    name: "容量不明商品"
    price: 500
    rakutenUrl: "${AFFILIATE_URL}"`);
    const records = buildRecordsFromArticle("a", noCapacity, "2026-08-17", null);
    expect(records).toHaveLength(1);
    expect("capacity" in records[0]).toBe(true);
    expect(records[0].capacity).toBeNull();
  });
});

describe("mergeRecords", () => {
  it("同日・同 productKey・同 provider は後勝ちで1行", () => {
    const merged = mergeRecords(
      [record({ price: 1000 })],
      [record({ price: 1200 })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].price).toBe(1200);
  });

  it("日が違えば両方残る", () => {
    const merged = mergeRecords(
      [record({ capturedAt: "2026-08-01" })],
      [record({ capturedAt: "2026-08-08" })]
    );
    expect(merged).toHaveLength(2);
  });
});

describe("serializeJsonl / parseJsonl", () => {
  it("同一入力で出力が一致し、rank だけが変わっても行順が変わらない", () => {
    const a = [
      record({ capturedAt: "2026-08-08", productKey: "rk:b/2", rank: 1 }),
      record({ capturedAt: "2026-08-01", productKey: "rk:a/1", rank: 2 }),
      record({ capturedAt: "2026-08-01", productKey: "rk:a/1", rank: 2, provider: "yahoo" }),
    ];
    const b = a.map(r => ({ ...r, rank: r.rank === 1 ? 5 : 9 }));
    const orderOf = (text: string) =>
      parseJsonl(text).map(r => `${r.capturedAt}/${r.productKey}/${r.provider}`);
    expect(orderOf(serializeJsonl(a))).toEqual(orderOf(serializeJsonl(b)));
    expect(serializeJsonl(a)).toBe(serializeJsonl([...a].reverse()));
  });

  it("壊れた行をスキップして残りを返す", () => {
    const text = `${JSON.stringify(record())}\n{壊れた\n\n${JSON.stringify(record({ capturedAt: "2026-08-08" }))}\n`;
    expect(parseJsonl(text)).toHaveLength(2);
  });
});

describe("summarizePriceHistory", () => {
  const series = [
    record({ capturedAt: "2026-06-01", price: 4980 }),
    record({ capturedAt: "2026-07-01", price: 2710 }),
    record({ capturedAt: "2026-08-01", price: 4840 }),
  ];

  it("min/max/latest/position を出す", () => {
    const stats = summarizePriceHistory(series, { windowDays: 90, asOf: "2026-08-19" });
    expect(stats).toMatchObject({
      productKey: "rk:i-order/501277",
      min: 2710,
      max: 4980,
      latest: 4840,
      latestAt: "2026-08-01",
      samples: 3,
      position: "high",
    });
  });

  it("samples が3未満なら null", () => {
    expect(summarizePriceHistory(series.slice(0, 2), { windowDays: 90, asOf: "2026-08-19" })).toBeNull();
  });

  it("min === max なら flat（ゼロ除算しない）", () => {
    const flat = series.map(r => ({ ...r, price: 1000 }));
    const stats = summarizePriceHistory(flat, { windowDays: 90, asOf: "2026-08-19" });
    expect(stats?.position).toBe("flat");
  });

  it("窓外を除外し、spanDays は実データの最古〜最新で計算する", () => {
    const withOld = [record({ capturedAt: "2026-01-01", price: 100 }), ...series];
    const stats = summarizePriceHistory(withOld, { windowDays: 90, asOf: "2026-08-19" });
    // 窓外の ¥100 が min にならないこと
    expect(stats?.min).toBe(2710);
    // 要求窓の 90 ではなく実データ範囲（06-01〜08-01 = 62日）
    expect(stats?.spanDays).toBe(62);
  });

  it("provider 指定で他プロバイダを除外する", () => {
    const mixed = [...series, record({ capturedAt: "2026-08-02", price: 100, provider: "yahoo" })];
    const stats = summarizePriceHistory(mixed, { windowDays: 90, asOf: "2026-08-19", provider: "rakuten" });
    expect(stats?.samples).toBe(3);
    expect(stats?.min).toBe(2710);
  });
});

describe("summarizeByProduct", () => {
  it("商品名が途中で変わっても itemCode が同じなら1系列に束ねる", () => {
    const records = [
      record({ capturedAt: "2026-06-01", price: 1000, name: "旧名称 4L" }),
      record({ capturedAt: "2026-07-01", price: 1200, name: "新名称 4000mL" }),
      record({ capturedAt: "2026-08-01", price: 1100, name: "新名称 4000mL 詰め替え" }),
    ];
    const map = summarizeByProduct(records, { windowDays: 90, asOf: "2026-08-19" });
    expect(map.size).toBe(1);
    expect(map.get("rk:i-order/501277")?.samples).toBe(3);
  });
});
