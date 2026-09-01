import { describe, expect, it } from "vitest";
import {
  compareKnownPrice,
  comparePricePerUnit,
  formatPriceOrConfirmation,
  pricePerUnitSortValue,
  shouldShowPricePerUnit,
  isVariantPricedProduct,
  formatPriceRange,
  resolveDisplayPricePerUnit,
  resolveComparablePrice,
} from "../src/lib/price";
import { calcPricePerUnit } from "../src/lib/capacity";

describe("price helper", () => {
  it("有効価格を円表記にする", () => {
    expect(formatPriceOrConfirmation(1280)).toBe("¥1,280");
  });

  it("0/null は価格確認にする", () => {
    expect(formatPriceOrConfirmation(0)).toBe("価格確認");
    expect(formatPriceOrConfirmation(null)).toBe("価格確認");
  });

  it("価格不明は昇順・降順とも後ろに回す", () => {
    expect(compareKnownPrice(0, 1280, "asc")).toBeGreaterThan(0);
    expect(compareKnownPrice(0, 1280, "desc")).toBeGreaterThan(0);
    expect(compareKnownPrice(1280, 0, "desc")).toBeLessThan(0);
  });

  it("price 0 の pricePerUnit は表示しない", () => {
    expect(shouldShowPricePerUnit(0, "0円/枚")).toBe(false);
  });

  it("有効価格の pricePerUnit は表示対象にする", () => {
    expect(shouldShowPricePerUnit(1280, "約10円/枚")).toBe(true);
  });

  it("pricePerUnit のソート値を返す", () => {
    expect(pricePerUnitSortValue(0, "0円/枚")).toBe(Infinity);
    expect(pricePerUnitSortValue(1280, "約10円/枚")).toBe(10);
  });

  it("コスパ順でも不明値を昇順・降順とも後ろに回す", () => {
    const unknown = { price: 0, pricePerUnit: "0円/枚" };
    const known = { price: 1280, pricePerUnit: "約10円/枚" };

    expect(comparePricePerUnit(unknown, known, "asc")).toBeGreaterThan(0);
    expect(comparePricePerUnit(unknown, known, "desc")).toBeGreaterThan(0);
  });

  it("Yahoo等が最安でも算出済み単価でコスパ順を有効値にする（サイト非依存）", () => {
    // 最安サイトの価格×capacity から算出した単価を渡す前提
    const yahooLowest = { price: 980, pricePerUnit: "約5円/枚" };
    const rakutenLowest = { price: 1280, pricePerUnit: "約10円/枚" };

    // 単価の安い yahooLowest が昇順で前に来る
    expect(comparePricePerUnit(yahooLowest, rakutenLowest, "asc")).toBeLessThan(0);
    expect(comparePricePerUnit(yahooLowest, rakutenLowest, "desc")).toBeGreaterThan(0);
  });
});

describe("価格帯（選択式）商品", () => {
  const variant = { price: 1080, priceMax: 21980, capacity: "500mL" };
  const normal = { price: 1080, capacity: "500mL" };

  it("priceMax > price のときだけ価格帯商品と判定する", () => {
    expect(isVariantPricedProduct(variant)).toBe(true);
    expect(isVariantPricedProduct(normal)).toBe(false);
    expect(isVariantPricedProduct({ price: 1080, priceMax: 1080 })).toBe(false);
    expect(isVariantPricedProduct({ price: 1080, priceMax: 0 })).toBe(false);
    expect(isVariantPricedProduct({ price: 1080, priceMax: null })).toBe(false);
    expect(isVariantPricedProduct({ price: null, priceMax: 21980 })).toBe(false);
  });

  it("帯ラベルを桁区切りで組み立てる", () => {
    expect(formatPriceRange(variant)).toBe("¥1,080〜¥21,980");
    expect(formatPriceRange(normal)).toBeNull();
  });

  it("楽天の価格帯商品は単価を出さない", () => {
    expect(resolveDisplayPricePerUnit(variant, 1080, undefined, "rakuten")).toBeNull();
  });

  it("Yahoo / Amazon は固定価格なので単価を出し続ける", () => {
    expect(resolveDisplayPricePerUnit(variant, 1080, undefined, "yahoo"))
      .toBe(calcPricePerUnit(1080, "500mL"));
    expect(resolveDisplayPricePerUnit(variant, 1080, undefined, "amazon"))
      .toBe(calcPricePerUnit(1080, "500mL"));
  });

  it("通常商品は calcPricePerUnit と一致する", () => {
    expect(resolveDisplayPricePerUnit(normal, 1080)).toBe(calcPricePerUnit(1080, "500mL"));
    expect(resolveDisplayPricePerUnit(normal, null)).toBeNull();
  });

  it("安い順の比較値は楽天由来のときだけ priceMax に差し替える", () => {
    expect(resolveComparablePrice(variant, 1080, "rakuten")).toBe(21980);
    expect(resolveComparablePrice(variant, 980, "yahoo")).toBe(980);
    expect(resolveComparablePrice(normal, 1080, "rakuten")).toBe(1080);
  });
});
