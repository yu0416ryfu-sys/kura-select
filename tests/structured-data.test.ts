import { describe, expect, it } from "vitest";
import {
  buildProductJsonLd,
  buildServiceJsonLd,
  type JsonLdContext,
  type JsonLdProduct,
} from "../src/lib/structured-data";

const RAKUTEN_URL = "https://hb.afl.rakuten.co.jp/hgc/xxx/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fshop%2Fitem%2F";
const YAHOO_URL = "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1&pid=2&vc_url=x";

const ctx: JsonLdContext = {
  ogImageFallback: "https://www.kura-select.com/og/default.png",
  jsonLdProviders: ["rakuten", "yahoo"],
};

function product(overrides: Partial<JsonLdProduct> = {}): JsonLdProduct {
  return {
    name: "テスト洗剤 本体",
    brand: "テストブランド",
    capacity: "500ml",
    recommendedFor: "毎日使いたい人",
    rakutenUrl: RAKUTEN_URL,
    price: 1000,
    rating: 4.5,
    reviewCount: 100,
    imageUrl: "https://thumbnail.image.rakuten.co.jp/test.jpg",
    ...overrides,
  };
}

function offersOf(ld: Record<string, unknown> | null): Record<string, unknown> {
  expect(ld).not.toBeNull();
  return ld!.offers as Record<string, unknown>;
}

describe("buildProductJsonLd: 出力しない条件", () => {
  it("rating 未定義は出さない", () => {
    expect(buildProductJsonLd(product({ rating: undefined }), ctx)).toBeNull();
  });

  it("offer が無ければ出さない", () => {
    expect(
      buildProductJsonLd(product({ rakutenUrl: undefined, price: undefined, offers: [] }), ctx)
    ).toBeNull();
  });

  it("楽天フォールバックは price > 0 のときだけ採用する", () => {
    expect(buildProductJsonLd(product({ price: 0 }), ctx)).toBeNull();
  });
});

describe("buildProductJsonLd: offer の選び方", () => {
  it("単一価格の商品は Offer", () => {
    const offers = offersOf(buildProductJsonLd(product(), ctx));
    expect(offers).toEqual({
      "@type": "Offer",
      priceCurrency: "JPY",
      price: 1000,
      url: RAKUTEN_URL,
    });
  });

  it("楽天の価格帯商品は AggregateOffer", () => {
    const offers = offersOf(buildProductJsonLd(product({ priceMax: 1500 }), ctx));
    expect(offers).toEqual({
      "@type": "AggregateOffer",
      priceCurrency: "JPY",
      lowPrice: 1000,
      highPrice: 1500,
      offerCount: 1,
      url: RAKUTEN_URL,
    });
  });

  it("AggregateOffer の価格は採用 offer ではなく商品の price / priceMax", () => {
    const p = product({
      price: 1000,
      priceMax: 1500,
      offers: [{ provider: "rakuten", price: 900, url: RAKUTEN_URL }],
    });
    const offers = offersOf(buildProductJsonLd(p, ctx));
    expect(offers["@type"]).toBe("AggregateOffer");
    expect(offers.lowPrice).toBe(1000);
    expect(offers.highPrice).toBe(1500);
  });

  it("楽天以外の最安 offer なら価格帯商品でも Offer", () => {
    const p = product({
      priceMax: 1500,
      offers: [
        { provider: "rakuten", price: 1000, url: RAKUTEN_URL },
        { provider: "yahoo", price: 800, url: YAHOO_URL, matchStatus: "matched" },
      ],
    });
    const offers = offersOf(buildProductJsonLd(p, ctx));
    expect(offers["@type"]).toBe("Offer");
    expect(offers.price).toBe(800);
    expect(offers.url).toBe(YAHOO_URL);
  });

  it("楽天 offer に価格が無ければ商品の price で楽天フォールバックする", () => {
    // 楽天 offer があると getVisibleOffers は自動フォールバックを足さないので、明示フォールバックの分岐に入る
    const p = product({
      price: 1200,
      offers: [{ provider: "rakuten", url: "https://item.rakuten.co.jp/shop/other/" }],
    });
    const offers = offersOf(buildProductJsonLd(p, ctx));
    expect(offers["@type"]).toBe("Offer");
    expect(offers.price).toBe(1200);
    expect(offers.url).toBe(RAKUTEN_URL);
  });

  it("jsonLdProviders に無い provider の offer は採用しない", () => {
    const p = product({
      offers: [
        { provider: "rakuten", price: 1000, url: RAKUTEN_URL },
        { provider: "yahoo", price: 800, url: YAHOO_URL, matchStatus: "matched" },
      ],
    });
    const offers = offersOf(buildProductJsonLd(p, { ...ctx, jsonLdProviders: ["rakuten"] }));
    expect(offers.price).toBe(1000);
    expect(offers.url).toBe(RAKUTEN_URL);
  });
});

describe("buildProductJsonLd: 売り手宣言を出さない", () => {
  const SELLER_KEYS = ["availability", "shippingDetails", "hasMerchantReturnPolicy"];

  it.each([
    ["Offer", product()],
    ["AggregateOffer", product({ priceMax: 1500 })],
  ])("%s に availability / shippingDetails / hasMerchantReturnPolicy のキーが無い", (_label, p) => {
    const offers = offersOf(buildProductJsonLd(p, ctx));
    for (const key of SELLER_KEYS) expect(Object.keys(offers)).not.toContain(key);
  });
});

describe("buildProductJsonLd: aggregateRating", () => {
  it("rating はあるが楽天評価を出せない（reviewCount 0）なら Product は出し、aggregateRating のキーだけ付けない", () => {
    const ld = buildProductJsonLd(product({ reviewCount: 0 }), ctx);
    expect(ld).not.toBeNull();
    expect(Object.keys(ld!)).not.toContain("aggregateRating");
  });

  it("rating が範囲外ならキーを付けない", () => {
    const ld = buildProductJsonLd(product({ rating: 0 }), ctx);
    expect(ld).not.toBeNull();
    expect(Object.keys(ld!)).not.toContain("aggregateRating");
  });

  it("楽天評価があれば値を出す", () => {
    const ld = buildProductJsonLd(product({ rating: 4.5, reviewCount: 100 }), ctx);
    expect(ld!.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.5,
      reviewCount: 100,
      bestRating: 5,
      worstRating: 1,
    });
  });
});

describe("buildProductJsonLd: 本体の組み立て", () => {
  it("description / brand / image を現行どおり組み立てる", () => {
    const ld = buildProductJsonLd(product(), ctx)!;
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Product");
    expect(ld.name).toBe("テスト洗剤 本体");
    expect(ld.description).toBe("テストブランドのテスト洗剤 本体。500ml。毎日使いたい人");
    expect(ld.brand).toEqual({ "@type": "Brand", name: "テストブランド" });
    expect(ld.image).toBe("https://thumbnail.image.rakuten.co.jp/test.jpg");
  });

  it("imageUrl が無ければ OGP 画像にフォールバックする", () => {
    const ld = buildProductJsonLd(product({ imageUrl: undefined }), ctx)!;
    expect(ld.image).toBe(ctx.ogImageFallback);
  });
});

describe("buildServiceJsonLd", () => {
  it("offers を持たず、provider / areaServed は従来どおり", () => {
    const ld = buildServiceJsonLd({ name: "テストサーバー", brand: "テスト社", waterType: "delivery" });
    expect(Object.keys(ld)).not.toContain("offers");
    expect(ld).toEqual({
      "@context": "https://schema.org",
      "@type": "Service",
      name: "テストサーバー",
      serviceType: "宅配水ウォーターサーバー",
      provider: { "@type": "Organization", name: "テスト社" },
      areaServed: { "@type": "Country", name: "JP" },
    });
  });

  it("浄水型は serviceType を切り替える", () => {
    const ld = buildServiceJsonLd({ name: "テスト浄水", brand: "テスト社", waterType: "purifier" });
    expect(ld.serviceType).toBe("浄水型ウォーターサーバー");
  });
});
