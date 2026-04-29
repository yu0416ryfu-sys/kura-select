import { describe, it, expect } from "vitest";
import {
  extractProductNames,
  buildSearchKeyword,
  updateProductInFrontmatter,
} from "../scripts/lib/frontmatter";

// ─── テスト用フィクスチャ ─────────────────────────────────────────────────
const SAMPLE_FRONTMATTER = `---
title: "テスト記事"
description: "テスト用の説明"
category: test-category
publishedAt: 2026-04-01
products:
  - rank: 1
    name: "商品A 超特大 1200mL×2袋"
    brand: "ブランドA"
    price: 1980
    capacity: "1200mL×2袋"
    pricePerUnit: "約10円/回"
    rating: 4.5
    reviewCount: 500
    features:
      - "特徴1"
    pros:
      - "メリット1"
    cons:
      - "デメリット1"
    recommendedFor: "テスト対象者"
    rakutenUrl: "https://example.com/product-a"
    imageUrl: "https://example.com/image-a.jpg"
  - rank: 2
    name: "商品B レギュラー 500g"
    brand: "ブランドB"
    price: 980
    capacity: "500g"
    rating: 4.0
    reviewCount: 200
    features:
      - "特徴2"
    pros:
      - "メリット2"
    cons:
      - "デメリット2"
    recommendedFor: "テスト対象者B"
    rakutenUrl: "https://example.com/product-b"
    imageUrl: "https://example.com/image-b.jpg"
---

本文テキスト。
`;

// ─── extractProductNames ──────────────────────────────────────────────────
describe("extractProductNames", () => {
  it("フロントマターから商品名を全て抽出する", () => {
    const names = extractProductNames(SAMPLE_FRONTMATTER);
    expect(names).toEqual([
      "商品A 超特大 1200mL×2袋",
      "商品B レギュラー 500g",
    ]);
  });

  it("フロントマターがない場合は空配列を返す", () => {
    const names = extractProductNames("本文のみ。フロントマターなし。");
    expect(names).toEqual([]);
  });

  it("productsがない場合は空配列を返す", () => {
    const content = `---
title: "商品なし記事"
description: "説明"
---

本文。
`;
    expect(extractProductNames(content)).toEqual([]);
  });

  it("CRLF改行コードでも正しく動作する", () => {
    const crlf = SAMPLE_FRONTMATTER.replace(/\n/g, "\r\n");
    const names = extractProductNames(crlf);
    expect(names).toEqual([
      "商品A 超特大 1200mL×2袋",
      "商品B レギュラー 500g",
    ]);
  });
});

// ─── buildSearchKeyword ───────────────────────────────────────────────────
describe("buildSearchKeyword", () => {
  it("括弧内を除去する", () => {
    expect(buildSearchKeyword("アタック ZERO（ドラム式専用）")).toBe(
      "アタック ZERO"
    );
  });

  it("全角括弧も除去する", () => {
    expect(buildSearchKeyword("レノア 本格消臭（抗菌ビーズ入り）")).toBe(
      "レノア 本格消臭"
    );
  });

  it("容量・数量以降を除去する", () => {
    expect(buildSearchKeyword("ボールド 詰め替え 1500mL×3袋")).toBe(
      "ボールド 詰め替え"
    );
  });

  it("×N以降を除去する", () => {
    expect(buildSearchKeyword("スコッティ フラワーパック×12ロール")).toBe(
      "スコッティ フラワーパック"
    );
  });

  it("サイズ表現を除去する", () => {
    expect(buildSearchKeyword("レノア 本格消臭 柔軟剤 詰め替え 超特大")).toBe(
      "レノア 本格消臭 柔軟剤 詰め替え"
    );
  });

  it("40文字を超える場合は切り詰める", () => {
    const longName = "あ".repeat(50);
    expect(buildSearchKeyword(longName).length).toBe(40);
  });

  it("3文字未満になる場合は元の名前の先頭30文字を使用", () => {
    // 全部除去されるケース: 括弧のみの名前
    const result = buildSearchKeyword("(テスト商品名)");
    expect(result).toBe("(テスト商品名)".slice(0, 30));
  });
});

// ─── updateProductInFrontmatter ───────────────────────────────────────────
describe("updateProductInFrontmatter", () => {
  it("指定商品の price を更新する", () => {
    const updated = updateProductInFrontmatter(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋", {
      price: 2500,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
    });
    expect(updated).toContain("    price: 2500");
    // 商品Bは変更されない
    expect(updated).toContain("    price: 980");
  });

  it("指定商品の rating と reviewCount を更新する", () => {
    const updated = updateProductInFrontmatter(SAMPLE_FRONTMATTER, "商品B レギュラー 500g", {
      price: null,
      rating: 4.8,
      reviewCount: 1500,
      affiliateUrl: null,
      imageUrl: null,
    });
    expect(updated).toContain("    rating: 4.8");
    expect(updated).toContain("    reviewCount: 1500");
    // 商品Aは変更されない
    expect(updated).toContain("    rating: 4.5");
    expect(updated).toContain("    reviewCount: 500");
  });

  it("affiliateUrl と imageUrl を更新する", () => {
    const updated = updateProductInFrontmatter(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋", {
      price: null,
      rating: null,
      reviewCount: null,
      affiliateUrl: "https://new-affiliate.example.com/a",
      imageUrl: "https://new-image.example.com/a.jpg",
    });
    expect(updated).toContain('    rakutenUrl: "https://new-affiliate.example.com/a"');
    expect(updated).toContain('    imageUrl: "https://new-image.example.com/a.jpg"');
  });

  it("存在しない商品名の場合はコンテンツをそのまま返す", () => {
    const updated = updateProductInFrontmatter(SAMPLE_FRONTMATTER, "存在しない商品", {
      price: 999,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
    });
    expect(updated).toBe(SAMPLE_FRONTMATTER);
  });

  it("フロントマターがない場合はコンテンツをそのまま返す", () => {
    const content = "本文のみ";
    const updated = updateProductInFrontmatter(content, "商品A", {
      price: 999,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
    });
    expect(updated).toBe(content);
  });

  it("本文部分は変更されない", () => {
    const updated = updateProductInFrontmatter(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋", {
      price: 3000,
      rating: 4.9,
      reviewCount: 999,
      affiliateUrl: "https://new.example.com",
      imageUrl: "https://new-img.example.com/x.jpg",
    });
    expect(updated).toContain("\n本文テキスト。\n");
  });
});
