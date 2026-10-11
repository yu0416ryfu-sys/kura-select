import { describe, it, expect } from "vitest";
import { findPriceReportViolations } from "../src/lib/price-report-guard";

const wrap = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("findPriceReportViolations", () => {
  it("違反がない HTML は空配列", () => {
    const html = wrap('<a href="/category/toilet-paper/">トイレットペーパー</a>');
    expect(findPriceReportViolations(html)).toEqual([]);
  });

  it("本文に「楽天」という語があるだけなら違反にしない", () => {
    const html = wrap("<p>楽天市場の表示価格を集計しました。</p><a href=\"https://www.rakuten.co.jp/\">楽天</a>");
    expect(findPriceReportViolations(html)).toEqual([]);
  });

  it('rel="sponsored" は違反', () => {
    const html = wrap('<a href="/x/" rel="sponsored nofollow noopener">x</a>');
    expect(findPriceReportViolations(html).map((v) => v.kind)).toContain("affiliate-href");
  });

  it.each([
    "https://hb.afl.rakuten.co.jp/hgc/abc/?pc=x",
    "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1",
    "https://px.a8.net/svt/ejp?a8mat=1",
    "https://www.amazon.co.jp/dp/B000?tag=x-22",
    "https://amzn.to/abc",
    "https://af.moshimo.com/af/c/click?a_id=1",
  ])("アフィリエイトの href %s は違反", (href) => {
    const html = wrap(`<a href="${href}">x</a>`);
    expect(findPriceReportViolations(html)).toHaveLength(1);
  });

  it("JSON-LD の @type が Product なら違反", () => {
    const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "x" });
    const html = wrap(`<script type="application/ld+json">${ld}</script>`);
    expect(findPriceReportViolations(html)).toEqual([{ kind: "json-ld-type", detail: "Product" }]);
  });

  it("配列・@graph・入れ子の Offer も違反", () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Article", headline: "x" },
        { "@type": ["Thing", "Offer"] },
        { "@type": "ItemList", itemListElement: [{ item: { "@type": "Product" } }] },
      ],
    });
    const html = wrap(`<script type="application/ld+json">${ld}</script>`);
    expect(findPriceReportViolations(html).map((v) => v.detail).sort()).toEqual(["Offer", "Product"]);
  });

  it("Article と BreadcrumbList だけなら違反なし", () => {
    const ld = JSON.stringify([
      { "@context": "https://schema.org", "@type": "Article", headline: "x" },
      { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [] },
    ]);
    const html = wrap(`<script type="application/ld+json">${ld}</script>`);
    expect(findPriceReportViolations(html)).toEqual([]);
  });
});
