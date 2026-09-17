import { describe, it, expect } from "vitest";
import { buildAffiliateLinkAttrs } from "../src/lib/affiliate-link";

describe("buildAffiliateLinkAttrs", () => {
  const cases = [
    { provider: "rakuten", event: "click_rakuten_link", name: "楽天市場" },
    { provider: "yahoo", event: "click_yahoo_link", name: "Yahoo!ショッピング" },
    { provider: "amazon", event: "click_amazon_link", name: "Amazon" },
  ] as const;

  for (const c of cases) {
    it(`${c.provider}: rel・data-ga-event・aria-label が AffiliateLink.astro と同じ値`, () => {
      const attrs = buildAffiliateLinkAttrs({ href: "https://example.test/", provider: c.provider, productName: "商品A" });
      expect(attrs.rel).toBe("sponsored nofollow noopener");
      expect(attrs.target).toBe("_blank");
      expect(attrs.dataset.gaEvent).toBe(c.event);
      expect(attrs.dataset.gaProvider).toBe(c.provider);
      expect(attrs.dataset.gaProduct).toBe("商品A");
      expect(attrs.ariaLabel).toBe(`商品Aを${c.name}で見る（別タブで開く）`);
      expect(attrs.label).toBe(`${c.name}で見る`);
    });
  }

  it("商品名が無いときは表示ラベルから aria-label を作る", () => {
    const attrs = buildAffiliateLinkAttrs({ href: "https://example.test/", provider: "rakuten", label: "楽天で買う" });
    expect(attrs.ariaLabel).toBe("楽天で買う（別タブで開く）");
    expect(attrs.dataset.gaProduct).toBeUndefined();
  });

  it("gaPlacement 未指定なら undefined（既存の inline 扱いを保つ）", () => {
    const attrs = buildAffiliateLinkAttrs({ href: "https://example.test/", provider: "rakuten" });
    expect(attrs.dataset.gaPlacement).toBeUndefined();
  });

  it("size・variant のクラスを反映する", () => {
    const attrs = buildAffiliateLinkAttrs({ href: "https://example.test/", provider: "rakuten", size: "sm", variant: "outline" });
    expect(attrs.className).toContain("px-4 py-2 text-sm min-h-[36px]");
    expect(attrs.className).toContain("border-2 border-[var(--color-warning)]");
    expect(attrs.className.startsWith("inline-flex items-center")).toBe(true);
  });
});
