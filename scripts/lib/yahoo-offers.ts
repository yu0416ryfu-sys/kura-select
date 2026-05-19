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

  const existingIndex = offers.findIndex((offer) => offer.provider === "yahoo");

  if (existingIndex >= 0) {
    const existing = offers[existingIndex];
    const existingMatchStatus = existing.matchStatus as string | undefined;
    const existingUrl = existing.url as string;

    // review/rejected は自動復活させない
    if (existingMatchStatus === "review" || existingMatchStatus === "rejected") {
      return { content, changed: false, reason: `既存Yahoo offerが${existingMatchStatus}のため上書きしない` };
    }

    // matched または matchStatus なし（legacy）: 同一URLのみ価格・在庫・画像・更新日の更新を許可
    if (!existingMatchStatus || existingMatchStatus === "matched") {
      if (existingUrl !== candidate.url) {
        return { content, changed: false, reason: "既存matched/legacy Yahoo offerを別URL候補で上書きしない" };
      }
      offers[existingIndex] = {
        ...existing,
        price: candidate.price ?? existing.price,
        imageUrl: candidate.imageUrl ?? existing.imageUrl,
        available: candidate.available,
        updatedAt,
      };
    } else if (existingMatchStatus === "pending") {
      // pending: 同一URLなら更新可、別URLはスキップ
      if (existingUrl !== candidate.url) {
        return { content, changed: false, reason: "pendingの別URL候補はレポートのみ、既存値を維持" };
      }
      offers[existingIndex] = {
        ...existing,
        price: candidate.price ?? existing.price,
        imageUrl: candidate.imageUrl ?? existing.imageUrl,
        available: candidate.available,
        updatedAt,
      };
    } else {
      return { content, changed: false, reason: `不明なmatchStatus: ${existingMatchStatus}` };
    }
  } else {
    // 新規offer: 容量確認できるまで pending として追加
    offers.push({
      provider: "yahoo",
      label: candidate.label,
      price: candidate.price ?? undefined,
      url: candidate.url,
      imageUrl: candidate.imageUrl ?? undefined,
      available: candidate.available,
      matchStatus: "pending",
      updatedAt,
    });
  }

  product.offers = offers;
  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true, reason: null };
}

// 商品差し替え時に Yahoo offer を available: false + matchStatus: "review" にする
export function markProviderOffersForReview(
  content: string,
  productName: string,
  provider: "yahoo",
  notes: string
): { content: string; changed: boolean } {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) {
    return { content, changed: false };
  }

  const product = (parsed.data.products as Array<Record<string, unknown>>).find(
    (item) => item.name === productName
  );
  if (!product || !Array.isArray(product.offers)) {
    return { content, changed: false };
  }

  const offers = product.offers as Array<Record<string, unknown>>;
  let changed = false;

  for (const offer of offers) {
    if (offer.provider !== provider) continue;
    const ms = offer.matchStatus as string | undefined;
    // すでに review/rejected なら変更しない
    if (ms === "review" || ms === "rejected") continue;
    offer.available = false;
    offer.matchStatus = "review";
    offer.matchNotes = notes;
    changed = true;
  }

  if (!changed) return { content, changed: false };
  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true };
}
