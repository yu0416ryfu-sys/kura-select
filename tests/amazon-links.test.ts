import { describe, it, expect } from "vitest";
import {
  extractAmazonAsin,
  buildAmazonAffiliateUrl,
  normalizeAmazonAffiliateUrl,
} from "../scripts/lib/amazon-links";

const TAG = "testtag-22";

describe("extractAmazonAsin", () => {
  it("/dp/ASIN 形式から ASIN を抽出する", () => {
    expect(extractAmazonAsin("https://www.amazon.co.jp/dp/B0EXAMPLE0")).toBe("B0EXAMPLE0");
  });

  it("/gp/product/ASIN 形式から ASIN を抽出する", () => {
    expect(extractAmazonAsin("https://www.amazon.co.jp/gp/product/B0EXAMPLE0")).toBe("B0EXAMPLE0");
  });

  it("クエリ文字列の ASIN= から抽出する", () => {
    expect(extractAmazonAsin("https://www.amazon.co.jp/?ASIN=B0EXAMPLE0")).toBe("B0EXAMPLE0");
  });

  it("単体 ASIN 文字列（10桁英数字）をそのまま返す", () => {
    expect(extractAmazonAsin("B0EXAMPLE0")).toBe("B0EXAMPLE0");
  });

  it("小文字の ASIN を大文字に正規化する", () => {
    expect(extractAmazonAsin("b0example0")).toBe("B0EXAMPLE0");
  });

  it("URL に ASIN が含まれない場合は null", () => {
    expect(extractAmazonAsin("https://www.amazon.co.jp/s?k=シャンプー")).toBeNull();
  });

  it("11文字以上は ASIN として認識しない", () => {
    expect(extractAmazonAsin("B0EXAMPLE00")).toBeNull();
  });
});

describe("buildAmazonAffiliateUrl", () => {
  it("ASIN と associate tag から affiliate URL を生成する", () => {
    expect(buildAmazonAffiliateUrl("B0EXAMPLE0", TAG)).toBe(
      `https://www.amazon.co.jp/dp/B0EXAMPLE0?tag=${TAG}`
    );
  });
});

describe("normalizeAmazonAffiliateUrl", () => {
  it("/dp/ASIN URL から tag 付き URL を生成する", () => {
    const result = normalizeAmazonAffiliateUrl(
      "https://www.amazon.co.jp/dp/B0EXAMPLE0",
      TAG
    );
    expect(result).toBe(`https://www.amazon.co.jp/dp/B0EXAMPLE0?tag=${TAG}`);
  });

  it("単体 ASIN から tag 付き URL を生成する", () => {
    const result = normalizeAmazonAffiliateUrl("B0EXAMPLE0", TAG);
    expect(result).toBe(`https://www.amazon.co.jp/dp/B0EXAMPLE0?tag=${TAG}`);
  });

  it("すでに tag= がある URL は補完しない", () => {
    const result = normalizeAmazonAffiliateUrl(
      "https://www.amazon.co.jp/dp/B0EXAMPLE0?tag=existingtag-22",
      TAG
    );
    expect(result).toContain("tag=existingtag-22");
    expect(result).not.toContain(TAG);
  });

  it("ASIN なし URL には tag= を追加する", () => {
    const result = normalizeAmazonAffiliateUrl(
      "https://www.amazon.co.jp/s?k=シャンプー",
      TAG
    );
    expect(result).toContain(`tag=${TAG}`);
  });
});
