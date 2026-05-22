import {
  extractCapacityTotal,
  normalizeCapacityTotal,
  calcPricePerUnit,
} from "./frontmatter.ts";
import yaml from "js-yaml";
import { basename } from "path";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export interface RagProductRecord {
  type: "product";
  articleFile: string;
  articleTitle: string;
  category: string;
  rank: number;
  name: string;
  brand: string;
  capacity: string;
  capacityTotal: { total: number; unit: string } | null;
  price: number;
  pricePerUnit: string | null;
  rakutenUrl: string;
  rakutenCode: string | null;
  offerSummary: Record<string, { count: number; statuses: string[] }>;
  needsReview: boolean;
  reviewReasons: string[];
}

export interface RagCapacityPatternRecord {
  type: "capacity-pattern";
  source: "article" | "report";
  articleFile: string;
  name: string;
  capacity: string;
  extractedTotal: { total: number; unit: string } | null;
  pricePerUnit: string | null;
  needsReview: boolean;
  reason: string | null;
}

export interface RagMatchDecisionRecord {
  type: "match-decision";
  sourceFile: string;
  articleFile: string;
  rank: number | null;
  currentName: string;
  action: string;
  confidence: string | null;
  selectedItemUrl: string | null;
  reason: string | null;
  status: string;
}

export interface RagCategoryRuleRecord {
  type: "category-rule";
  category: string;
  units: string[];
  commonBrands: string[];
  reviewSignals: string[];
  productCount: number;
}

// ─── フロントマター解析 ───────────────────────────────────────────────────────

interface ArticleFrontmatter {
  title?: string;
  category?: string;
  products?: RawProduct[];
}

interface RawProduct {
  rank?: number;
  name?: string;
  brand?: string;
  price?: number;
  capacity?: string;
  pricePerUnit?: string;
  rakutenUrl?: string;
  offers?: RawOffer[];
}

interface RawOffer {
  provider?: string;
  matchStatus?: string;
  url?: string;
}

export function parseFrontmatterData(content: string): ArticleFrontmatter | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
  if (!match) return null;
  try {
    return (yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) as ArticleFrontmatter) ?? null;
  } catch {
    return null;
  }
}

// ─── rakutenCode 抽出（shop:item 形式）──────────────────────────────────────

function extractRakutenCode(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pcParam = parsed.searchParams.get("pc");
    if (!pcParam) return null;
    const inner = new URL(pcParam);
    // pathname = /shopCode/itemCode/
    const parts = inner.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0]}:${parts[1]}`;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── needsReview 判定 ─────────────────────────────────────────────────────────

const NEEDS_REVIEW_PATTERNS = ["-", "要更新", "0円/枚", "0円/m", "0円/mL", "0円/g"];

function isNeedsReview(pricePerUnit: string | null | undefined): boolean {
  if (!pricePerUnit) return false;
  return NEEDS_REVIEW_PATTERNS.some((p) => pricePerUnit === p || pricePerUnit.includes(p));
}

function buildReviewReasons(product: RawProduct, recalcPpu: string | null): string[] {
  const reasons: string[] = [];
  const cap = product.capacity ?? "";
  if (!cap || cap === "-") {
    reasons.push("capacity未設定");
  } else if (!extractCapacityTotal(cap)) {
    reasons.push("capacity抽出不可");
  }
  if (isNeedsReview(product.pricePerUnit)) {
    reasons.push("pricePerUnit要確認");
  }
  if (recalcPpu === null && cap && cap !== "-" && extractCapacityTotal(cap) && typeof product.price === "number" && product.price > 0) {
    reasons.push("pricePerUnit計算失敗");
  }
  return reasons;
}

// ─── offerSummary 構築 ───────────────────────────────────────────────────────

function buildOfferSummary(
  offers: RawOffer[] | undefined
): Record<string, { count: number; statuses: string[] }> {
  if (!offers || offers.length === 0) return {};
  const summary: Record<string, { count: number; statuses: string[] }> = {};
  for (const offer of offers) {
    const provider = typeof offer.provider === "string" ? offer.provider : "unknown";
    const status = typeof offer.matchStatus === "string" ? offer.matchStatus : "unknown";
    if (!summary[provider]) summary[provider] = { count: 0, statuses: [] };
    summary[provider].count++;
    if (!summary[provider].statuses.includes(status)) {
      summary[provider].statuses.push(status);
    }
  }
  return summary;
}

// ─── normalizeProductRecord ──────────────────────────────────────────────────

export function normalizeProductRecord(
  input: unknown,
  articleFile: string,
  articleTitle: string,
  category: string
): RagProductRecord | null {
  if (!input || typeof input !== "object") return null;
  const p = input as RawProduct;

  const rank = typeof p.rank === "number" ? p.rank : null;
  const name = typeof p.name === "string" && p.name ? p.name : null;
  const brand = typeof p.brand === "string" ? p.brand : "";
  const price = typeof p.price === "number" ? p.price : null;
  const capacity = typeof p.capacity === "string" ? p.capacity : null;
  const rakutenUrl = typeof p.rakutenUrl === "string" ? p.rakutenUrl : null;

  if (rank === null || !name || price === null || !rakutenUrl) return null;

  const extracted = capacity ? extractCapacityTotal(capacity) : null;
  const capacityTotal = extracted ? (normalizeCapacityTotal(extracted) ?? extracted) : null;
  const recalcPpu = capacity && price > 0 ? calcPricePerUnit(price, capacity) : null;
  const pricePerUnit = typeof p.pricePerUnit === "string" ? p.pricePerUnit : recalcPpu;

  const reviewReasons = buildReviewReasons(p, recalcPpu);
  const offerSummary = buildOfferSummary(Array.isArray(p.offers) ? p.offers : undefined);

  return {
    type: "product",
    articleFile,
    articleTitle,
    category,
    rank,
    name,
    brand,
    capacity: capacity ?? "-",
    capacityTotal,
    price,
    pricePerUnit: pricePerUnit ?? null,
    rakutenUrl,
    rakutenCode: extractRakutenCode(rakutenUrl),
    offerSummary,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  };
}

// ─── normalizeMatchDecision ──────────────────────────────────────────────────

function statusFromPath(sourceFile: string): string {
  const normalized = sourceFile.replace(/\\/g, "/");
  if (normalized.includes("review/done/")) return "review_done";
  if (normalized.includes("/review/")) return "review";
  if (normalized.includes("/processed/")) return "processed";
  if (normalized.includes("/failed/")) return "failed";
  return "unknown";
}

export function normalizeMatchDecision(
  input: unknown,
  sourceFile: string
): RagMatchDecisionRecord | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;

  const articleFile = typeof r.articleFile === "string" ? r.articleFile : null;
  // フィールド名は current.name / currentName / name の3パターンに対応
  const currentObj = r.current && typeof r.current === "object" ? r.current as Record<string, unknown> : null;
  const currentName =
    typeof r.currentName === "string" ? r.currentName
    : currentObj && typeof currentObj.name === "string" ? currentObj.name
    : typeof r.name === "string" ? r.name
    : null;
  const action = typeof r.action === "string" ? r.action : null;

  if (!articleFile || !currentName || !action) return null;

  return {
    type: "match-decision",
    sourceFile,
    articleFile,
    rank: typeof r.rank === "number" ? r.rank : null,
    currentName,
    action,
    confidence: typeof r.confidence === "string" ? r.confidence : null,
    selectedItemUrl: typeof r.selectedItemUrl === "string" ? r.selectedItemUrl
      : typeof r.url === "string" ? r.url
      : null,
    reason: typeof r.reason === "string" ? r.reason : null,
    status: typeof r.status === "string" ? r.status : statusFromPath(sourceFile),
  };
}

// ─── buildCategoryRuleRecords ────────────────────────────────────────────────

const REVIEW_SIGNALS = [
  "選べる", "サイズ選択", "ふるさと納税", "バリエーション",
  "アソート", "詰め合わせ", "詰合せ", "お試し", "各種",
];

export function buildCategoryRuleRecords(
  products: RagProductRecord[]
): RagCategoryRuleRecord[] {
  const byCategory = new Map<string, RagProductRecord[]>();
  for (const p of products) {
    const group = byCategory.get(p.category) ?? [];
    group.push(p);
    byCategory.set(p.category, group);
  }

  const rules: RagCategoryRuleRecord[] = [];
  for (const [category, items] of byCategory.entries()) {
    const unitCounts = new Map<string, number>();
    const brandCounts = new Map<string, number>();
    const signalSet = new Set<string>();

    for (const item of items) {
      if (item.capacityTotal) {
        const u = item.capacityTotal.unit;
        unitCounts.set(u, (unitCounts.get(u) ?? 0) + 1);
      }
      if (item.brand) {
        brandCounts.set(item.brand, (brandCounts.get(item.brand) ?? 0) + 1);
      }
      for (const signal of REVIEW_SIGNALS) {
        if (item.name.includes(signal) || item.capacity.includes(signal)) {
          signalSet.add(signal);
        }
      }
    }

    const units = [...unitCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([u]) => u);

    const commonBrands = [...brandCounts.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([b]) => b);

    rules.push({
      type: "category-rule",
      category,
      units,
      commonBrands,
      reviewSignals: [...signalSet],
      productCount: items.length,
    });
  }

  return rules.sort((a, b) => a.category.localeCompare(b.category));
}

// ─── normalizeCapacityPattern ────────────────────────────────────────────────

export function normalizeCapacityPattern(
  input: unknown,
  articleFile: string,
  source: "article" | "report"
): RagCapacityPatternRecord | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;

  const name = typeof r.name === "string" ? r.name : null;
  const capacity = typeof r.capacity === "string" ? r.capacity : null;
  if (!name || !capacity) return null;

  const extracted = extractCapacityTotal(capacity);
  const price = typeof r.price === "number" ? r.price : null;
  const pricePerUnit =
    typeof r.pricePerUnit === "string"
      ? r.pricePerUnit
      : price && extracted
      ? calcPricePerUnit(price, capacity)
      : null;

  const needsReview =
    !extracted ||
    capacity === "-" ||
    isNeedsReview(pricePerUnit);

  return {
    type: "capacity-pattern",
    source,
    articleFile,
    name,
    capacity,
    extractedTotal: extracted,
    pricePerUnit: pricePerUnit ?? null,
    needsReview,
    reason: needsReview ? (!extracted ? "capacity抽出不可" : "pricePerUnit要確認") : null,
  };
}

// ─── articleFile → 正規化パス ─────────────────────────────────────────────────

export function toArticleFilePath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  // 絶対パスや src/content/articles/ を含む場合はその位置から切り出す
  const marker = "src/content/articles/";
  const idx = normalized.indexOf(marker);
  if (idx !== -1) return normalized.slice(idx);
  // ARTICLES_DIR からの相対パス（フラット or サブディレクトリ）
  return `${marker}${normalized}`;
}
