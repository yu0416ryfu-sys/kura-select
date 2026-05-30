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
  const response = await fetchImpl(buildYahooItemSearchUrl(query, options));
  if (!response.ok) {
    throw new Error(`Yahoo itemSearch failed: ${response.status} ${response.statusText}`);
  }
  return normalizeYahooItemSearchResponse(await response.json());
}
