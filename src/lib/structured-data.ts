/**
 * 記事ページの Product / Service JSON-LD の組み立て（純関数）。
 * ArticleLayout.astro から切り出し、Vitest で直接テストできるようにした。
 */
import {
  getLowestOffer,
  getRakutenFallbackOffer,
  getRakutenRating,
  type OfferProvider,
  type ProductWithOffers,
} from "./offers";
import { isVariantPricedProduct } from "./price";

/** JSON-LD の組み立てに必要なフィールドだけを持つ構造的な型（astro:content に依存させず Vitest から直接テストするため） */
export interface JsonLdProduct extends ProductWithOffers {
  name: string;
  brand: string;
  capacity: string;
  recommendedFor: string;
  imageUrl?: string;
  priceMax?: number;
  rating?: number;
  reviewCount?: number;
}

export interface JsonLdService {
  name: string;
  brand: string;
  waterType?: string;
}

export interface JsonLdContext {
  ogImageFallback: string;
  jsonLdProviders: readonly OfferProvider[];
}

/** Product JSON-LD。出力できない商品（rating 未定義・offer なし）は null */
export function buildProductJsonLd(
  p: JsonLdProduct,
  ctx: JsonLdContext
): Record<string, unknown> | null {
  if (p.rating === undefined) return null;

  // JSON-LD は楽天・Yahoo のみ（Amazon は 24h 鮮度を SSG で保証できないため除外）
  let jsonLdOffer: { price: number; url: string; provider: OfferProvider } | null = null;
  const lowest = getLowestOffer(p, { enabledProviders: ctx.jsonLdProviders });
  if (lowest) jsonLdOffer = { price: lowest.price, url: lowest.url, provider: lowest.provider };
  if (!jsonLdOffer) {
    const rakuten = getRakutenFallbackOffer(p);
    if (rakuten && typeof rakuten.price === "number" && rakuten.price > 0) {
      jsonLdOffer = { price: rakuten.price, url: rakuten.url, provider: rakuten.provider };
    }
  }
  if (!jsonLdOffer) return null;

  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description: `${p.brand}の${p.name}。${p.capacity}。${p.recommendedFor}`,
    brand: { "@type": "Brand", name: p.brand },
    image: p.imageUrl || ctx.ogImageFallback,
    // 当サイトは販売・配送・返品の主体ではないため、availability / shippingDetails /
    // hasMerchantReturnPolicy は出さない（2026-10-07 AdSense 是正 計画書2）。
    // GSC の「販売者のリスティング」と「商品スニペット」に「項目が不足しています」の
    // 警告（availability 等）が出るが、販売していないサイトでは出たままが正しい。
    // 警告であって資格には影響しない。警告を消すために再追加しないこと。
    //
    // 楽天の価格帯商品は単一 Offer だと「実際に買えない価格」を宣言することになるため
    // AggregateOffer（lowPrice〜highPrice）で出す。採用 offer が楽天のときだけ切り替える
    offers:
      jsonLdOffer.provider === "rakuten" && isVariantPricedProduct(p)
        ? {
            "@type": "AggregateOffer",
            priceCurrency: "JPY",
            lowPrice: p.price,
            highPrice: p.priceMax,
            offerCount: 1,
            url: jsonLdOffer.url,
          }
        : {
            "@type": "Offer",
            priceCurrency: "JPY",
            price: jsonLdOffer.price,
            url: jsonLdOffer.url,
          },
  };

  // 楽天評価を出せるときだけキーを付ける（undefined のキーを JSON.stringify で落とす挙動に頼らない）
  const r = getRakutenRating(p);
  if (r) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: r.rating,
      reviewCount: r.reviewCount,
      bestRating: 5,
      worstRating: 1,
    };
  }
  return ld;
}

/**
 * Service JSON-LD。provider / areaServed だけを出す。
 * 当サイトはサービスの提供者ではないため offers（月額の価格指定）は出さない。
 */
export function buildServiceJsonLd(s: JsonLdService): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    name: s.name,
    serviceType: s.waterType === "purifier" ? "浄水型ウォーターサーバー" : "宅配水ウォーターサーバー",
    provider: { "@type": "Organization", name: s.brand },
    areaServed: { "@type": "Country", name: "JP" },
  };
}
