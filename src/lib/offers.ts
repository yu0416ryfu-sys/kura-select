export type OfferProvider = "rakuten" | "yahoo" | "amazon";

export type MatchStatus = "matched" | "pending" | "review" | "rejected";

export interface ProductOffer {
  provider: OfferProvider;
  label?: string;
  asin?: string;
  price?: number;
  rating?: number;
  reviewCount?: number;
  url: string;
  imageUrl?: string;
  available?: boolean;
  updatedAt?: Date | string;
  matchStatus?: MatchStatus;
  matchConfidence?: "high" | "medium" | "low";
  matchedCapacity?: string;
  matchNotes?: string;
}

export interface OfferPriceSummary {
  lowestPrice: number | null;
  lowestProvider: OfferProvider | null;
  priceRows: { provider: OfferProvider; label: string; price: number }[];
  priceDifferenceLabel: string | null;
}

export interface YahooSearchFallbackOptions {
  enabled?: boolean;
  sid?: string;
  pid?: string;
}

export interface AmazonSearchFallbackOptions {
  enabled?: boolean;
  tag?: string;
}

export interface OfferVisibilityOptions {
  enabledProviders?: readonly OfferProvider[];
  allowAmazonPrice?: boolean;
  yahooSearchFallback?: YahooSearchFallbackOptions;
  amazonSearchFallback?: AmazonSearchFallbackOptions;
}

interface ProductWithOffers {
  name?: string;
  offers?: ProductOffer[];
  rakutenUrl?: string;
  price?: number;
  rating?: number;
  reviewCount?: number;
  imageUrl?: string;
}

export const PROVIDER_META = {
  rakuten: {
    name: "楽天市場",
    shortLabel: "楽天",
    defaultLabel: "楽天市場",
    purchaseLabel: "楽天市場で購入",
    gaEvent: "click_rakuten_link",
    badgeClass: "bg-amber-100 text-amber-700",
    primaryClass: "bg-[var(--color-warning)] text-white hover:opacity-90 shadow-sm hover:shadow-md",
    outlineClass: "border-2 border-[var(--color-warning)] text-[var(--color-warning)] hover:bg-amber-50",
  },
  yahoo: {
    name: "Yahoo!ショッピング",
    shortLabel: "Yahoo!",
    defaultLabel: "Yahoo!ショッピング",
    purchaseLabel: "Yahoo!で購入",
    gaEvent: "click_yahoo_link",
    badgeClass: "bg-sky-100 text-sky-700",
    primaryClass: "bg-[var(--color-primary)] text-white hover:opacity-90 shadow-sm hover:shadow-md",
    outlineClass: "border-2 border-[var(--color-primary)] text-[var(--color-primary)] hover:bg-sky-50",
  },
  amazon: {
    name: "Amazon",
    shortLabel: "Amazon",
    defaultLabel: "Amazon",
    purchaseLabel: "Amazonで購入",
    gaEvent: "click_amazon_link",
    badgeClass: "bg-neutral-100 text-neutral-800",
    primaryClass: "bg-neutral-900 text-white hover:bg-neutral-800 shadow-sm hover:shadow-md",
    outlineClass: "border-2 border-neutral-700 text-neutral-800 hover:bg-neutral-50",
  },
} satisfies Record<
  OfferProvider,
  {
    name: string;
    shortLabel: string;
    defaultLabel: string;
    purchaseLabel: string;
    gaEvent: string;
    badgeClass: string;
    primaryClass: string;
    outlineClass: string;
  }
>;

export function getProviderName(provider: OfferProvider): string {
  return PROVIDER_META[provider].name;
}

export function getProviderLabel(provider: OfferProvider): string {
  return PROVIDER_META[provider].defaultLabel;
}

export function getProviderShortLabel(provider: OfferProvider): string {
  return PROVIDER_META[provider].shortLabel;
}

export function getProviderPurchaseLabel(provider: OfferProvider): string {
  return PROVIDER_META[provider].purchaseLabel;
}

export function getProviderGaEvent(provider: OfferProvider): string {
  return PROVIDER_META[provider].gaEvent;
}

export function getProviderBadgeClass(provider: OfferProvider): string {
  return PROVIDER_META[provider].badgeClass;
}

export function getProviderButtonClass(
  provider: OfferProvider,
  variant: "primary" | "outline"
): string {
  return variant === "primary"
    ? PROVIDER_META[provider].primaryClass
    : PROVIDER_META[provider].outlineClass;
}

// Astro コンポーネント専用（import.meta.env を直接渡す）
// リンク表示用: rakuten + 有効な provider をすべて返す
export function getEnabledAffiliateProvidersFromEnv(env: ImportMetaEnv): OfferProvider[] {
  const providers: OfferProvider[] = ["rakuten"];
  if (env.PUBLIC_ENABLE_YAHOO_AFFILIATE === "true") providers.push("yahoo");
  if (env.PUBLIC_ENABLE_AMAZON_AFFILIATE === "true") providers.push("amazon");
  return providers;
}

// 価格比較・JSON-LD 専用: Amazon を含めない
export function getStaticAffiliateProvidersFromEnv(env: ImportMetaEnv): OfferProvider[] {
  const providers: OfferProvider[] = ["rakuten"];
  if (env.PUBLIC_ENABLE_YAHOO_AFFILIATE === "true") providers.push("yahoo");
  return providers;
}

const PROVIDER_ORDER: Record<OfferProvider, number> = {
  rakuten: 0,
  yahoo: 1,
  amazon: 2,
};

const AMAZON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Amazon offer の price/available/imageUrl 表示可否チェック（24h TTL）
// now を注入可能にすることでテストを時刻非依存にする
export function isAmazonOfferFresh(offer: ProductOffer, now?: number): boolean {
  if (offer.provider !== "amazon") return true;
  if (!offer.updatedAt) return false;
  const updated = new Date(offer.updatedAt).getTime();
  return (now ?? Date.now()) - updated < AMAZON_CACHE_TTL_MS;
}

function isValidUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// matchStatus なしは legacy matched として表示対象
function isVisibleByMatchStatus(offer: ProductOffer): boolean {
  if (!offer.matchStatus) return true;
  return offer.matchStatus === "matched";
}

function normalizeOffer(offer: ProductOffer): ProductOffer | null {
  if (offer.available === false || !isValidUrl(offer.url)) return null;
  if (!isVisibleByMatchStatus(offer)) return null;
  return {
    ...offer,
    label: offer.label ?? getProviderLabel(offer.provider),
  };
}

export function getRakutenFallbackOffer(product: ProductWithOffers): ProductOffer | null {
  if (!isValidUrl(product.rakutenUrl)) return null;
  return {
    provider: "rakuten",
    label: "楽天市場",
    price: product.price,
    rating: product.rating,
    reviewCount: product.reviewCount,
    url: product.rakutenUrl!,
    imageUrl: product.imageUrl,
    available: true,
  };
}

// JSON-LD aggregateRating 用の単一ソース（楽天）評価。
// Yahoo など複数サイトの評価を合算せず、商品レベルの楽天値だけを使う。
export function getRakutenRating(
  product: { rating?: number; reviewCount?: number }
): { rating: number; reviewCount: number } | null {
  if (typeof product.rating !== "number") return null;
  if (typeof product.reviewCount !== "number") return null;
  return { rating: product.rating, reviewCount: product.reviewCount };
}

export function buildYahooSearchUrl(keyword: string, sid: string, pid: string): string {
  const yahooSearch = `https://shopping.yahoo.co.jp/search?p=${encodeURIComponent(keyword)}`;
  return `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=${sid}&pid=${pid}&vc_url=${encodeURIComponent(yahooSearch)}`;
}

export function getYahooSearchFallbackOffer(
  product: { name: string },
  sid: string,
  pid: string
): ProductOffer {
  return {
    provider: "yahoo",
    label: "Yahoo!で探す",
    url: buildYahooSearchUrl(product.name, sid, pid),
    available: true,
  };
}

export function buildAmazonSearchUrl(keyword: string, tag: string): string {
  return `https://www.amazon.co.jp/s?k=${encodeURIComponent(keyword)}&tag=${encodeURIComponent(tag)}`;
}

export function getAmazonSearchFallbackOffer(
  product: { name: string },
  tag: string
): ProductOffer {
  return {
    provider: "amazon",
    label: "Amazonで探す",
    url: buildAmazonSearchUrl(product.name, tag),
    available: true,
  };
}

// 表示対象 offer（matchStatus/available/provider フィルタ済み）
export function getVisibleOffers(
  product: ProductWithOffers,
  options: OfferVisibilityOptions = {}
): ProductOffer[] {
  const enabledProviders = options.enabledProviders ?? ["rakuten"];
  const offers = (product.offers ?? [])
    .map(normalizeOffer)
    .filter((offer): offer is ProductOffer => Boolean(offer))
    .filter((offer) => (enabledProviders as OfferProvider[]).includes(offer.provider));

  const hasRakutenOffer = offers.some((offer) => offer.provider === "rakuten");
  const fallback = hasRakutenOffer ? null : getRakutenFallbackOffer(product);
  const visibleOffers = fallback ? [...offers, fallback] : offers;

  const hasAnyYahooOffer = (product.offers ?? []).some((offer) => offer.provider === "yahoo");
  const yahooFallback = options.yahooSearchFallback;
  const shouldAddYahooSearchFallback =
    (enabledProviders as OfferProvider[]).includes("yahoo") &&
    Boolean(yahooFallback?.enabled) &&
    Boolean(yahooFallback?.sid) &&
    Boolean(yahooFallback?.pid) &&
    Boolean(product.name) &&
    !hasAnyYahooOffer;

  const visibleWithYahooFallback = shouldAddYahooSearchFallback
    ? [
        ...visibleOffers,
        getYahooSearchFallbackOffer(
          { name: product.name! },
          yahooFallback!.sid!,
          yahooFallback!.pid!
        ),
      ]
    : visibleOffers;

  const hasAnyAmazonOffer = (product.offers ?? []).some((offer) => offer.provider === "amazon");
  const amazonFallback = options.amazonSearchFallback;
  const shouldAddAmazonSearchFallback =
    (enabledProviders as OfferProvider[]).includes("amazon") &&
    Boolean(amazonFallback?.enabled) &&
    Boolean(amazonFallback?.tag) &&
    Boolean(product.name) &&
    !hasAnyAmazonOffer;

  const visibleWithFallback = shouldAddAmazonSearchFallback
    ? [
        ...visibleWithYahooFallback,
        getAmazonSearchFallbackOffer(
          { name: product.name! },
          amazonFallback!.tag!
        ),
      ]
    : visibleWithYahooFallback;

  const seen = new Set<string>();
  return visibleWithFallback
    .filter((offer) => {
      const key = `${offer.provider}:${offer.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider]);
}

// 表示用の価格値。Amazon は SSG 鮮度制約で価格を表示しない（価格確認）ため、
// 並べ替え上は常に末尾扱い（Infinity）にする。価格未知も末尾。
function displayPriceValue(offer: ProductOffer): number {
  if (offer.provider === "amazon") return Infinity;
  return typeof offer.price === "number" && offer.price > 0 ? offer.price : Infinity;
}

// 購入ボタン等の表示順を「最安サイト先頭」に並べ替える。
// 価格未知・Amazon（価格確認）は末尾。同価格は既存 PROVIDER_ORDER で安定化する。
export function sortOffersByPriceForDisplay(offers: ProductOffer[]): ProductOffer[] {
  return [...offers].sort((a, b) => {
    const av = displayPriceValue(a);
    const bv = displayPriceValue(b);
    if (av !== bv) return av - bv;
    return PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider];
  });
}

// 表示対象 offer の中で最安のもの（primary 強調用）。価格を表示する offer が無ければ null。
export function getLowestVisibleOffer(offers: ProductOffer[]): ProductOffer | null {
  const priced = offers.filter((o) => Number.isFinite(displayPriceValue(o)));
  if (priced.length === 0) return null;
  return priced.reduce((a, b) => (displayPriceValue(a) <= displayPriceValue(b) ? a : b));
}

// 価格比較対象 offer（price > 0 を追加フィルタ、Amazon はデフォルト除外）
export function getComparableOffers(
  product: ProductWithOffers,
  options: OfferVisibilityOptions = {}
): (ProductOffer & { price: number })[] {
  return getVisibleOffers(product, options)
    .filter((offer) => options.allowAmazonPrice || offer.provider !== "amazon")
    .filter(
      (offer): offer is ProductOffer & { price: number } =>
        typeof offer.price === "number" && offer.price > 0
    );
}

export function getLowestOffer(
  product: ProductWithOffers,
  options: OfferVisibilityOptions = {}
): (ProductOffer & { price: number }) | null {
  const comparable = getComparableOffers(product, options);
  if (comparable.length === 0) return null;
  return comparable.reduce((a, b) => (a.price <= b.price ? a : b));
}

export function getPriceDifferenceLabel(
  comparable: (ProductOffer & { price: number })[]
): string | null {
  const sorted = [...comparable].sort((a, b) => a.price - b.price);
  if (sorted.length < 2) return null;
  const [lowest, second] = sorted;
  const diff = second.price - lowest.price;
  if (diff === 0) return "同価格";
  return `${getProviderShortLabel(lowest.provider)}が${diff.toLocaleString()}円安い`;
}

export function getOfferPriceSummary(
  product: ProductWithOffers,
  options: OfferVisibilityOptions = {}
): OfferPriceSummary {
  const comparable = getComparableOffers(product, options);

  if (comparable.length === 0) {
    return { lowestPrice: null, lowestProvider: null, priceRows: [], priceDifferenceLabel: null };
  }

  const lowest = comparable.reduce((a, b) => (a.price <= b.price ? a : b));
  const priceRows = comparable.map((o) => ({
    provider: o.provider,
    label: o.label ?? getProviderLabel(o.provider),
    price: o.price,
  }));
  const priceDifferenceLabel = getPriceDifferenceLabel(comparable);

  return { lowestPrice: lowest.price, lowestProvider: lowest.provider, priceRows, priceDifferenceLabel };
}

export function getPrimaryOffer(
  product: ProductWithOffers,
  options: OfferVisibilityOptions = {}
): ProductOffer | null {
  const visibleOffers = getVisibleOffers(product, options);
  return visibleOffers.find((offer) => offer.provider === "rakuten") ?? visibleOffers[0] ?? null;
}
