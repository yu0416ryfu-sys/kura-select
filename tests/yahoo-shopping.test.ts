import { describe, expect, it } from "vitest";
import success from "./fixtures/yahoo/item-search-success.json";
import empty from "./fixtures/yahoo/item-search-empty.json";
import {
  buildValueCommerceAffiliateId,
  buildYahooItemSearchUrl,
  normalizeYahooItemSearchResponse,
  searchYahooShoppingItems,
} from "../scripts/lib/yahoo-shopping";

describe("yahoo-shopping", () => {
  it("builds a ValueCommerce affiliate_id with sid, pid, and vc_url", () => {
    const affiliateId = decodeURIComponent(buildValueCommerceAffiliateId("sid-1", "pid-2"));
    expect(affiliateId).toContain("sid=sid-1");
    expect(affiliateId).toContain("pid=pid-2");
    expect(affiliateId).toContain("&vc_url=");
  });

  it("builds an itemSearch URL for Yahoo Shopping v3", () => {
    const url = new URL(
      buildYahooItemSearchUrl("洗剤", {
        appId: "app-id",
        valueCommerceSid: "sid",
        valueCommercePid: "pid",
        results: 3,
      })
    );

    expect(url.origin + url.pathname).toBe("https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch");
    expect(url.searchParams.get("appid")).toBe("app-id");
    expect(url.searchParams.get("query")).toBe("洗剤");
    expect(url.searchParams.get("affiliate_type")).toBe("vc");
    expect(url.searchParams.get("affiliate_id")).toContain("ck.jp.ap.valuecommerce.com");
    expect(url.searchParams.get("results")).toBe("3");
  });

  it("normalizes successful itemSearch responses", () => {
    expect(normalizeYahooItemSearchResponse(success)).toEqual([
      {
        provider: "yahoo",
        label: "Yahoo!",
        name: "サンプル洗剤 詰め替え 1200mL",
        price: 1280,
        rating: 4.62,
        reviewCount: 81,
        url: "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1&pid=2&vc_url=https%3A%2F%2Fstore.shopping.yahoo.co.jp%2Fsample%2Fitem.html",
        imageUrl: "https://item-shopping.c.yimg.jp/i/n/sample_300",
        available: true,
        sellerName: "サンプルストア",
      },
    ]);
  });

  it("normalizes empty responses as an empty array", () => {
    expect(normalizeYahooItemSearchResponse(empty)).toEqual([]);
  });

  it("normalizes missing review fields as null rating values", () => {
    expect(
      normalizeYahooItemSearchResponse({
        hits: [
          {
            name: "レビューなし商品",
            url: "https://store.shopping.yahoo.co.jp/sample/no-review.html",
            price: 980,
          },
        ],
      })
    ).toMatchObject([{ rating: null, reviewCount: null }]);
  });

  it("throws a clear error when credentials are missing", async () => {
    await expect(
      searchYahooShoppingItems("洗剤", {
        appId: "",
        valueCommerceSid: "sid",
        valueCommercePid: "pid",
        fetchImpl: fetch,
      })
    ).rejects.toThrow("YAHOO_SHOPPING_APP_ID is required");
  });

  it("handles API errors without returning candidates", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ Error: { Message: "Invalid parameter" } }), {
        status: 400,
        statusText: "Bad Request",
      });

    await expect(
      searchYahooShoppingItems("洗剤", {
        appId: "app",
        valueCommerceSid: "sid",
        valueCommercePid: "pid",
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toThrow("Yahoo itemSearch failed: 400 Bad Request");
  });
});
