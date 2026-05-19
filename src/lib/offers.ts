export type OfferProvider = "rakuten" | "yahoo";

export type MatchStatus = "matched" | "pending" | "review" | "rejected";

export interface ProductOffer {
  provider: OfferProvider;
  label?: string;
  price?: number;
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

interface ProductWithOffers {
  offers?: ProductOffer[];
  rakutenUrl?: string;
  price?: number;
  imageUrl?: string;
}

const PROVIDER_ORDER: Record<OfferProvider, number> = {
  rakuten: 0,
  yahoo: 1,
};

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
    label:
      offer.label ??
      (offer.provider === "rakuten" ? "楽天市場" : "Yahoo!ショッピング"),
  };
}

export function getRakutenFallbackOffer(product: ProductWithOffers): ProductOffer | null {
  if (!isValidUrl(product.rakutenUrl)) return null;
  return {
    provider: "rakuten",
    label: "楽天市場",
    price: product.price,
    url: product.rakutenUrl!,
    imageUrl: product.imageUrl,
    available: true,
  };
}

// 表示対象 offer（matchStatus/available フィルタ済み）
export function getVisibleOffers(
  product: ProductWithOffers,
  options: { enableYahoo: boolean }
): ProductOffer[] {
  const offers = (product.offers ?? [])
    .map(normalizeOffer)
    .filter((offer): offer is ProductOffer => Boolean(offer))
    .filter((offer) => options.enableYahoo || offer.provider !== "yahoo");

  const hasRakutenOffer = offers.some((offer) => offer.provider === "rakuten");
  const fallback = hasRakutenOffer ? null : getRakutenFallbackOffer(product);
  const visibleOffers = fallback ? [...offers, fallback] : offers;

  const seen = new Set<string>();
  return visibleOffers
    .filter((offer) => {
      const key = `${offer.provider}:${offer.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider]);
}

// 価格比較対象 offer（price > 0 を追加フィルタ）
export function getComparableOffers(
  product: ProductWithOffers,
  options: { enableYahoo: boolean }
): (ProductOffer & { price: number })[] {
  return getVisibleOffers(product, options).filter(
    (offer): offer is ProductOffer & { price: number } =>
      typeof offer.price === "number" && offer.price > 0
  );
}

export function getLowestOffer(
  product: ProductWithOffers,
  options: { enableYahoo: boolean }
): (ProductOffer & { price: number }) | null {
  const comparable = getComparableOffers(product, options);
  if (comparable.length === 0) return null;
  return comparable.reduce((a, b) => (a.price <= b.price ? a : b));
}

export function getPriceDifferenceLabel(
  comparable: (ProductOffer & { price: number })[]
): string | null {
  const rakuten = comparable.find((o) => o.provider === "rakuten");
  const yahoo = comparable.find((o) => o.provider === "yahoo");
  if (!rakuten || !yahoo) return null;
  const diff = rakuten.price - yahoo.price;
  if (diff === 0) return "同価格";
  if (diff > 0) return `Yahoo!が${diff.toLocaleString()}円安い`;
  return `楽天が${(-diff).toLocaleString()}円安い`;
}

export function getOfferPriceSummary(
  product: ProductWithOffers,
  options: { enableYahoo: boolean }
): OfferPriceSummary {
  const comparable = getComparableOffers(product, options);

  if (comparable.length === 0) {
    return { lowestPrice: null, lowestProvider: null, priceRows: [], priceDifferenceLabel: null };
  }

  const lowest = comparable.reduce((a, b) => (a.price <= b.price ? a : b));
  const priceRows = comparable.map((o) => ({
    provider: o.provider,
    label: o.label ?? (o.provider === "rakuten" ? "楽天市場" : "Yahoo!ショッピング"),
    price: o.price,
  }));
  const priceDifferenceLabel = getPriceDifferenceLabel(comparable);

  return { lowestPrice: lowest.price, lowestProvider: lowest.provider, priceRows, priceDifferenceLabel };
}

export function getPrimaryOffer(
  product: ProductWithOffers,
  options: { enableYahoo: boolean }
): ProductOffer | null {
  const visibleOffers = getVisibleOffers(product, options);
  return visibleOffers.find((offer) => offer.provider === "rakuten") ?? visibleOffers[0] ?? null;
}
