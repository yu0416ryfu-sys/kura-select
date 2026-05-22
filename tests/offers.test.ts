import { describe, expect, it } from "vitest";
import {
  getPrimaryOffer,
  getRakutenFallbackOffer,
  getVisibleOffers,
  getComparableOffers,
  getLowestOffer,
  getPriceDifferenceLabel,
  getOfferPriceSummary,
  getProviderLabel,
  getProviderShortLabel,
  getProviderName,
  isAmazonOfferFresh,
  buildYahooSearchUrl,
  PROVIDER_META,
} from "../src/lib/offers";

const rakutenUrl = "https://hb.afl.rakuten.co.jp/example";
const yahooUrl = "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1&pid=2";
const amazonUrl = "https://www.amazon.co.jp/dp/B0EXAMPLE?tag=testtag-22";

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
    expect(getVisibleOffers({ rakutenUrl }, { enabledProviders: ["rakuten"] })).toMatchObject([
      { provider: "rakuten", url: rakutenUrl },
    ]);
  });

  it("adds Rakuten fallback when offers omit Rakuten", () => {
    const offers = getVisibleOffers(
      {
        rakutenUrl,
        offers: [{ provider: "yahoo", url: yahooUrl }],
      },
      { enabledProviders: ["rakuten", "yahoo"] }
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
      { enabledProviders: ["rakuten"] }
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
      { enabledProviders: ["rakuten", "yahoo"] }
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
        { enabledProviders: ["rakuten", "yahoo"] }
      )?.provider
    ).toBe("rakuten");
  });

  it("returns null when no visible valid offer exists", () => {
    expect(
      getPrimaryOffer(
        {
          offers: [{ provider: "yahoo", url: yahooUrl }],
        },
        { enabledProviders: ["rakuten"] }
      )
    ).toBeNull();
  });
});

// ─── matchStatus フィルタ ─────────────────────────────────────────────────────
describe("matchStatus フィルタ", () => {
  it("matchStatus なしのYahoo offerは表示される（legacy matched互換）", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: true }] },
      { enabledProviders: ["rakuten", "yahoo"] }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(true);
  });

  it("matchStatus: 'matched' のYahoo offerは表示される", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: true, matchStatus: "matched" as const }] },
      { enabledProviders: ["rakuten", "yahoo"] }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(true);
  });

  it("matchStatus: 'pending' のYahoo offerは表示されない", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: true, matchStatus: "pending" as const }] },
      { enabledProviders: ["rakuten", "yahoo"] }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(false);
  });

  it("matchStatus: 'review' のYahoo offerは表示されない（available未設定でも）", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, matchStatus: "review" as const }] },
      { enabledProviders: ["rakuten", "yahoo"] }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(false);
  });

  it("matchStatus: 'rejected' のYahoo offerは表示されない", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: true, matchStatus: "rejected" as const }] },
      { enabledProviders: ["rakuten", "yahoo"] }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(false);
  });

  it("available: false のofferは表示されない", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "yahoo", url: yahooUrl, price: 5000, available: false }] },
      { enabledProviders: ["rakuten", "yahoo"] }
    );
    expect(offers.some(o => o.provider === "yahoo")).toBe(false);
  });
});

// ─── getComparableOffers ──────────────────────────────────────────────────────
describe("getComparableOffers", () => {
  it("price なし offerはリンク表示されるが価格比較には使われない", () => {
    const p = { rakutenUrl, price: 5000, offers: [{ provider: "yahoo" as const, url: yahooUrl, available: true }] };
    const visible = getVisibleOffers(p, { enabledProviders: ["rakuten", "yahoo"] });
    const comparable = getComparableOffers(p, { enabledProviders: ["rakuten", "yahoo"] });
    expect(visible.some(o => o.provider === "yahoo")).toBe(true);
    expect(comparable.some(o => o.provider === "yahoo")).toBe(false);
  });

  it("price <= 0 のofferは価格比較に使われない", () => {
    const p = { rakutenUrl, price: 5000, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 0, available: true }] };
    expect(getComparableOffers(p, { enabledProviders: ["rakuten", "yahoo"] }).some(o => o.provider === "yahoo")).toBe(false);
  });

  it("楽天 fallback offer は price > 0 なら比較対象になる", () => {
    const p = { rakutenUrl, price: 5000, offers: [] };
    expect(getComparableOffers(p, { enabledProviders: ["rakuten"] }).some(o => o.provider === "rakuten")).toBe(true);
  });
});

// ─── getLowestOffer ───────────────────────────────────────────────────────────
describe("getLowestOffer", () => {
  it("楽天が安い場合に楽天がlowest", () => {
    const p = { rakutenUrl, price: 5000, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 5300, available: true }] };
    const lowest = getLowestOffer(p, { enabledProviders: ["rakuten", "yahoo"] });
    expect(lowest?.provider).toBe("rakuten");
    expect(lowest?.price).toBe(5000);
  });

  it("Yahooが安い場合にYahooがlowest", () => {
    const p = { rakutenUrl, price: 5300, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 5000, available: true }] };
    const lowest = getLowestOffer(p, { enabledProviders: ["rakuten", "yahoo"] });
    expect(lowest?.provider).toBe("yahoo");
    expect(lowest?.price).toBe(5000);
  });

  it("JSON-LDでYahoo URL + 楽天価格の組み合わせが出ない（同一offerから取得）", () => {
    const p = { rakutenUrl, price: 5300, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 5000, available: true }] };
    const lowest = getLowestOffer(p, { enabledProviders: ["rakuten", "yahoo"] });
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
    const summary = getOfferPriceSummary(p, { enabledProviders: ["rakuten"] });
    expect(summary.priceDifferenceLabel).toBeNull();
    expect(summary.lowestProvider).toBe("rakuten");
    expect(summary.lowestPrice).toBe(5000);
  });

  it("comparable offerがない場合 lowestPrice は null", () => {
    const p = { price: undefined, rakutenUrl: undefined, offers: [] };
    const summary = getOfferPriceSummary(p, { enabledProviders: ["rakuten", "yahoo"] });
    expect(summary.lowestPrice).toBeNull();
    expect(summary.priceRows).toHaveLength(0);
  });

  it("楽天とYahooがある場合 priceRows が2件", () => {
    const p = { rakutenUrl, price: 5000, offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 5300, available: true }] };
    const summary = getOfferPriceSummary(p, { enabledProviders: ["rakuten", "yahoo"] });
    expect(summary.priceRows).toHaveLength(2);
    expect(summary.priceDifferenceLabel).toBe("楽天が300円安い");
  });
});

// ─── Amazon provider 対応 ──────────────────────────────────────────────────────
describe("Amazon provider - enabledProviders フィルタ", () => {
  const amazonOffer = { provider: "amazon" as const, url: amazonUrl, asin: "B0EXAMPLE", matchStatus: "matched" as const };

  it("enabledProviders に amazon を含まない場合 Amazon offer は表示されない", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [amazonOffer] },
      { enabledProviders: ["rakuten"] }
    );
    expect(offers.some(o => o.provider === "amazon")).toBe(false);
  });

  it("enabledProviders に amazon を含む場合 Amazon offer は表示される", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [amazonOffer] },
      { enabledProviders: ["rakuten", "yahoo", "amazon"] }
    );
    expect(offers.some(o => o.provider === "amazon")).toBe(true);
  });

  it("Amazon offer は getComparableOffers からデフォルトで除外される", () => {
    const p = {
      rakutenUrl,
      price: 5000,
      offers: [{ ...amazonOffer, price: 4000 }],
    };
    const comparable = getComparableOffers(p, { enabledProviders: ["rakuten", "yahoo", "amazon"] });
    expect(comparable.some(o => o.provider === "amazon")).toBe(false);
  });

  it("allowAmazonPrice: true の場合 Amazon offer は価格比較に入る", () => {
    const p = {
      rakutenUrl,
      price: 5000,
      offers: [{ ...amazonOffer, price: 4000, available: true }],
    };
    const comparable = getComparableOffers(p, {
      enabledProviders: ["rakuten", "yahoo", "amazon"],
      allowAmazonPrice: true,
    });
    expect(comparable.some(o => o.provider === "amazon")).toBe(true);
  });

  it("Amazon offer は getLowestOffer からデフォルトで除外される（価格比較なし）", () => {
    const p = {
      rakutenUrl,
      price: 5000,
      offers: [{ ...amazonOffer, price: 3000, available: true }],
    };
    const lowest = getLowestOffer(p, { enabledProviders: ["rakuten", "yahoo", "amazon"] });
    expect(lowest?.provider).toBe("rakuten");
    expect(lowest?.price).toBe(5000);
  });

  it("Amazon offer はリンク表示されるが priceSummary には入らない", () => {
    const p = {
      rakutenUrl,
      price: 5000,
      offers: [{ ...amazonOffer, price: 3000, available: true }],
    };
    const visible = getVisibleOffers(p, { enabledProviders: ["rakuten", "amazon"] });
    const summary = getOfferPriceSummary(p, { enabledProviders: ["rakuten", "amazon"] });
    expect(visible.some(o => o.provider === "amazon")).toBe(true);
    expect(summary.priceRows.some(r => r.provider === "amazon")).toBe(false);
  });

  it("Amazon offer の並び順は rakuten(0), yahoo(1), amazon(2)", () => {
    const offers = getVisibleOffers(
      {
        rakutenUrl,
        offers: [
          { ...amazonOffer },
          { provider: "yahoo" as const, url: yahooUrl, matchStatus: "matched" as const },
        ],
      },
      { enabledProviders: ["rakuten", "yahoo", "amazon"] }
    );
    const providers = offers.map(o => o.provider);
    expect(providers).toEqual(["rakuten", "yahoo", "amazon"]);
  });
});

// ─── normalizeOffer で Amazon label が補完される ─────────────────────────────
describe("normalizeOffer - label fallback", () => {
  it("Amazon offer の label が未指定でも 'Amazon' が補完される", () => {
    const offers = getVisibleOffers(
      { rakutenUrl, offers: [{ provider: "amazon" as const, url: amazonUrl, matchStatus: "matched" as const }] },
      { enabledProviders: ["rakuten", "amazon"] }
    );
    const amazon = offers.find(o => o.provider === "amazon");
    expect(amazon?.label).toBe("Amazon");
  });

  it("getOfferPriceSummary の priceRows label が Yahoo にならない", () => {
    const p = {
      rakutenUrl,
      price: 5000,
      offers: [{ provider: "yahoo" as const, url: yahooUrl, price: 5300, available: true, matchStatus: "matched" as const }],
    };
    const summary = getOfferPriceSummary(p, { enabledProviders: ["rakuten", "yahoo"] });
    const yahooRow = summary.priceRows.find(r => r.provider === "yahoo");
    expect(yahooRow?.label).toBe("Yahoo!ショッピング");
  });
});

// ─── provider meta helper ─────────────────────────────────────────────────────
describe("provider meta helpers", () => {
  it("getProviderLabel は3プロバイダすべてを返す", () => {
    expect(getProviderLabel("rakuten")).toBe("楽天市場");
    expect(getProviderLabel("yahoo")).toBe("Yahoo!ショッピング");
    expect(getProviderLabel("amazon")).toBe("Amazon");
  });

  it("getProviderShortLabel は3プロバイダすべてを返す", () => {
    expect(getProviderShortLabel("rakuten")).toBe("楽天");
    expect(getProviderShortLabel("yahoo")).toBe("Yahoo!");
    expect(getProviderShortLabel("amazon")).toBe("Amazon");
  });

  it("getProviderName は3プロバイダすべてを返す", () => {
    expect(getProviderName("rakuten")).toBe("楽天市場");
    expect(getProviderName("yahoo")).toBe("Yahoo!ショッピング");
    expect(getProviderName("amazon")).toBe("Amazon");
  });

  it("PROVIDER_META は3プロバイダのキーを持つ", () => {
    expect(Object.keys(PROVIDER_META)).toEqual(["rakuten", "yahoo", "amazon"]);
  });
});

// ─── isAmazonOfferFresh ───────────────────────────────────────────────────────
describe("isAmazonOfferFresh", () => {
  const now = new Date("2026-05-22T12:00:00.000Z").getTime();

  it("updatedAt が 24h 以内なら true", () => {
    const offer = {
      provider: "amazon" as const,
      url: amazonUrl,
      updatedAt: "2026-05-22T10:00:00.000Z",
    };
    expect(isAmazonOfferFresh(offer, now)).toBe(true);
  });

  it("updatedAt が 24h 超過なら false", () => {
    const offer = {
      provider: "amazon" as const,
      url: amazonUrl,
      updatedAt: "2026-05-21T11:59:59.000Z",
    };
    expect(isAmazonOfferFresh(offer, now)).toBe(false);
  });

  it("updatedAt が未定義なら false", () => {
    const offer = { provider: "amazon" as const, url: amazonUrl };
    expect(isAmazonOfferFresh(offer, now)).toBe(false);
  });

  it("非 Amazon offer は常に true", () => {
    const offer = { provider: "rakuten" as const, url: rakutenUrl };
    expect(isAmazonOfferFresh(offer, now)).toBe(true);
  });
});

// ─── Yahoo 検索フォールバック ─────────────────────────────────────────────────
describe("Yahoo 検索フォールバック", () => {
  const sid = "3770852";
  const pid = "892615315";
  const fallbackOptions = {
    enabledProviders: ["rakuten", "yahoo"] as const,
    yahooSearchFallback: { enabled: true, sid, pid },
  };

  it("buildYahooSearchUrl が正しい ValueCommerce + Yahoo 検索 URL を生成する", () => {
    const url = buildYahooSearchUrl("パンパース テープ", sid, pid);
    expect(url).toContain(`sid=${sid}`);
    expect(url).toContain(`pid=${pid}`);
    const vcUrl = decodeURIComponent(url.split("vc_url=")[1]);
    expect(vcUrl).toContain("shopping.yahoo.co.jp/search?p=");
    expect(vcUrl).toContain(encodeURIComponent("パンパース テープ"));
  });

  it("Yahoo offer がない商品には 'Yahoo!で探す' フォールバックが追加される", () => {
    const offers = getVisibleOffers(
      { name: "テスト商品", rakutenUrl },
      fallbackOptions
    );
    const yahoo = offers.find((o) => o.provider === "yahoo");
    expect(yahoo?.label).toBe("Yahoo!で探す");
    expect(yahoo?.url).toContain("valuecommerce.com");
  });

  it("matched Yahoo offer がある場合はフォールバックを追加しない", () => {
    const offers = getVisibleOffers(
      {
        name: "テスト商品",
        rakutenUrl,
        offers: [{ provider: "yahoo", url: yahooUrl, available: true, matchStatus: "matched" as const }],
      },
      fallbackOptions
    );
    expect(offers.filter((o) => o.provider === "yahoo")).toHaveLength(1);
    expect(offers.find((o) => o.provider === "yahoo")?.label).not.toBe("Yahoo!で探す");
  });

  it("pending Yahoo offer がある場合もフォールバックを追加しない", () => {
    const offers = getVisibleOffers(
      {
        name: "テスト商品",
        rakutenUrl,
        offers: [{ provider: "yahoo", url: yahooUrl, available: true, matchStatus: "pending" as const }],
      },
      fallbackOptions
    );
    expect(offers.some((o) => o.label === "Yahoo!で探す")).toBe(false);
  });

  it("review Yahoo offer がある場合もフォールバックを追加しない", () => {
    const offers = getVisibleOffers(
      {
        name: "テスト商品",
        rakutenUrl,
        offers: [{ provider: "yahoo", url: yahooUrl, matchStatus: "review" as const }],
      },
      fallbackOptions
    );
    expect(offers.some((o) => o.label === "Yahoo!で探す")).toBe(false);
  });

  it("rejected Yahoo offer がある場合もフォールバックを追加しない", () => {
    const offers = getVisibleOffers(
      {
        name: "テスト商品",
        rakutenUrl,
        offers: [{ provider: "yahoo", url: yahooUrl, available: true, matchStatus: "rejected" as const }],
      },
      fallbackOptions
    );
    expect(offers.some((o) => o.label === "Yahoo!で探す")).toBe(false);
  });

  it("enabled: false の場合はフォールバックを追加しない", () => {
    const offers = getVisibleOffers(
      { name: "テスト商品", rakutenUrl },
      { ...fallbackOptions, yahooSearchFallback: { enabled: false, sid, pid } }
    );
    expect(offers.some((o) => o.label === "Yahoo!で探す")).toBe(false);
  });

  it("SID が未設定の場合はフォールバックを追加しない", () => {
    const offers = getVisibleOffers(
      { name: "テスト商品", rakutenUrl },
      { ...fallbackOptions, yahooSearchFallback: { enabled: true, sid: "", pid } }
    );
    expect(offers.some((o) => o.label === "Yahoo!で探す")).toBe(false);
  });

  it("商品名がない場合はフォールバックを追加しない", () => {
    const offers = getVisibleOffers(
      { rakutenUrl },
      fallbackOptions
    );
    expect(offers.some((o) => o.label === "Yahoo!で探す")).toBe(false);
  });

  it("フォールバック offer は price を持たないため getComparableOffers に入らない", () => {
    const product = { name: "テスト商品", rakutenUrl, price: 5000 };
    const comparable = getComparableOffers(product, fallbackOptions);
    expect(comparable.some((o) => o.label === "Yahoo!で探す")).toBe(false);
  });

  it("フォールバック offer は getOfferPriceSummary の priceRows に入らない", () => {
    const product = { name: "テスト商品", rakutenUrl, price: 5000 };
    const summary = getOfferPriceSummary(product, fallbackOptions);
    expect(summary.priceRows.some((r) => r.label === "Yahoo!で探す")).toBe(false);
  });
});

// ─── enabledProviders 未指定は ["rakuten"] と同じ ─────────────────────────────
describe("enabledProviders デフォルト挙動", () => {
  it("enabledProviders 未指定は楽天のみ表示（後方互換）", () => {
    const offers = getVisibleOffers(
      {
        rakutenUrl,
        offers: [
          { provider: "yahoo" as const, url: yahooUrl, matchStatus: "matched" as const },
          { provider: "amazon" as const, url: amazonUrl, matchStatus: "matched" as const },
        ],
      }
    );
    expect(offers.map(o => o.provider)).toEqual(["rakuten"]);
  });
});
