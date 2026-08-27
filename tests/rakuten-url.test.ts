import { describe, expect, it } from "vitest";
import {
  buildItemCodeKeywords,
  collectOtherProductUrlKeys,
  findDuplicateUrlGroups,
  findDuplicateUrlProduct,
  isSameRakutenItem,
  parseRakutenItemUrl,
  selectNonDuplicateItem,
  toDirectItemUrl,
  toRakutenUrlKey,
} from "../scripts/lib/rakuten-url";

const AFFILIATE_URL =
  "https://hb.afl.rakuten.co.jp/hgc/g00qefin.3rdw6426.g00qefin.3rdw77ea/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fjewlinge%2Fts-s-l3%2F&m=http%3A%2F%2Fm.rakuten.co.jp%2Fjewlinge%2Fi%2F10004003%2F&rafcid=wsc_i_is_42b71141-7589-447e-ab9f-1c5e97e9d61f";
const DIRECT_URL = "https://item.rakuten.co.jp/jewlinge/ts-s-l3/";
const OTHER_URL = "https://item.rakuten.co.jp/jewlinge/super-onecoin/";

describe("parseRakutenItemUrl / toDirectItemUrl", () => {
  it("アフィリエイトURLから shopCode / itemCode を取り出す", () => {
    expect(parseRakutenItemUrl(AFFILIATE_URL)).toEqual({
      shopCode: "jewlinge",
      itemCode: "ts-s-l3",
    });
  });

  it("アフィリエイトURLと直リンクURLが同じ直リンク形式に正規化される", () => {
    expect(toDirectItemUrl(AFFILIATE_URL)).toBe(DIRECT_URL);
    expect(toDirectItemUrl(DIRECT_URL)).toBe(DIRECT_URL);
  });

  it("楽天以外のURLは null を返す", () => {
    expect(toDirectItemUrl("https://example.com/item/1")).toBeNull();
    expect(parseRakutenItemUrl(null)).toBeNull();
  });
});

describe("toRakutenUrlKey / isSameRakutenItem", () => {
  it("アフィリエイトURLと直リンクURLを同一商品と判定する", () => {
    expect(toRakutenUrlKey(AFFILIATE_URL)).toBe("jewlinge/ts-s-l3");
    expect(isSameRakutenItem(AFFILIATE_URL, DIRECT_URL)).toBe(true);
  });

  it("shopCode / itemCode の大文字小文字ゆれを同一商品と判定する", () => {
    expect(isSameRakutenItem(DIRECT_URL, "https://item.rakuten.co.jp/JEWLINGE/TS-S-L3/")).toBe(true);
  });

  it("別商品は同一と判定しない", () => {
    expect(isSameRakutenItem(DIRECT_URL, OTHER_URL)).toBe(false);
  });
});

describe("collectOtherProductUrlKeys / findDuplicateUrlProduct", () => {
  const products = [
    { rank: 1, name: "JEWLINGE オーガニックおりものライナー", rakutenUrl: AFFILIATE_URL },
    { rank: 2, name: "JEWLINGE 布ナプキン お試し一体型", rakutenUrl: OTHER_URL },
  ];

  it("自分自身のURLは除外する", () => {
    const keys = collectOtherProductUrlKeys(products, {
      name: "JEWLINGE オーガニックおりものライナー",
    });
    expect(keys.has("jewlinge/ts-s-l3")).toBe(false);
    expect(keys.has("jewlinge/super-onecoin")).toBe(true);
  });

  it("rank 指定でも自分自身を除外する", () => {
    const keys = collectOtherProductUrlKeys(products, { rank: 1 });
    expect([...keys]).toEqual(["jewlinge/super-onecoin"]);
  });

  it("他商品と同じ楽天商品を指すURLを検知する", () => {
    const duplicated = findDuplicateUrlProduct(products, DIRECT_URL, {
      name: "JEWLINGE オーガニックおりものライナー 1枚",
    });
    expect(duplicated?.rank).toBe(1);
  });

  it("重複しないURLでは null を返す", () => {
    expect(
      findDuplicateUrlProduct(products, "https://item.rakuten.co.jp/other/xyz/", { rank: 3 })
    ).toBeNull();
  });
});

describe("findDuplicateUrlGroups", () => {
  it("同一記事内で同じ楽天商品を指す商品をグループ化する（sanitary-napkin の重複再現）", () => {
    const groups = findDuplicateUrlGroups([
      { rank: 4, name: "JEWLINGE オーガニックおりものライナー", rakutenUrl: AFFILIATE_URL },
      { rank: 5, name: "JEWLINGE オーガニックおりものライナー 1枚", rakutenUrl: DIRECT_URL },
      { rank: 6, name: "JEWLINGE 布ナプキン お試し一体型", rakutenUrl: OTHER_URL },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("jewlinge/ts-s-l3");
    expect(groups[0].products.map(p => p.rank)).toEqual([4, 5]);
  });

  it("重複がなければ空配列を返す", () => {
    expect(
      findDuplicateUrlGroups([
        { rank: 1, name: "A", rakutenUrl: DIRECT_URL },
        { rank: 2, name: "B", rakutenUrl: OTHER_URL },
      ])
    ).toEqual([]);
  });
});

describe("selectNonDuplicateItem", () => {
  const items = [
    { itemName: "既存商品と同じ商品", itemUrl: DIRECT_URL, affiliateUrl: AFFILIATE_URL },
    { itemName: "別商品", itemUrl: OTHER_URL, affiliateUrl: OTHER_URL },
  ];

  it("既存商品と重複する先頭候補を飛ばして次の候補を返す", () => {
    const selection = selectNonDuplicateItem(items, new Set(["jewlinge/ts-s-l3"]));
    expect(selection.item?.itemName).toBe("別商品");
    expect(selection.skippedDuplicates).toHaveLength(1);
  });

  it("重複がなければ先頭候補をそのまま返す", () => {
    const selection = selectNonDuplicateItem(items, new Set());
    expect(selection.item?.itemName).toBe("既存商品と同じ商品");
    expect(selection.skippedDuplicates).toHaveLength(0);
  });

  it("全候補が既存商品と重複する場合は item が null になる", () => {
    const selection = selectNonDuplicateItem(
      items,
      new Set(["jewlinge/ts-s-l3", "jewlinge/super-onecoin"])
    );
    expect(selection.item).toBeNull();
    expect(selection.skippedDuplicates).toHaveLength(2);
  });

  it("楽天商品URLを持たない候補は重複判定の対象外として採用する", () => {
    const selection = selectNonDuplicateItem(
      [{ itemName: "URL不明", itemUrl: "", affiliateUrl: "" }],
      new Set(["jewlinge/ts-s-l3"])
    );
    expect(selection.item?.itemName).toBe("URL不明");
  });
});

describe("buildItemCodeKeywords", () => {
  it("JAN 相当の管理番号をそのままキーワードにする", () => {
    expect(buildItemCodeKeywords("4987176292759")).toEqual(["4987176292759"]);
  });

  it("枝番付きは全体と JAN 部分の2候補を返す", () => {
    expect(buildItemCodeKeywords("4987176292759-2")).toEqual([
      "4987176292759-2",
      "4987176292759",
    ]);
  });

  it("英数字混在の管理番号も候補にする", () => {
    expect(buildItemCodeKeywords("ts-s-l3-2set")).toEqual(["ts-s-l3-2set"]);
  });

  it("数字を含まない管理番号は検索ノイズになるので除外する", () => {
    expect(buildItemCodeKeywords("refill-set")).toEqual([]);
  });

  it("短すぎる管理番号は除外する", () => {
    expect(buildItemCodeKeywords("a12")).toEqual([]);
  });

  it("長すぎる管理番号・文字列以外は除外する", () => {
    expect(buildItemCodeKeywords("4987176292759".repeat(4))).toEqual([]);
    expect(buildItemCodeKeywords(undefined)).toEqual([]);
    expect(buildItemCodeKeywords(null)).toEqual([]);
  });

  it("前後の空白は取り除く", () => {
    expect(buildItemCodeKeywords("  4987176292759  ")).toEqual(["4987176292759"]);
  });
});
