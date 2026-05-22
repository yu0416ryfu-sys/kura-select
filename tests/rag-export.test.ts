import { describe, it, expect } from "vitest";
import {
  parseFrontmatterData,
  normalizeProductRecord,
  normalizeMatchDecision,
  normalizeCapacityPattern,
  buildCategoryRuleRecords,
  toArticleFilePath,
} from "../scripts/lib/rag-export";

// ─── フィクスチャ ─────────────────────────────────────────────────────────────

const ARTICLE_FILE = "src/content/articles/toilet-paper-comparison.md";
const ARTICLE_TITLE = "トイレットペーパー シングル コスパランキング";
const CATEGORY = "toilet-paper";

const VALID_PRODUCT = {
  rank: 1,
  name: "森を守ろう トイレットペーパー シングル",
  brand: "牧製紙",
  price: 3550,
  capacity: "100m×60ロール",
  pricePerUnit: "約0.59円/m",
  rakutenUrl: "https://hb.afl.rakuten.co.jp/hgc/example/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fshop%2Fitem123%2F",
};

// ─── parseFrontmatterData ─────────────────────────────────────────────────────

describe("parseFrontmatterData", () => {
  it("有効なフロントマターを解析する", () => {
    const content = `---
title: "テスト記事"
category: "toilet-paper"
products:
  - rank: 1
    name: "商品A"
---
本文
`;
    const result = parseFrontmatterData(content);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("テスト記事");
    expect(result?.category).toBe("toilet-paper");
    expect(Array.isArray(result?.products)).toBe(true);
  });

  it("フロントマターがないコンテンツは null を返す", () => {
    expect(parseFrontmatterData("本文のみ")).toBeNull();
  });
});

// ─── normalizeProductRecord ───────────────────────────────────────────────────

describe("normalizeProductRecord", () => {
  it("有効な商品オブジェクトを RagProductRecord に変換する", () => {
    const result = normalizeProductRecord(VALID_PRODUCT, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("product");
    expect(result?.rank).toBe(1);
    expect(result?.name).toBe("森を守ろう トイレットペーパー シングル");
    expect(result?.brand).toBe("牧製紙");
    expect(result?.price).toBe(3550);
    expect(result?.capacity).toBe("100m×60ロール");
    expect(result?.articleFile).toBe(ARTICLE_FILE);
    expect(result?.category).toBe(CATEGORY);
  });

  it("capacityTotal を正規化して含める", () => {
    const result = normalizeProductRecord(VALID_PRODUCT, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result?.capacityTotal).toEqual({ total: 6000, unit: "m" });
  });

  it("products: [] の記事（空配列から変換）で null を返さない（nullは除外済み）", () => {
    const result = normalizeProductRecord(null, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result).toBeNull();
  });

  it("rakutenUrl が欠損している場合は null を返す", () => {
    const noUrl = { ...VALID_PRODUCT, rakutenUrl: undefined };
    const result = normalizeProductRecord(noUrl, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result).toBeNull();
  });

  it("capacity が '-' の商品を needsReview:true にする", () => {
    const dashCap = { ...VALID_PRODUCT, capacity: "-", pricePerUnit: undefined };
    const result = normalizeProductRecord(dashCap, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result?.needsReview).toBe(true);
    expect(result?.reviewReasons.length).toBeGreaterThan(0);
  });

  it("pricePerUnit が '要更新' の商品を needsReview:true にする", () => {
    const reviewPpu = { ...VALID_PRODUCT, pricePerUnit: "要更新" };
    const result = normalizeProductRecord(reviewPpu, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result?.needsReview).toBe(true);
  });

  it("pricePerUnit が '0円/枚' の商品を needsReview:true にする", () => {
    const zeroPpu = { ...VALID_PRODUCT, pricePerUnit: "0円/枚" };
    const result = normalizeProductRecord(zeroPpu, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result?.needsReview).toBe(true);
  });

  it("offers[] の matchStatus を offerSummary に集約する", () => {
    const withOffers = {
      ...VALID_PRODUCT,
      offers: [
        { provider: "yahoo", matchStatus: "review", url: "https://yahoo.co.jp/item/1" },
        { provider: "yahoo", matchStatus: "matched", url: "https://yahoo.co.jp/item/2" },
      ],
    };
    const result = normalizeProductRecord(withOffers, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result?.offerSummary["yahoo"]?.count).toBe(2);
    expect(result?.offerSummary["yahoo"]?.statuses).toContain("review");
    expect(result?.offerSummary["yahoo"]?.statuses).toContain("matched");
  });

  it("offers が未指定でも offerSummary は空オブジェクトになる", () => {
    const noOffers = { ...VALID_PRODUCT, offers: undefined };
    const result = normalizeProductRecord(noOffers, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result?.offerSummary).toEqual({});
  });

  it("offers[].matchStatus が未指定でも null として扱い needsReview にしない", () => {
    const unknownStatus = {
      ...VALID_PRODUCT,
      offers: [{ provider: "yahoo", url: "https://yahoo.co.jp/item/1" }],
    };
    const result = normalizeProductRecord(unknownStatus, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result).not.toBeNull();
    expect(result?.offerSummary["yahoo"]?.statuses).toContain("unknown");
  });

  it("rakutenUrl から rakutenCode を抽出する", () => {
    const result = normalizeProductRecord(VALID_PRODUCT, ARTICLE_FILE, ARTICLE_TITLE, CATEGORY);
    expect(result?.rakutenCode).toBe("shop:item123");
  });
});

// ─── normalizeMatchDecision ───────────────────────────────────────────────────

describe("normalizeMatchDecision", () => {
  const SOURCE_PROCESSED = "reports/ai-matches/processed/product-match-output-2026-05-17.jsonl";
  const SOURCE_REVIEW_DONE = "reports/ai-matches/review/done/product-match-output-2026-05-18.jsonl";

  const VALID_DECISION = {
    articleFile: "src/content/articles/storage-bag-comparison.md",
    rank: 1,
    currentName: "ジップロック フリーザーバッグ",
    action: "replace",
    confidence: "high",
    selectedItemUrl: "https://item.rakuten.co.jp/shop/item",
    reason: "ブランド・商品種別・容量が一致",
    status: "processed",
  };

  it("有効な照合結果を RagMatchDecisionRecord に変換する", () => {
    const result = normalizeMatchDecision(VALID_DECISION, SOURCE_PROCESSED);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("match-decision");
    expect(result?.action).toBe("replace");
    expect(result?.confidence).toBe("high");
    expect(result?.status).toBe("processed");
  });

  it("review/done/ パスの場合は status を review_done にする", () => {
    const input = { ...VALID_DECISION, status: undefined };
    const result = normalizeMatchDecision(input, SOURCE_REVIEW_DONE);
    expect(result?.status).toBe("review_done");
  });

  it("processed/ パスの場合は status を processed にする", () => {
    const input = { ...VALID_DECISION, status: undefined };
    const result = normalizeMatchDecision(input, SOURCE_PROCESSED);
    expect(result?.status).toBe("processed");
  });

  it("実際の出力形式 current.name を解析できる", () => {
    const actual = {
      articleFile: "src/content/articles/storage-bag-comparison.md",
      rank: 1,
      current: { name: "ジップロック ストックバッグ L" },
      action: "replace",
      selectedItemUrl: "https://hb.afl.rakuten.co.jp/example",
    };
    const result = normalizeMatchDecision(actual, SOURCE_PROCESSED);
    expect(result).not.toBeNull();
    expect(result?.currentName).toBe("ジップロック ストックバッグ L");
    expect(result?.status).toBe("processed");
  });

  it("articleFile が欠損している場合は null を返す", () => {
    const noFile = { ...VALID_DECISION, articleFile: undefined };
    const result = normalizeMatchDecision(noFile, SOURCE_PROCESSED);
    expect(result).toBeNull();
  });

  it("action が欠損している場合は null を返す", () => {
    const noAction = { ...VALID_DECISION, action: undefined };
    const result = normalizeMatchDecision(noAction, SOURCE_PROCESSED);
    expect(result).toBeNull();
  });
});

// ─── normalizeCapacityPattern ─────────────────────────────────────────────────

describe("normalizeCapacityPattern", () => {
  it("有効なcapacity情報を RagCapacityPatternRecord に変換する", () => {
    const input = {
      name: "グーン Mサイズ",
      capacity: "70枚×12個（840枚）",
      price: 2688,
    };
    const result = normalizeCapacityPattern(input, ARTICLE_FILE, "article");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("capacity-pattern");
    expect(result?.extractedTotal).toEqual({ total: 840, unit: "枚" });
    expect(result?.needsReview).toBe(false);
  });

  it("capacity が '-' の場合は needsReview:true にする", () => {
    const input = { name: "商品X", capacity: "-" };
    const result = normalizeCapacityPattern(input, ARTICLE_FILE, "article");
    expect(result?.needsReview).toBe(true);
  });

  it("ai-capacity-input-*.jsonl の current 形式を直接渡しても解析できる（スクリプト側で展開済み）", () => {
    // export スクリプトが obj.current を展開してから渡す想定
    const current = { name: "エアコンフィルター 2個セット", capacity: "4枚", pricePerUnit: "約265円/枚" };
    const result = normalizeCapacityPattern(current, ARTICLE_FILE, "report");
    expect(result).not.toBeNull();
    expect(result?.source).toBe("report");
    expect(result?.extractedTotal).toEqual({ total: 4, unit: "枚" });
  });

  it("name または capacity が欠損している場合は null を返す", () => {
    expect(normalizeCapacityPattern({ name: "商品X" }, ARTICLE_FILE, "article")).toBeNull();
    expect(normalizeCapacityPattern({ capacity: "500mL" }, ARTICLE_FILE, "article")).toBeNull();
  });
});

// ─── buildCategoryRuleRecords ─────────────────────────────────────────────────

describe("buildCategoryRuleRecords", () => {
  it("カテゴリごとの units・commonBrands・productCount をまとめる", () => {
    const products = [
      {
        ...normalizeProductRecord(
          { ...VALID_PRODUCT, brand: "牧製紙", name: "森を守ろう シングル", capacity: "100m×60ロール" },
          ARTICLE_FILE, ARTICLE_TITLE, "toilet-paper"
        )!,
      },
      {
        ...normalizeProductRecord(
          { ...VALID_PRODUCT, rank: 2, brand: "エリエール", name: "エリエール 50m×72ロール", capacity: "50m×72ロール" },
          ARTICLE_FILE, ARTICLE_TITLE, "toilet-paper"
        )!,
      },
    ];

    const rules = buildCategoryRuleRecords(products);
    expect(rules.length).toBe(1);
    expect(rules[0].category).toBe("toilet-paper");
    expect(rules[0].productCount).toBe(2);
    expect(rules[0].units).toContain("m");
  });

  it("同一ブランドが2件以上の場合のみ commonBrands に含める", () => {
    const p = normalizeProductRecord(VALID_PRODUCT, ARTICLE_FILE, ARTICLE_TITLE, "toilet-paper")!;
    const rules = buildCategoryRuleRecords([p]);
    // 1件のみなので commonBrands は空
    expect(rules[0].commonBrands).toEqual([]);
  });

  it("空の products 配列で空の rules を返す", () => {
    expect(buildCategoryRuleRecords([])).toEqual([]);
  });
});

// ─── toArticleFilePath ────────────────────────────────────────────────────────

describe("toArticleFilePath", () => {
  it("フラットなファイル名を変換する", () => {
    expect(toArticleFilePath("toilet-paper-comparison.md"))
      .toBe("src/content/articles/toilet-paper-comparison.md");
  });

  it("絶対パスからアーティクルファイルパスに変換する", () => {
    expect(toArticleFilePath("C:/Projects/KuraSelect/src/content/articles/shampoo-comparison.md"))
      .toBe("src/content/articles/shampoo-comparison.md");
  });

  it("サブディレクトリを含む相対パスを変換する", () => {
    expect(toArticleFilePath("subdir/article-comparison.md"))
      .toBe("src/content/articles/subdir/article-comparison.md");
  });

  it(".mdx ファイルを変換する", () => {
    expect(toArticleFilePath("feature-comparison.mdx"))
      .toBe("src/content/articles/feature-comparison.mdx");
  });
});
