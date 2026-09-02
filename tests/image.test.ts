import { describe, expect, it } from "vitest";
import { productImageSrc, upscaleThumbnail } from "../src/lib/image";

const RAKUTEN =
  "https://thumbnail.image.rakuten.co.jp/@0_mall/cocodecow/cabinet/048/766492.jpg?_ex=128x128";
const YAHOO = "https://item-shopping.c.yimg.jp/i/j/ikurun0810_101436";

describe("upscaleThumbnail", () => {
  it("楽天サムネイルの _ex を指定サイズに差し替える", () => {
    expect(upscaleThumbnail(RAKUTEN, 256)).toBe(
      "https://thumbnail.image.rakuten.co.jp/@0_mall/cocodecow/cabinet/048/766492.jpg?_ex=256x256"
    );
  });

  it("_ex を持たない楽天 URL には付与する", () => {
    expect(
      upscaleThumbnail("https://thumbnail.image.rakuten.co.jp/@0_mall/a/b.jpg", 128)
    ).toBe("https://thumbnail.image.rakuten.co.jp/@0_mall/a/b.jpg?_ex=128x128");
  });

  it("他のクエリがある場合は & で連結する", () => {
    expect(
      upscaleThumbnail("https://thumbnail.image.rakuten.co.jp/@0_mall/a/b.jpg?v=1", 128)
    ).toBe("https://thumbnail.image.rakuten.co.jp/@0_mall/a/b.jpg?v=1&_ex=128x128");
  });

  it("楽天以外（Yahoo）はそのまま返す", () => {
    expect(upscaleThumbnail(YAHOO, 256)).toBe(YAHOO);
  });

  it("小数のピクセル指定は丸める", () => {
    expect(upscaleThumbnail(RAKUTEN, 127.6)).toContain("_ex=128x128");
  });

  it("不正なピクセル指定では URL を変えない", () => {
    expect(upscaleThumbnail(RAKUTEN, 0)).toBe(RAKUTEN);
    expect(upscaleThumbnail(RAKUTEN, Number.NaN)).toBe(RAKUTEN);
  });

  it("URL が無ければ undefined", () => {
    expect(upscaleThumbnail(undefined, 256)).toBeUndefined();
    expect(upscaleThumbnail(null, 256)).toBeUndefined();
    expect(upscaleThumbnail("", 256)).toBeUndefined();
  });
});

describe("productImageSrc", () => {
  it("URL が無ければプレースホルダーを返す", () => {
    expect(productImageSrc(undefined, 256)).toBe("/placeholder/product-default.svg");
  });

  it("URL があればサイズを差し替えた値を返す", () => {
    expect(productImageSrc(RAKUTEN, 400)).toContain("_ex=400x400");
  });
});
