export type OfferProvider = "rakuten" | "yahoo";

export interface ProductOffer {
  provider: OfferProvider;
  label?: string;
  price?: number;
  url: string;
  imageUrl?: string;
  available?: boolean;
  updatedAt?: Date | string;
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

function normalizeOffer(offer: ProductOffer): ProductOffer | null {
  if (offer.available === false || !isValidUrl(offer.url)) return null;
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
    url: product.rakutenUrl,
    imageUrl: product.imageUrl,
    available: true,
  };
}

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

export function getPrimaryOffer(
  product: ProductWithOffers,
  options: { enableYahoo: boolean }
): ProductOffer | null {
  const visibleOffers = getVisibleOffers(product, options);
  return visibleOffers.find((offer) => offer.provider === "rakuten") ?? visibleOffers[0] ?? null;
}
