import { describe, expect, it } from "vitest";
import { getPrimaryOffer, getRakutenFallbackOffer, getVisibleOffers } from "../src/lib/offers";

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
