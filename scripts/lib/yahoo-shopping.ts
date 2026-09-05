export interface YahooShoppingHit {
  name?: string;
  url?: string;
  price?: number;
  image?: { small?: string; medium?: string };
  exImage?: { url?: string };
  inStock?: boolean;
  seller?: { name?: string };
  review?: { rate?: number; count?: number };
}

export interface YahooOfferCandidate {
  provider: "yahoo";
  label: "Yahoo!";
  name: string;
  price: number | null;
  rating?: number | null;
  reviewCount?: number | null;
  url: string;
  imageUrl: string | null;
  available: boolean;
  sellerName: string | null;
}

export interface YahooSearchOptions {
  appId: string;
  valueCommerceSid: string;
  valueCommercePid: string;
  results?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const ITEM_SEARCH_URL = "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch";

export function buildValueCommerceAffiliateId(sid: string, pid: string): string {
  const referralUrl = `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=${encodeURIComponent(
    sid
  )}&pid=${encodeURIComponent(pid)}&vc_url=`;
  return encodeURIComponent(referralUrl);
}

export function buildYahooItemSearchUrl(query: string, options: YahooSearchOptions): string {
  const url = new URL(ITEM_SEARCH_URL);
  url.searchParams.set("appid", options.appId);
  url.searchParams.set("query", query);
  url.searchParams.set("affiliate_type", "vc");
  url.searchParams.set(
    "affiliate_id",
    buildValueCommerceAffiliateId(options.valueCommerceSid, options.valueCommercePid)
  );
  url.searchParams.set("results", String(options.results ?? 5));
  url.searchParams.set("image_size", "300");
  url.searchParams.set("in_stock", "true");
  return url.toString();
}

export function normalizeYahooItemSearchResponse(response: unknown): YahooOfferCandidate[] {
  const hits = Array.isArray((response as { hits?: unknown }).hits)
    ? ((response as { hits: YahooShoppingHit[] }).hits)
    : [];

  return hits
    .flatMap((hit): YahooOfferCandidate[] => {
      if (!hit.name || !hit.url) return [];
      return [{
        provider: "yahoo" as const,
        label: "Yahoo!" as const,
        name: hit.name,
        price: typeof hit.price === "number" ? hit.price : null,
        rating: typeof hit.review?.rate === "number" ? hit.review.rate : null,
        reviewCount: typeof hit.review?.count === "number" ? hit.review.count : null,
        url: hit.url,
        imageUrl: hit.exImage?.url ?? hit.image?.medium ?? hit.image?.small ?? null,
        available: hit.inStock !== false,
        sellerName: hit.seller?.name ?? null,
      }];
    });
}

export async function searchYahooShoppingItems(
  query: string,
  options: YahooSearchOptions
): Promise<YahooOfferCandidate[]> {
  if (!options.appId) throw new Error("YAHOO_SHOPPING_APP_ID is required");
  if (!options.valueCommerceSid || !options.valueCommercePid) {
    throw new Error("VALUECOMMERCE_SID and VALUECOMMERCE_PID are required");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(buildYahooItemSearchUrl(query, options), {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Yahoo itemSearch failed: ${response.status} ${response.statusText}`);
    }
    return normalizeYahooItemSearchResponse(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Yahoo itemSearch timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 既存 offer のリンク生存確認。判定できないものは unknown にして review 化しない
 * （誤判定で記事を壊さないため、迷ったら何もしない側に倒す）。
 */
export type OfferLinkStatus = "alive" | "dead" | "unknown";

/** UA 未指定だと Yahoo ストアが 403 を返しやすいので明示する。 */
const LINK_CHECK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36 KuraSelect-LinkCheck/1.0";

/**
 * 200 で返るが実質終了している soft-404 のマーカー。
 *
 * 2026-09-06 に実測した結果、Yahoo ストアは存在しない商品コードにも存在しないストアにも
 * 素直に 404 を返した（生存中の5件はすべて 200・マーカーなし）。したがって現時点では
 * マーカー判定を入れない＝空配列。空のときは本文を取得せず 200 を alive とする。
 *
 * ⚠ 増やすときは必ず実物の HTML を見てからにすること。推測で足すと生きている出品を dead にする。
 * ⚠ 未確認の残件: 「ページは残っているが販売終了」の状態が 200 を返すかは未観測。
 *   その状態は現状 alive と判定される（見逃す側に倒れる）。
 */
const SOLD_OUT_MARKERS: string[] = [];

/** 本文の先頭これだけを読んでマーカー判定する（全文は取得しない）。 */
const BODY_SCAN_CHARS = 200_000;

export interface CheckOfferLinkOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 商品ページ URL が生きているかを HTTP で判定する。
 *
 * ⚠ 呼び出し側は必ず resolveOfferTargetUrl() を通した実 URL を渡すこと。
 *   アフィリエイト計測リンクを渡すと架空クリックが計上される。
 */
export async function checkOfferLinkStatus(
  url: string,
  options: CheckOfferLinkOptions = {}
): Promise<OfferLinkStatus> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": LINK_CHECK_USER_AGENT,
        "Accept-Language": "ja,en;q=0.8",
      },
      signal: controller.signal,
    });

    if (response.status === 404 || response.status === 410) return "dead";
    // 403 / 429 / 5xx はショップ側の都合であり、商品が死んだとは限らない
    if (response.status < 200 || response.status >= 400) return "unknown";

    if (SOLD_OUT_MARKERS.length === 0) return "alive";
    const body = (await response.text()).slice(0, BODY_SCAN_CHARS);
    return SOLD_OUT_MARKERS.some((marker) => body.includes(marker)) ? "dead" : "alive";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timeout);
  }
}
