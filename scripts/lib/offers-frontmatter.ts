import yaml from "js-yaml";

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

export interface OfferCandidate {
  provider: "yahoo" | "amazon";
  label: string;
  asin?: string | null;
  name: string;
  price: number | null;
  url: string;
  imageUrl: string | null;
  available: boolean;
  sellerName?: string | null;
}

export interface ProviderOfferUpdateResult {
  content: string;
  changed: boolean;
  reason: string | null;
}

// Amazon offer の frontmatter 保存フィールドを制限する（価格・在庫・画像は書かない）
function sanitizeAmazonOffer(
  offer: Record<string, unknown>
): Record<string, unknown> {
  const { price: _p, available: _a, imageUrl: _i, ...rest } = offer;
  return rest;
}

export function upsertProviderOfferInFrontmatter(
  content: string,
  productName: string,
  candidate: OfferCandidate,
  updatedAt: string,
  options: { capacityVerified?: boolean; strictMatch?: boolean } = {}
): ProviderOfferUpdateResult {
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

  const { provider } = candidate;
  const isAmazon = provider === "amazon";
  const existingIndex = offers.findIndex((offer) => offer.provider === provider);

  if (existingIndex >= 0) {
    const existing = offers[existingIndex];
    const existingMatchStatus = existing.matchStatus as string | undefined;
    const existingUrl = existing.url as string;

    // review/rejected は自動復活させない
    if (existingMatchStatus === "review" || existingMatchStatus === "rejected") {
      return { content, changed: false, reason: `既存${provider} offerが${existingMatchStatus}のため上書きしない` };
    }

    // matched または matchStatus なし（legacy）: 同一URLのみ更新を許可
    if (!existingMatchStatus || existingMatchStatus === "matched") {
      if (existingUrl !== candidate.url) {
        return { content, changed: false, reason: `既存matched/legacy ${provider} offerを別URL候補で上書きしない` };
      }
      let updated: Record<string, unknown> = {
        ...existing,
        updatedAt,
      };
      if (!isAmazon) {
        updated = {
          ...updated,
          price: candidate.price ?? existing.price,
          imageUrl: candidate.imageUrl ?? existing.imageUrl,
          available: candidate.available,
        };
      } else {
        // Amazon: price/available/imageUrl を削除して保存フィールドを制限
        updated = sanitizeAmazonOffer(updated);
        updated.updatedAt = updatedAt;
      }
      offers[existingIndex] = updated;
    } else if (existingMatchStatus === "pending") {
      const urlChanged = existingUrl !== candidate.url;
      if (urlChanged) {
        if (!options.capacityVerified) {
          return { content, changed: false, reason: `pendingの別URL候補はレポートのみ、既存値を維持` };
        }
      }
      let newOffer: Record<string, unknown> = {
        ...existing,
        label: candidate.label,
        url: candidate.url,
        updatedAt,
      };
      if (!isAmazon) {
        newOffer.available = candidate.available;
        if (urlChanged) {
          if (candidate.price != null) newOffer.price = candidate.price;
          else delete newOffer.price;
          if (candidate.imageUrl != null) newOffer.imageUrl = candidate.imageUrl;
          else delete newOffer.imageUrl;
        } else {
          newOffer.price = candidate.price ?? existing.price;
          newOffer.imageUrl = candidate.imageUrl ?? existing.imageUrl;
          if (options.capacityVerified && options.strictMatch) {
            newOffer.matchStatus = "matched";
          }
        }
      } else {
        // Amazon: price/available/imageUrl を保存しない
        newOffer = sanitizeAmazonOffer(newOffer);
        if (!urlChanged && options.capacityVerified && options.strictMatch) {
          newOffer.matchStatus = "matched";
        }
        newOffer.updatedAt = updatedAt;
      }
      if (candidate.asin != null) newOffer.asin = candidate.asin;
      offers[existingIndex] = newOffer;
    } else {
      return { content, changed: false, reason: `不明なmatchStatus: ${existingMatchStatus}` };
    }
  } else {
    // 新規 offer: pending として追加
    const newEntry: Record<string, unknown> = {
      provider: candidate.provider,
      label: candidate.label,
      url: candidate.url,
      matchStatus: "pending",
      updatedAt,
    };
    if (candidate.asin != null) newEntry.asin = candidate.asin;
    // Amazon 以外のみ価格・在庫・画像を保存
    if (!isAmazon) {
      if (candidate.price != null) newEntry.price = candidate.price;
      if (candidate.imageUrl != null) newEntry.imageUrl = candidate.imageUrl;
      newEntry.available = candidate.available;
    }
    offers.push(newEntry);
  }

  product.offers = offers;
  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true, reason: null };
}

// 商品差し替え時に指定プロバイダの offer を available: false + matchStatus: "review" にする
export function markProviderOffersForReview(
  content: string,
  productName: string,
  provider: "yahoo" | "amazon",
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
    if (ms === "review" || ms === "rejected") continue;
    offer.available = false;
    offer.matchStatus = "review";
    offer.matchNotes = notes;
    changed = true;
  }

  if (!changed) return { content, changed: false };
  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true };
}
