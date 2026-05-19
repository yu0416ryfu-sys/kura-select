import { describe, expect, it } from "vitest";
import {
  getPrimaryOffer,
  getRakutenFallbackOffer,
  getVisibleOffers,
  getComparableOffers,
  getLowestOffer,
  getPriceDifferenceLabel,
  getOfferPriceSummary,
} from "../src/lib/offers";

const rakutenUrl = "https://hb.afl.rakuten.co.jp/example";
const yahooUrl = "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1&pid=2";

describe("offers helper", () => {
  it("creates a Rakuten fallback offer from legacy fields", () => {
    expect(
      getRakutenFallbackOffer({
        rakutenUrl,
        price: 1200,
        imageUrl: "https://example.com/image.jpg",
      })
    ).toEqual({
      provider: "rakuten",
      label: "楽天市場",
      price: 1200,
      url: rakutenUrl,
      imageUrl: "https://example.com/image.jpg",
      available: true,
    });
  });

  it("uses Rakuten fallback when offers are missing", () => {
    expect(getVisibleOffers({ rakutenUrl }, { enableYahoo: false })).toMatchObject([
      { provider: "rakuten", url: rakutenUrl },
    ]);
  });

  it("adds Rakuten fallback when offers omit Rakuten", () => {
    const offers = getVisibleOffers(
      {
        rakutenUrl,
        offers: [{ provider: "yahoo", url: yahooUrl }],
      },
      { enableYahoo: true }
    );

    expect(offers.map((offer) => offer.provider)).toEqual(["rakuten", "yahoo"]);
  });

  it("hides Yahoo offers when the feature flag is off", () => {
    const offers = getVisibleOffers(
      {
        rakutenUrl,
        offers: [
          { provider: "rakuten", url: rakutenUrl },
          { provider: "yahoo", url: yahooUrl },
        ],
      },
      { enableYahoo: false }
    );

    expect(offers.map((offer) => offer.provider)).toEqual(["rakuten"]);
  });

  it("keeps Yahoo offers when the feature flag is on", () => {
    const offers = getVisibleOffers(
      {
        offers: [
          { provider: "yahoo", url: yahooUrl },
          { provider: "rakuten", url: rakutenUrl },
        ],
      },
      { enableYahoo: true }
    );

    expect(offers.map((offer) => offer.provider)).toEqual(["rakuten", "yahoo"]);
  });

  it("prefers Rakuten as the primary offer", () => {
    expect(
      getPrimaryOffer(
        {
          offers: [
            { provider: "yahoo", url: yahooUrl },
            { provider: "rakuten", url: rakutenUrl },
          ],
        },
        { enableYahoo: true }
      )?.provider
    ).toBe("rakuten");
  });

  it("returns null when no visible valid offer exists", () => {
    expect(
      getPrimaryOffer(
        {
          offers: [{ provider: "yahoo", url: yahooUrl }],
        },
        { enableYahoo: false }
      )
    ).toBeNull();
  });
});

// ─── matchStatus フィルタ ─────────────────────────────────────────────────────
describe("matchStatus フィルタ", () => {
  it("matchStatus なしのYahoo offerは表示される（legacy matched互換）", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: true }] },
      { enableYahoo: true }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(true);
  });

  it("matchStatus: 'matched' のYahoo offerは表示される", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: true, matchStatus: "matched" as const }] },
      { enableYahoo: true }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(true);
  });

  it("matchStatus: 'pending' のYahoo offerは表示されない", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: true, matchStatus: "pending" as const }] },
      { enableYahoo: true }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(false);
  });

  it("matchStatus: 'review' のYahoo offerは表示されない（available未設定でも）", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, matchStatus: "review" as const }] },
      { enableYahoo: true }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(false);
  });

  it("matchStatus: 'rejected' のYahoo offerは表示されない", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: true, matchStatus: "rejected" as const }] },
      { enableYahoo: true }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(false);
  });

  it("available: false のofferは表示されない", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: false }] },
      { enableYahoo: true }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(false);
  });
});

// ─── getComparableOffers ──────────────────────────────────────────────────────
describe("getComparableOffers", () => {
  it("price なし offerはリンク表示されるが価格比較には使われない", () => {
    const p = { rakutenUrl, price: 5000, offers: [{ provider: "yahoo" as const, url: yahooUrl, available: true }] };
    const visible = getVisibleOffers(p, { enableYahoo: true });
    const comparable = getComparableOffers(p, { enableYahoo: true });
    expect(visible.some(o => o.provider === "yahoo")).toBe(true);
    expect(comparable.some(o => o.provider === "yahoo")).toBe(false);
  });

  it("price <= 0 のofferは価格比較に使われない", () => {
    const p = { rakutenUrl, price: 5000, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 0, available: true }] };
    expect(getComparableOffers(p, { enableYahoo: true }).some(o => o.provider === "yahoo")).toBe(false);
  });

  it("楽天 fallback offer は price > 0 なら比較対象になる", () => {
    const p = { rakutenUrl, price: 5000, offers: [] };
    expect(getComparableOffers(p, { enableYahoo: false }).some(o => o.provider === "rakuten")).toBe(true);
  });
});

// ─── getLowestOffer ───────────────────────────────────────────────────────────
describe("getLowestOffer", () => {
  it("楽天が安い場合に楽天がlowest", () => {
    const p = { rakutenUrl, price: 5000, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 5300, available: true }] };
    const lowest = getLowestOffer(p, { enableYahoo: true });
    expect(lowest?.provider).toBe("rakuten");
    expect(lowest?.price).toBe(5000);
  });

  it("Yahooが安い場合にYahooがlowest", () => {
    const p = { rakutenUrl, price: 5300, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 5000, available: true }] };
    const lowest = getLowestOffer(p, { enableYahoo: true });
    expect(lowest?.provider).toBe("yahoo");
    expect(lowest?.price).toBe(5000);
  });

  it("JSON-LDでYahoo URL + 楽天価格の組み合わせが出ない（同一offerから取得）", () => {
    const p = { rakutenUrl, price: 5300, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 5000, available: true }] };
    const lowest = getLowestOffer(p, { enableYahoo: true });
    // URL と price が同一 offer から来ることを確認
    expect(lowest?.url).toBe(yahooUrl);
    expect(lowest?.price).toBe(5000);
  });
});

// ─── getPriceDifferenceLabel ──────────────────────────────────────────────────
describe("getPriceDifferenceLabel", () => {
  it("楽天が安い場合 '楽天がX円安い'", () => {
    const comparable = [
      { provider: "rakuten" as const, price: 5000, url: rakutenUrl, label: "楽天市場" },
      { provider: "yahoo" as const, price: 5300, url: yahooUrl, label: "Yahoo!" },
    ];
    expect(getPriceDifferenceLabel(comparable)).toBe("楽天が300円安い");
  });

  it("Yahooが安い場合 'Yahoo!がX円安い'", () => {
    const comparable = [
      { provider: "rakuten" as const, price: 5300, url: rakutenUrl, label: "楽天市場" },
      { provider: "yahoo" as const, price: 5000, url: yahooUrl, label: "Yahoo!" },
    ];
    expect(getPriceDifferenceLabel(comparable)).toBe("Yahoo!が300円安い");
  });

  it("同価格なら '同価格'", () => {
    const comparable = [
      { provider: "rakuten" as const, price: 5000, url: rakutenUrl, label: "楽天市場" },
      { provider: "yahoo" as const, price: 5000, url: yahooUrl, label: "Yahoo!" },
    ];
    expect(getPriceDifferenceLabel(comparable)).toBe("同価格");
  });

  it("Yahoo offerなし（楽天のみ）は null", () => {
    const comparable = [{ provider: "rakuten" as const, price: 5000, url: rakutenUrl, label: "楽天市場" }];
    expect(getPriceDifferenceLabel(comparable)).toBeNull();
  });
});

// ─── getOfferPriceSummary ─────────────────────────────────────────────────────
describe("getOfferPriceSummary", () => {
  it("楽天のみの場合 priceDifferenceLabel は null", () => {
    const p = { rakutenUrl, price: 5000, offers: [] };
    const summary = getOfferPriceSummary(p, { enableYahoo: false });
    expect(summary.priceDifferenceLabel).toBeNull();
    expect(summary.lowestProvider).toBe("rakuten");
    expect(summary.lowestPrice).toBe(5000);
  });

  it("comparable offerがない場合 lowestPrice は null", () => {
    const p = { price: undefined, rakutenUrl: undefined, offers: [] };
    const summary = getOfferPriceSummary(p, { enableYahoo: true });
    expect(summary.lowestPrice).toBeNull();
    expect(summary.priceRows).toHaveLength(0);
  });

  it("楽天とYahooがある場合 priceRows が2件", () => {
    const p = { rakutenUrl, price: 5000, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 5300, available: true }] };
    const summary = getOfferPriceSummary(p, { enableYahoo: true });
    expect(summary.priceRows).toHaveLength(2);
    expect(summary.priceDifferenceLabel).toBe("楽天が300円安い");
  });
});
