import { describe, expect, it } from "vitest";
import success from "./fixtures/yahoo/item-search-success.json";
import empty from "./fixtures/yahoo/item-search-empty.json";
import {
  buildValueCommerceAffiliateId,
  buildYahooItemSearchUrl,
  normalizeYahooItemSearchResponse,
  searchYahooShoppingItems,
  checkOfferLinkStatus,
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

  it("throws a timeout error when the request exceeds timeoutMs", async () => {
    // signal の abort を購読し AbortError で reject するスタブ（永久 pending はハングするため不可）
    const fetchImpl = ((_url: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as unknown as typeof fetch;

    await expect(
      searchYahooShoppingItems("洗剤", {
        appId: "app",
        valueCommerceSid: "sid",
        valueCommercePid: "pid",
        timeoutMs: 10,
        fetchImpl,
      })
    ).rejects.toThrow(/timed out after 10ms/);
  });

  it("releases the timer after a successful response", async () => {
    // timeout 後に timer が解放されることを確認（リーク時は vitest が open handle を警告）
    const fetchImpl = (async () =>
      new Response(JSON.stringify(success), { status: 200, statusText: "OK" })) as unknown as typeof fetch;

    await expect(
      searchYahooShoppingItems("洗剤", {
        appId: "app",
        valueCommerceSid: "sid",
        valueCommercePid: "pid",
        timeoutMs: 50,
        fetchImpl,
      })
    ).resolves.toBeInstanceOf(Array);
  });
});

/**
 * offer リンクの生存確認。
 *
 * ⚠ 実ネットワークには一切出ない（fetchImpl を注入する）。
 *   判定できないものは unknown にして review 化しない＝記事を壊さない側に倒す設計。
 */
describe("checkOfferLinkStatus", () => {
  const URL_UNDER_TEST = "https://store.shopping.yahoo.co.jp/sundrugec/4560461866660.html";

  function fakeFetch(status: number, body = "<html>商品ページ</html>") {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status, text: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it.each([404, 410])("%i は dead", async (status) => {
    const { impl } = fakeFetch(status);
    expect(await checkOfferLinkStatus(URL_UNDER_TEST, { fetchImpl: impl })).toBe("dead");
  });

  it("200 は alive", async () => {
    const { impl } = fakeFetch(200);
    expect(await checkOfferLinkStatus(URL_UNDER_TEST, { fetchImpl: impl })).toBe("alive");
  });

  it.each([403, 429, 500, 503])("%i は unknown（ショップ側の都合で dead とは限らない）", async (status) => {
    const { impl } = fakeFetch(status);
    expect(await checkOfferLinkStatus(URL_UNDER_TEST, { fetchImpl: impl })).toBe("unknown");
  });

  it("fetch が throw したら unknown", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await checkOfferLinkStatus(URL_UNDER_TEST, { fetchImpl: impl })).toBe("unknown");
  });

  it("タイムアウト（abort）は unknown", async () => {
    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(await checkOfferLinkStatus(URL_UNDER_TEST, { fetchImpl: impl, timeoutMs: 10 })).toBe(
      "unknown"
    );
  });

  it("User-Agent と redirect: follow を指定して叩く（403 対策）", async () => {
    const { impl, calls } = fakeFetch(200);
    await checkOfferLinkStatus(URL_UNDER_TEST, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_UNDER_TEST);
    expect(calls[0].init.redirect).toBe("follow");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/KuraSelect-LinkCheck/);
  });

  it("SOLD_OUT_MARKERS が空の間は本文を読まない（200 は無条件 alive）", async () => {
    let textCalled = false;
    const impl = (async () => ({
      status: 200,
      text: async () => {
        textCalled = true;
        return "";
      },
    })) as unknown as typeof fetch;
    expect(await checkOfferLinkStatus(URL_UNDER_TEST, { fetchImpl: impl })).toBe("alive");
    expect(textCalled).toBe(false);
  });
});
