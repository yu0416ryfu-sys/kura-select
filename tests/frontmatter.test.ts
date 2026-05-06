import { describe, it, expect } from "vitest";
import {
  extractProductNames,
  buildSearchKeyword,
  updateProductInFrontmatter,
  extractProductCapacity,
  extractCapacityTotal,
  calcPricePerUnit,
  extractCapacityFromItemName,
  removeProductFromFrontmatter,
  reorderProductsByPricePerUnit,
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

  it("pricePerUnit フィールドが存在する場合は更新する", () => {
    const updated = updateProductInFrontmatter(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋", {
      price: null,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
      pricePerUnit: "約1.2円/mL",
    });
    expect(updated).toContain('    pricePerUnit: "約1.2円/mL"');
    // 商品Bは変更されない
    expect(updated).not.toContain('    pricePerUnit: "約1.2円/mL"\n    rating: 4.0');
  });

  it("pricePerUnit が null の場合は既存値を保持する", () => {
    const updated = updateProductInFrontmatter(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋", {
      price: 2500,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
      pricePerUnit: null,
    });
    expect(updated).toContain('    pricePerUnit: "約10円/回"');
  });
});

// ─── extractProductCapacity ───────────────────────────────────────────────
describe("extractProductCapacity", () => {
  it("商品名から capacity を取得する", () => {
    expect(extractProductCapacity(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋")).toBe("1200mL×2袋");
  });

  it("2番目の商品の capacity を取得する", () => {
    expect(extractProductCapacity(SAMPLE_FRONTMATTER, "商品B レギュラー 500g")).toBe("500g");
  });

  it("存在しない商品名の場合は null を返す", () => {
    expect(extractProductCapacity(SAMPLE_FRONTMATTER, "存在しない商品")).toBeNull();
  });
});

// ─── extractCapacityTotal ─────────────────────────────────────────────────
describe("extractCapacityTotal", () => {
  it("括弧内の総量（コンマ付き）を抽出する", () => {
    expect(extractCapacityTotal("60枚×48個（2,880枚）")).toEqual({ total: 2880, unit: "枚" });
  });

  it("複数の掛け算を含む括弧総量を抽出する", () => {
    expect(extractCapacityTotal("43枚×8個×4セット（1,376枚）")).toEqual({ total: 1376, unit: "枚" });
  });

  it("括弧内が数値でない場合は掛け算パターンにフォールバック", () => {
    expect(extractCapacityTotal("1200mL×2袋")).toEqual({ total: 2400, unit: "mL" });
  });

  it("携帯用など説明文の括弧でも手前の数値を使う", () => {
    expect(extractCapacityTotal("30枚（携帯用）")).toEqual({ total: 30, unit: "枚" });
  });

  it("シンプルな単位のみの場合を解析する", () => {
    expect(extractCapacityTotal("500g")).toEqual({ total: 500, unit: "g" });
  });

  it("括弧総量が最優先される", () => {
    expect(extractCapacityTotal("70枚×3個（210枚）")).toEqual({ total: 210, unit: "枚" });
  });

  it("解析できない文字列は null を返す", () => {
    expect(extractCapacityTotal("詰め替え用")).toBeNull();
  });
});

// ─── updateProductInFrontmatter (newName / newCapacity) ──────────────────
describe("updateProductInFrontmatter (newName/newCapacity)", () => {
  it("newName で name フィールドを更新する", () => {
    const updated = updateProductInFrontmatter(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋", {
      price: null,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
      newName: "商品A 新名称",
    });
    expect(updated).toContain('    name: "商品A 新名称"');
    expect(updated).not.toContain('    name: "商品A 超特大 1200mL×2袋"');
  });

  it("newCapacity で capacity フィールドを更新する", () => {
    const updated = updateProductInFrontmatter(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋", {
      price: null,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
      newCapacity: "1200mL×3袋",
    });
    expect(updated).toContain('    capacity: "1200mL×3袋"');
    expect(updated).not.toContain('    capacity: "1200mL×2袋"');
  });
});

// ─── extractCapacityFromItemName ──────────────────────────────────────────
describe("extractCapacityFromItemName", () => {
  it("掛け算パターンを抽出する", () => {
    expect(extractCapacityFromItemName("スコッティ 200枚×5箱")).toBe("200枚×5");
  });

  it("掛け算パターンで後の単位も含める", () => {
    expect(extractCapacityFromItemName("ネピア 50mL×3本")).toBe("50mL×3本");
  });

  it("括弧内総量パターンを抽出する", () => {
    expect(extractCapacityFromItemName("ネピア ティシュー（2,880枚）")).toBe("（2,880枚）");
  });

  it("シンプルパターンを抽出する", () => {
    expect(extractCapacityFromItemName("ビオレ ボディウォッシュ 500mL")).toBe("500mL");
  });

  it("容量表記がない場合は null を返す", () => {
    expect(extractCapacityFromItemName("商品名のみ テキスト")).toBeNull();
  });
});

// ─── removeProductFromFrontmatter ─────────────────────────────────────────
const SINGLE_PRODUCT_FRONTMATTER = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "商品A 超特大 1200mL×2袋"
    brand: "ブランドA"
    price: 1980
    capacity: "1200mL×2袋"
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
---

本文テキスト。
`;

describe("removeProductFromFrontmatter", () => {
  it("2商品から1番目を削除すると残りが rank:1 になる", () => {
    const result = removeProductFromFrontmatter(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋");
    expect(result).not.toBeNull();
    expect(result).toContain('  - rank: 1');
    expect(result).toContain('"商品B レギュラー 500g"');
    expect(result).not.toContain('"商品A 超特大 1200mL×2袋"');
    expect(result).not.toContain('  - rank: 2');
  });

  it("2商品から2番目を削除すると残りが rank:1 になる", () => {
    const result = removeProductFromFrontmatter(SAMPLE_FRONTMATTER, "商品B レギュラー 500g");
    expect(result).not.toBeNull();
    expect(result).toContain('  - rank: 1');
    expect(result).toContain('"商品A 超特大 1200mL×2袋"');
    expect(result).not.toContain('"商品B レギュラー 500g"');
    expect(result).not.toContain('  - rank: 2');
  });

  it("最後の1商品の場合は null を返す", () => {
    const result = removeProductFromFrontmatter(SINGLE_PRODUCT_FRONTMATTER, "商品A 超特大 1200mL×2袋");
    expect(result).toBeNull();
  });

  it("存在しない商品名の場合は null を返す", () => {
    const result = removeProductFromFrontmatter(SAMPLE_FRONTMATTER, "存在しない商品");
    expect(result).toBeNull();
  });
});

// ─── reorderProductsByPricePerUnit ────────────────────────────────────────
const PPU_SAMPLE = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "商品A"
    price: 1000
    capacity: "100枚"
    pricePerUnit: "約10円/枚"
    rakutenUrl: "https://example.com/a"
    imageUrl: "https://example.com/a.jpg"
  - rank: 2
    name: "商品B"
    price: 500
    capacity: "100枚"
    pricePerUnit: "約5円/枚"
    rakutenUrl: "https://example.com/b"
    imageUrl: "https://example.com/b.jpg"
---

本文テキスト。
`;

const PPU_SORTED_SAMPLE = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "商品A"
    price: 500
    capacity: "100枚"
    pricePerUnit: "約5円/枚"
    rakutenUrl: "https://example.com/a"
    imageUrl: "https://example.com/a.jpg"
  - rank: 2
    name: "商品B"
    price: 1000
    capacity: "100枚"
    pricePerUnit: "約10円/枚"
    rakutenUrl: "https://example.com/b"
    imageUrl: "https://example.com/b.jpg"
---

本文テキスト。
`;

describe("reorderProductsByPricePerUnit", () => {
  it("安い順に並び替えて changed:true を返す", () => {
    const result = reorderProductsByPricePerUnit(PPU_SAMPLE);
    expect(result.changed).toBe(true);
    // 商品B（5円/枚）が rank:1、商品A（10円/枚）が rank:2 になる
    expect(result.content).toMatch(/- rank: 1[\s\S]*?name: "商品B"/);
    expect(result.content).toMatch(/- rank: 2[\s\S]*?name: "商品A"/);
    expect(result.log.length).toBeGreaterThan(0);
  });

  it("既に安い順の場合は changed:false を返す", () => {
    const result = reorderProductsByPricePerUnit(PPU_SORTED_SAMPLE);
    expect(result.changed).toBe(false);
    expect(result.log).toEqual([]);
  });

  it("pricePerUnit が1件以下の場合はスキップ", () => {
    const result = reorderProductsByPricePerUnit(SAMPLE_FRONTMATTER);
    expect(result.changed).toBe(false);
  });

  it("単位が混在する場合はスキップしてログを返す", () => {
    const mixedSample = PPU_SAMPLE.replace('約5円/枚', '約5円/mL');
    const result = reorderProductsByPricePerUnit(mixedSample);
    expect(result.changed).toBe(false);
    expect(result.log[0]).toContain('単位が混在');
  });

  it("商品が1件の場合はスキップ", () => {
    const result = reorderProductsByPricePerUnit(SINGLE_PRODUCT_FRONTMATTER);
    expect(result.changed).toBe(false);
  });
});

// ─── calcPricePerUnit ─────────────────────────────────────────────────────
describe("calcPricePerUnit", () => {
  it("括弧付き容量から単価を計算する（小数1桁）", () => {
    expect(calcPricePerUnit(7480, "60枚×48個（2,880枚）")).toBe("約2.6円/枚");
  });

  it("小パック商品の単価を計算する", () => {
    expect(calcPricePerUnit(250, "30枚（携帯用）")).toBe("約8.3円/枚");
  });

  it("詰め替えパックの単価を計算する", () => {
    expect(calcPricePerUnit(1097, "70枚×3個（210枚）")).toBe("約5.2円/枚");
  });

  it("複数セットの単価を計算する", () => {
    expect(calcPricePerUnit(5269, "43枚×8個×4セット（1,376枚）")).toBe("約3.8円/枚");
  });

  it("1円未満の単価は小数2桁で表示する", () => {
    expect(calcPricePerUnit(217, "30枚×10個（300枚）")).toBe("約0.72円/枚");
  });

  it("10円以上の単価は整数で表示する", () => {
    expect(calcPricePerUnit(1500, "50枚")).toBe("約30円/枚");
  });

  it("解析できない容量は null を返す", () => {
    expect(calcPricePerUnit(1000, "詰め替え用")).toBeNull();
  });
});
