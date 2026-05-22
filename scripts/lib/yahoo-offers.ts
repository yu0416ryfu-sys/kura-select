import type { YahooOfferCandidate } from "./yahoo-shopping.ts";
import {
  upsertProviderOfferInFrontmatter,
  markProviderOffersForReview as _markProviderOffersForReview,
  type ProviderOfferUpdateResult,
} from "./offers-frontmatter.ts";

export type { ProviderOfferUpdateResult as YahooOfferUpdateResult };

// yahoo-offers.ts の既存 import を壊さないための互換 re-export
export { markProviderOffersForReview } from "./offers-frontmatter.ts";

export function upsertYahooOfferInFrontmatter(
  content: string,
  productName: string,
  candidate: YahooOfferCandidate,
  updatedAt: string,
  options: { capacityVerified?: boolean; strictMatch?: boolean } = {}
): ProviderOfferUpdateResult {
  return upsertProviderOfferInFrontmatter(content, productName, candidate, updatedAt, options);
}
