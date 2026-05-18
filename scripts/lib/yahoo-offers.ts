import yaml from "js-yaml";
import type { YahooOfferCandidate } from "./yahoo-shopping.ts";

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
  if (!match) return null;
  const data = (yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>) ?? {};
  return { data, body: match[2] };
}

function dumpFrontmatter(data: Record<string, unknown>, body: string): string {
  const fm = yaml.dump(data, {
    indent: 2,
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: true,
    noRefs: true,
    noCompatMode: true,
    schema: yaml.JSON_SCHEMA,
    sortKeys: false,
  });
  return `---\n${fm.trimEnd()}\n---${body}`;
}

export interface YahooOfferUpdateResult {
  content: string;
  changed: boolean;
  reason: string | null;
}

export function upsertYahooOfferInFrontmatter(
  content: string,
  productName: string,
  candidate: YahooOfferCandidate,
  updatedAt: string
): YahooOfferUpdateResult {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) {
    return { content, changed: false, reason: "frontmatter products not found" };
  }

  const product = (parsed.data.products as Array<Record<string, unknown>>).find(
    (item) => item.name === productName
  );
  if (!product) return { content, changed: false, reason: "product not found" };

  const offers = Array.isArray(product.offers)
    ? (product.offers as Array<Record<string, unknown>>)
    : [];
  const nextOffer = {
    provider: "yahoo",
    label: candidate.label,
    price: candidate.price ?? undefined,
    url: candidate.url,
    imageUrl: candidate.imageUrl ?? undefined,
    available: candidate.available,
    updatedAt,
  };

  const index = offers.findIndex((offer) => offer.provider === "yahoo");
  if (index >= 0) offers[index] = { ...offers[index], ...nextOffer };
  else offers.push(nextOffer);

  product.offers = offers;
  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true, reason: null };
}
