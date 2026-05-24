import { describe, it, expect } from "vitest";
import {
  extractProductNames,
  buildSearchKeyword,
  updateProductInFrontmatter,
  extractProductSnapshot,
  extractProductCapacity,
  extractProductRakutenUrl,
  extractCapacityTotal,
  normalizeCapacityTotal,
  calcPricePerUnit,
  extractCapacityFromItemName,
  analyzeCapacityFromItemName,
  isMultiMeasureVariantItemName,
  mergeExistingMeasureWithSalesQuantity,
  isSameMeasureBaseWithExistingQuantity,
  isSalesQuantityCapacity,
  hasMeasureCapacity,
  isLikelySalesQuantityCapacityMisread,
  removeCapacityFromProductName,
  removeProductFromFrontmatter,
  reorderProductsByPricePerUnit,
  limitProductsByRank,
  syncTitleProductCount,
  updateUpdatedAt,
  fixNameCapacityConflicts,
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

  it("販促用の隅付き括弧を除去する", () => {
    expect(buildSearchKeyword("【1点限り！令和お試し価格】ユニ・チャーム シルコット うるうる コットン")).toBe(
      "ユニ・チャーム シルコット うるうる コットン"
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

  it("菌XX%除去のマーケティング表現を除去する", () => {
    expect(buildSearchKeyword("おしりふき ふんわり 菌99.9除去 大容量")).toBe(
      "おしりふき ふんわり"
    );
  });

  it("単独の英字サイズトークンを除去する", () => {
    expect(buildSearchKeyword("おむつ テープ M")).toBe("おむつ テープ");
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
describe("extractProductSnapshot", () => {
  it("returns log fields for a product", () => {
    const content = `---
title: "Sample"
products:
  - name: "Alpha"
    price: 1200
    rating: 4.5
    reviewCount: 30
    rakutenUrl: "https://example.com/a"
    imageUrl: "https://example.com/a.jpg"
    capacity: "500mL"
    pricePerUnit: "2.4/mL"
---

body
`;

    expect(extractProductSnapshot(content, "Alpha")).toEqual({
      name: "Alpha",
      price: 1200,
      rating: 4.5,
      reviewCount: 30,
      rakutenUrl: "https://example.com/a",
      imageUrl: "https://example.com/a.jpg",
      capacity: "500mL",
      pricePerUnit: "2.4/mL",
    });
  });

  it("returns null for a missing product", () => {
    expect(extractProductSnapshot(SAMPLE_FRONTMATTER, "Missing")).toBeNull();
  });
});

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

// ─── extractProductRakutenUrl ─────────────────────────────────────────────
describe("extractProductRakutenUrl", () => {
  it("1番目の商品の rakutenUrl を取得する", () => {
    expect(extractProductRakutenUrl(SAMPLE_FRONTMATTER, "商品A 超特大 1200mL×2袋"))
      .toBe("https://example.com/product-a");
  });

  it("2番目の商品の rakutenUrl を取得する", () => {
    expect(extractProductRakutenUrl(SAMPLE_FRONTMATTER, "商品B レギュラー 500g"))
      .toBe("https://example.com/product-b");
  });

  it("存在しない商品名の場合は null を返す", () => {
    expect(extractProductRakutenUrl(SAMPLE_FRONTMATTER, "存在しない商品")).toBeNull();
  });

  it("rakutenUrl フィールドがない商品は null を返す", () => {
    const noUrl = SAMPLE_FRONTMATTER.replace(
      '    rakutenUrl: "https://example.com/product-a"\n',
      ''
    );
    expect(extractProductRakutenUrl(noUrl, "商品A 超特大 1200mL×2袋")).toBeNull();
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

  it("アスタリスク区切りの掛け算を計算する", () => {
    expect(extractCapacityTotal("400mL*3袋")).toEqual({ total: 1200, unit: "mL" });
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

  it("括弧内の内訳を乗数として誤認しない（先頭数値が総量）", () => {
    // "248枚（62枚×4個・...）" → 括弧は内訳注釈なので 248 がそのまま総量
    expect(extractCapacityTotal("248枚（62枚×4個・新生児サイズ・〜5000g）")).toEqual({ total: 248, unit: "枚" });
  });

  it("3因子の掛け算を計算する（箱・パック単位）", () => {
    expect(extractCapacityTotal("500枚×5箱×12パック")).toEqual({ total: 30000, unit: "枚" });
  });

  it("2因子の掛け算（非CAPACITY_UNITS単位あり）を計算する", () => {
    expect(extractCapacityTotal("500枚×60箱")).toEqual({ total: 30000, unit: "枚" });
  });

  it("括弧注釈付きは枚数のみ返す", () => {
    expect(extractCapacityTotal("500枚(250組)")).toEqual({ total: 500, unit: "枚" });
  });

  it("ロール単位付き掛け算の総量を計算する", () => {
    expect(extractCapacityTotal("40m×4ロール")).toEqual({ total: 160, unit: "m" });
  });

  it("ロール＋パック単位の3因子掛け算を計算する", () => {
    expect(extractCapacityTotal("50m×12ロール×6パック")).toEqual({ total: 3600, unit: "m" });
  });

  it("全角ｍを正規化して計算する", () => {
    expect(extractCapacityTotal("25ｍ×12ロール")).toEqual({ total: 300, unit: "m" });
  });

  it("包単位のシンプルな数量を計算する", () => {
    expect(extractCapacityTotal("82包")).toEqual({ total: 82, unit: "包" });
  });

  it("錠単位のシンプルな数量を計算する", () => {
    expect(extractCapacityTotal("56錠")).toEqual({ total: 56, unit: "錠" });
  });

  it("包単位の掛け算を計算する", () => {
    expect(extractCapacityTotal("30包×3セット")).toEqual({ total: 90, unit: "包" });
  });

  it("ロール単位のみの容量を解析する（PACK_UNITS基底単位）", () => {
    expect(extractCapacityTotal("48ロール")).toEqual({ total: 48, unit: "ロール" });
  });

  it("ロール×パック単位の掛け算を計算する（PACK_UNITS基底単位）", () => {
    expect(extractCapacityTotal("12ロール×4パック")).toEqual({ total: 48, unit: "ロール" });
  });

  it("箱単位のみの容量を解析する（PACK_UNITS基底単位）", () => {
    expect(extractCapacityTotal("6箱")).toEqual({ total: 6, unit: "箱" });
  });

  it("CAPACITY_UNITS基底単位のケースをPACK_UNITSより優先する（既存動作の回帰確認）", () => {
    expect(extractCapacityTotal("40m×4ロール")).toEqual({ total: 160, unit: "m" });
  });
});

// ─── normalizeCapacityTotal ───────────────────────────────────────────────
describe("normalizeCapacityTotal", () => {
  it("kg と g を比較用に g へ正規化する", () => {
    expect(normalizeCapacityTotal(extractCapacityTotal("3kg"))).toEqual({ total: 3000, unit: "g" });
    expect(normalizeCapacityTotal(extractCapacityTotal("720g"))).toEqual({ total: 720, unit: "g" });
  });

  it("L と mL を比較用に mL へ正規化する", () => {
    expect(normalizeCapacityTotal(extractCapacityTotal("1L"))).toEqual({ total: 1000, unit: "mL" });
    expect(normalizeCapacityTotal(extractCapacityTotal("750mL"))).toEqual({ total: 750, unit: "mL" });
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
  it("掛け算パターンを抽出する（箱単位も保持する）", () => {
    expect(extractCapacityFromItemName("スコッティ 200枚×5箱")).toBe("200枚×5箱");
  });

  it("掛け算パターンで後の単位も含める", () => {
    expect(extractCapacityFromItemName("ネピア 50mL×3本")).toBe("50mL×3本");
  });

  it("楽天商品名のアスタリスク区切りを掛け算として抽出する", () => {
    expect(
      extractCapacityFromItemName("ミノン 全身シャンプー 泡タイプ 詰替え用(400ml*3袋セット)")
    ).toBe("400ml×3袋");
  });

  it("括弧内総量パターンを抽出する", () => {
    expect(extractCapacityFromItemName("ネピア ティシュー（2,880枚）")).toBe("（2,880枚）");
  });

  it("括弧内の総量と内訳から総枚数を抽出する", () => {
    const capacity = extractCapacityFromItemName(
      "TANOSEE ゴミ袋エコノミー 乳白半透明 45L 1セット（1000枚：100枚×10パック）"
    );
    expect(capacity).toBe("（1000枚）");
    expect(extractCapacityTotal(capacity ?? "")).toEqual({ total: 1000, unit: "枚" });
  });

  it("シンプルパターンを抽出する", () => {
    expect(extractCapacityFromItemName("ビオレ ボディウォッシュ 500mL")).toBe("500mL");
  });

  it("容量表記がない場合は null を返す", () => {
    expect(extractCapacityFromItemName("商品名のみ テキスト")).toBeNull();
  });

  it("スペース区切りのロール数を掛け算として認識する（× なし）", () => {
    expect(extractCapacityFromItemName("エリエール i:na 50m 72ロール ダブル")).toBe("50m×72ロール");
  });

  it("スペース区切りで始まり × チェーンが続く場合に全因子を保持する（Pattern 1c）", () => {
    expect(extractCapacityFromItemName("ハロー トイレットペーパー 50m 12ロール×6パック")).toBe("50m×12ロール×6パック");
  });

  it("× 区切りの場合はパターン1が優先され、ロール単位も保持する", () => {
    expect(extractCapacityFromItemName("エリエール 50m×72ロール ダブル")).toBe("50m×72ロール");
  });

  it("3因子の掛け算チェーンで箱・パック単位を保持する", () => {
    expect(extractCapacityFromItemName("スコッティ ティッシュ 500枚×5箱×12パック")).toBe("500枚×5箱×12パック");
  });

  it("× 区切りでロール単位を保持する", () => {
    expect(extractCapacityFromItemName("トイレットペーパー 40m×4ロール シングル")).toBe("40m×4ロール");
  });

  it("× 区切りでロール＋パックを両方保持する", () => {
    expect(extractCapacityFromItemName("50m×12ロール×6パック まとめ買い")).toBe("50m×12ロール×6パック");
  });

  it("3因子チェーン（ロール＋パック）を抽出する", () => {
    expect(extractCapacityFromItemName("100m×12ロール×4パック")).toBe("100m×12ロール×4パック");
  });

  it("全角ｍを半角mに正規化して抽出する", () => {
    expect(extractCapacityFromItemName("25ｍ×12ロール")).toBe("25m×12ロール");
  });

  it("包単位を抽出する", () => {
    expect(extractCapacityFromItemName("バスクリン 日本の名湯 82包 15種アソート 入浴剤")).toBe("82包");
  });

  it("錠単位を抽出する", () => {
    expect(extractCapacityFromItemName("バブ 厳選4種類の香りセレクトBOX 56錠")).toBe("56錠");
  });

  it("ケース単位を含む3因子チェーンを抽出する", () => {
    expect(extractCapacityFromItemName("エリエール 200枚×48個×2ケース まとめ買い")).toBe("200枚×48個×2ケース");
  });

  it("スペース区切り＋× チェーンでロール×パックを抽出する（Pattern 1c）", () => {
    expect(extractCapacityFromItemName("スコッティ フラワーパック 100m 12ロール×4パック")).toBe("100m×12ロール×4パック");
  });

  it("スペース区切り＋× チェーン後の括弧内総量は無視する（Pattern 1c）", () => {
    expect(extractCapacityFromItemName("スコッティ フラワーパック 100m 12ロール×4パック(48ロール)")).toBe("100m×12ロール×4パック");
  });

  it("数量1のパック単位は Pattern 1d に委譲する（1パック はスキップ）", () => {
    expect(
      extractCapacityFromItemName(
        "大王製紙 エリエール i:na（イーナ）トイレットティシュー シングル 100m 1パック（12ロール）"
      )
    ).toBe("100m×12ロール");
  });

  it("括弧内に複数の PACK_UNITS がある場合に結合する（Pattern 1d）", () => {
    expect(
      extractCapacityFromItemName("50m ケース販売(12ロール×6パック入)")
    ).toBe("50m×12ロール×6パック");
  });

  it("括弧内の実数量内訳を外側の総量に掛けない（Pattern 1d 回帰）", () => {
    const capacity = extractCapacityFromItemName(
      "【まとめて格安200枚】ドリップバッグフィルター／1杯用 業務用バルク２００枚(５０枚束×４セット）"
    );

    expect(capacity).toBe("200枚");
    expect(extractCapacityTotal(capacity ?? "")).toEqual({ total: 200, unit: "枚" });
    expect(calcPricePerUnit(2530, capacity ?? "")).toBe("約13円/枚");
  });

  it("PACK×PACK チェーン後の合計括弧を乗算因子と誤認しない（Pattern 1d 修正）", () => {
    // "(48ロール)" は "12ロール×4パック" の合計（12×4=48）なので因子としてスキップ
    expect(
      extractCapacityFromItemName(
        "スコッティ トイレットペーパー 12ロール(シングル) 12ロール×4パック(48ロール) 100m"
      )
    ).toBe("100m×12ロール×4パック");
  });

  it("PACK×PACK と CAPACITY_UNIT が離れて出現するケースを結合する（Pattern 1e）", () => {
    // "12ロール×4パック" チェーンと "100m" が別位置 → 結合して "100m×12ロール×4パック"
    expect(
      extractCapacityFromItemName(
        "スコッティ フラワーパック 2倍長持ち 12ロール(シングル) 12ロール×4パック(48ロール) シングル 2倍巻き 倍 100m トイレ用品"
      )
    ).toBe("100m×12ロール×4パック");
  });

  it("PACK_UNIT 始まりのチェーンを正しい順序で抽出する（mulRe PACK_UNITS 拡張）", () => {
    expect(
      extractCapacityFromItemName("エリエール トイレットティシュー たっぷり長持ち ダブル（12ロール×6個セット）")
    ).toBe("12ロール×6個");
  });

  it("「のN個セット」表記を乗算として抽出する（Pattern 1f）", () => {
    expect(extractCapacityFromItemName("メリーズ エアスルー テープ Mサイズ 52枚の4個セット")).toBe("52枚×4個");
  });

  it("スペース区切りの「N個セット」を乗算として抽出する（Pattern 1f）", () => {
    expect(extractCapacityFromItemName("パンパース さらさらケア テープ 52枚 4個セット")).toBe("52枚×4個");
  });

  it("「のN個」（セットなし）を乗算として抽出する（Pattern 1f）", () => {
    expect(extractCapacityFromItemName("ビオレ ボディウォッシュ 400mLの3個")).toBe("400mL×3個");
  });

  it("「の1個セット」は乗算にしない（Pattern 1f: qty=1スキップ）", () => {
    expect(extractCapacityFromItemName("シャンプー 400mLの1個セット")).toBe("400mL");
  });

  it("ロール単位のみのタイトルからロール数を抽出する（Pattern 4）", () => {
    expect(extractCapacityFromItemName("エリエール トイレットペーパー 48ロール まとめ買い")).toBe("48ロール");
  });

  it("パック単位のみのタイトルからパック数を抽出する（Pattern 4）", () => {
    expect(extractCapacityFromItemName("洗剤 詰め替え 3パック お得セット")).toBe("3パック");
  });

  it("箱単位のみのタイトルから箱数を抽出する（Pattern 4）", () => {
    expect(extractCapacityFromItemName("スコッティ ティッシュ 5箱 まとめ買い")).toBe("5箱");
  });

  it("CAPACITY_UNITSが存在する場合はPattern 4より優先する（回帰確認）", () => {
    expect(extractCapacityFromItemName("シャンプー 500mL 3パック")).toBe("500mL×3パック");
  });

  it("ティッシュの組数注釈つき箱数を1つのcapacityとして抽出する", () => {
    const capacity = extractCapacityFromItemName(
      "エリエール ティシュー 200枚（100組）×12箱"
    );

    expect(capacity).toBe("200枚（100組）×12箱");
    expect(extractCapacityTotal(capacity ?? "")).toEqual({ total: 2400, unit: "枚" });
  });

  it("ラップの幅×長さ表記では長さと販売数量を抽出する", () => {
    const capacity = extractCapacityFromItemName(
      "NEWクレラップ レギュラー 30cm*50m(1コ入*3コセット)"
    );

    expect(capacity).toBe("50m×3個");
    expect(extractCapacityTotal(capacity ?? "")).toEqual({ total: 150, unit: "m" });
  });

  it("ラップ単品の幅×長さ表記では長さだけを抽出する", () => {
    const capacity = extractCapacityFromItemName("サランラップ ミニ 22cm×50m");

    expect(capacity).toBe("50m");
    expect(extractCapacityTotal(capacity ?? "")).toEqual({ total: 50, unit: "m" });
  });
});

describe("isMultiMeasureVariantItemName", () => {
  it("複数の重量バリエーションが並ぶ商品名を検知する", () => {
    expect(
      isMultiMeasureVariantItemName(
        "令和7年 佐渡産 コシヒカリ 朱鷺認証米 特別栽培米 2kg 5kg 10kg 15kg 20kg 25kg"
      )
    ).toBe(true);
  });

  it("単一容量の商品名は検知しない", () => {
    expect(isMultiMeasureVariantItemName("令和7年 佐渡産コシヒカリ 5kg")).toBe(false);
  });

  it("実容量と販売数量の掛け算は複数容量扱いにしない", () => {
    expect(isMultiMeasureVariantItemName("無洗米 コシヒカリ 5kg×2袋")).toBe(false);
    expect(isMultiMeasureVariantItemName("シャンプー 500mL×3本")).toBe(false);
  });
});

describe("analyzeCapacityFromItemName garbage-bag cases", () => {
  it("45Lの袋サイズより括弧内の総枚数を優先する", () => {
    const result = analyzeCapacityFromItemName(
      "TANOSEE　ゴミ袋エコノミー　乳白半透明　45L　1セット（1000枚：100枚×10パック） 【送料無料】"
    );
    expect(result.capacity).toBe("（1000枚）");
    expect(result.normalizedTotal).toEqual({ total: 1000, unit: "枚" });
    expect(result.confidence).toBe("high");
  });

  it("総枚数と内訳枚数が同じ商品を複数capacity扱いにしない", () => {
    const result = analyzeCapacityFromItemName(
      "HEIKO PP食パン袋 半斤用 300枚 (100枚×3束) 生ごみ 袋"
    );
    expect(result.capacity).toBe("300枚");
    expect(result.normalizedTotal).toEqual({ total: 300, unit: "枚" });
    expect(result.confidence).toBe("high");
  });
});

describe("isLikelySalesQuantityCapacityMisread", () => {
  it("商品名に液量・重量があるのに販売数量だけを抽出した場合は誤読扱いにする", () => {
    expect(
      isLikelySalesQuantityCapacityMisread(
        "いち髪 なめらかスムースケア シャンプー 大容量 1個 680g 2個分",
        "1個"
      )
    ).toBe(true);
  });

  it("商品名も抽出結果も販売数量のみなら誤読扱いにしない", () => {
    expect(
      isLikelySalesQuantityCapacityMisread("除菌スプレー 3個セット まとめ買い", "3個")
    ).toBe(false);
  });
});

describe("mergeExistingMeasureWithSalesQuantity", () => {
  it("既存capacityに同じ販売数量が含まれる場合はそのまま返す", () => {
    expect(mergeExistingMeasureWithSalesQuantity("420ml×10個", "10個")).toBe("420ml×10個");
  });

  it("既存の実容量を維持してAPI販売数量だけ更新する", () => {
    expect(mergeExistingMeasureWithSalesQuantity("420ml×10個", "12個")).toBe("420ml×12個");
  });

  it("販売数量の単位が違う場合は合成しない", () => {
    expect(mergeExistingMeasureWithSalesQuantity("420ml×10個", "12本")).toBeNull();
  });

  it("既存capacityに実容量がない場合は合成しない", () => {
    expect(mergeExistingMeasureWithSalesQuantity("10個", "12個")).toBeNull();
  });
});

describe("capacity kind helpers", () => {
  it("既存capacityの単品容量だけがAPI抽出された場合を判定する", () => {
    expect(isSameMeasureBaseWithExistingQuantity("355mL×12本", "355ml")).toBe(true);
    expect(isSameMeasureBaseWithExistingQuantity("500mL×6本", "500mL")).toBe(true);
    expect(isSameMeasureBaseWithExistingQuantity("355mL×12本", "360ml")).toBe(false);
    expect(isSameMeasureBaseWithExistingQuantity("355mL", "355ml")).toBe(false);
  });

  it("販売数量のみのcapacityを判定する", () => {
    expect(isSalesQuantityCapacity("10個")).toBe(true);
    expect(isSalesQuantityCapacity("12本")).toBe(true);
    expect(isSalesQuantityCapacity("420mL×10個")).toBe(false);
    expect(isSalesQuantityCapacity("420mL")).toBe(false);
  });

  it("実容量を含むcapacityを判定する", () => {
    expect(hasMeasureCapacity("420mL")).toBe(true);
    expect(hasMeasureCapacity("420mL×10個")).toBe(true);
    expect(hasMeasureCapacity("10個")).toBe(false);
    expect(hasMeasureCapacity("-")).toBe(false);
  });
});

describe("removeCapacityFromProductName", () => {
  it("商品名に埋め込まれた掛け算容量を削除する", () => {
    expect(
      removeCapacityFromProductName(
        "いち髪 なめらかスムースケア シャンプー 詰め替え 660mL×2個",
        "660mL×2個（約6ヶ月分）"
      )
    ).toBe("いち髪 なめらかスムースケア シャンプー 詰め替え");
  });

  it("商品名に容量がない場合はそのまま返す", () => {
    expect(removeCapacityFromProductName("シャンプー 詰め替え", "660mL")).toBe("シャンプー 詰め替え");
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

  it("3商品の中間 rank:2 を削除すると元 rank:3 が rank:2 に詰まる", () => {
    const three = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "商品A"
    price: 1000
    rakutenUrl: "https://example.com/a"
    imageUrl: "https://example.com/a.jpg"
  - rank: 2
    name: "商品B"
    price: 900
    rakutenUrl: "https://example.com/b"
    imageUrl: "https://example.com/b.jpg"
  - rank: 3
    name: "商品C"
    price: 800
    rakutenUrl: "https://example.com/c"
    imageUrl: "https://example.com/c.jpg"
---

本文テキスト。
`;
    const result = removeProductFromFrontmatter(three, "商品B");
    expect(result).not.toBeNull();
    expect(result).toContain('  - rank: 1');
    expect(result).toContain('"商品A"');
    expect(result).toContain('  - rank: 2');
    expect(result).toContain('"商品C"');
    expect(result).not.toContain('"商品B"');
    expect(result).not.toContain('  - rank: 3');
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

  it("pricePerUnit が不明な商品は有効な商品より下に並び替える", () => {
    const unknownPpuSample = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "単価不明商品"
    price: 1000
    capacity: "-"
    pricePerUnit: "-"
    rakutenUrl: "https://example.com/a"
  - rank: 2
    name: "単価あり商品"
    price: 500
    capacity: "100mL"
    pricePerUnit: "約5円/mL"
    rakutenUrl: "https://example.com/b"
---`;
    const result = reorderProductsByPricePerUnit(unknownPpuSample);
    expect(result.changed).toBe(true);
    expect(result.content).toMatch(/- rank: 1[\s\S]*?name: "単価あり商品"/);
    expect(result.content).toMatch(/- rank: 2[\s\S]*?name: "単価不明商品"/);
  });

  it("単位が混在する場合は同一単位グループ内で並び替える", () => {
    const mixedSample = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "mL高い商品"
    price: 1000
    capacity: "100mL"
    pricePerUnit: "約10円/mL"
    reviewCount: 10
    rakutenUrl: "https://example.com/a"
  - rank: 2
    name: "枚の商品"
    price: 300
    capacity: "100枚"
    pricePerUnit: "約3円/枚"
    reviewCount: 100
    rakutenUrl: "https://example.com/b"
  - rank: 3
    name: "mL安い商品"
    price: 500
    capacity: "100mL"
    pricePerUnit: "約5円/mL"
    reviewCount: 20
    rakutenUrl: "https://example.com/c"
---`;
    const result = reorderProductsByPricePerUnit(mixedSample);
    expect(result.changed).toBe(true);
    expect(result.content).toMatch(/- rank: 1[\s\S]*?name: "mL安い商品"/);
    expect(result.content).toMatch(/- rank: 2[\s\S]*?name: "mL高い商品"/);
    expect(result.content).toMatch(/- rank: 3[\s\S]*?name: "枚の商品"/);
  });

  it("換算できる単位は同一グループとしてコスパ比較する", () => {
    const convertibleSample = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "1L商品"
    price: 1200
    capacity: "1L"
    pricePerUnit: "約1200円/L"
    rakutenUrl: "https://example.com/a"
  - rank: 2
    name: "mL商品"
    price: 1500
    capacity: "1000mL"
    pricePerUnit: "約1.5円/mL"
    rakutenUrl: "https://example.com/b"
---`;
    const result = reorderProductsByPricePerUnit(convertibleSample);
    expect(result.changed).toBe(false);
  });

  it("グループ内商品数が多いグループを上位にする", () => {
    const groupSizeSample = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "枚商品"
    price: 100
    pricePerUnit: "約1円/枚"
    rakutenUrl: "https://example.com/a"
  - rank: 2
    name: "mL商品1"
    price: 300
    pricePerUnit: "約3円/mL"
    rakutenUrl: "https://example.com/b"
  - rank: 3
    name: "mL商品2"
    price: 200
    pricePerUnit: "約2円/mL"
    rakutenUrl: "https://example.com/c"
---`;
    const result = reorderProductsByPricePerUnit(groupSizeSample);
    expect(result.changed).toBe(true);
    expect(result.content).toMatch(/- rank: 1[\s\S]*?name: "mL商品2"/);
    expect(result.content).toMatch(/- rank: 2[\s\S]*?name: "mL商品1"/);
    expect(result.content).toMatch(/- rank: 3[\s\S]*?name: "枚商品"/);
  });

  it("グループ数が同じ場合はレビュー数、レビューが比較できない場合は次順位で比較する", () => {
    const reviewSample = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "mL1位"
    price: 100
    pricePerUnit: "約1円/mL"
    reviewCount: 1000
    rakutenUrl: "https://example.com/c"
  - rank: 2
    name: "mL2位"
    price: 200
    pricePerUnit: "約2円/mL"
    reviewCount: 100
    rakutenUrl: "https://example.com/d"
  - rank: 3
    name: "枚1位"
    price: 100
    pricePerUnit: "約1円/枚"
    rakutenUrl: "https://example.com/a"
  - rank: 4
    name: "枚2位"
    price: 200
    pricePerUnit: "約2円/枚"
    reviewCount: 500
    rakutenUrl: "https://example.com/b"
---`;
    const result = reorderProductsByPricePerUnit(reviewSample);
    expect(result.changed).toBe(true);
    expect(result.content).toMatch(/- rank: 1[\s\S]*?name: "枚1位"/);
    expect(result.content).toMatch(/- rank: 2[\s\S]*?name: "枚2位"/);
  });

  it("レビュー数で比較できない場合はグループ内1位商品の価格が安い順にする", () => {
    const priceSample = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "高い枚商品"
    price: 1000
    pricePerUnit: "約1円/枚"
    rakutenUrl: "https://example.com/a"
  - rank: 2
    name: "安いmL商品"
    price: 500
    pricePerUnit: "約1円/mL"
    rakutenUrl: "https://example.com/b"
---`;
    const result = reorderProductsByPricePerUnit(priceSample);
    expect(result.changed).toBe(true);
    expect(result.content).toMatch(/- rank: 1[\s\S]*?name: "安いmL商品"/);
  });

  it("商品が1件の場合はスキップ", () => {
    const result = reorderProductsByPricePerUnit(SINGLE_PRODUCT_FRONTMATTER);
    expect(result.changed).toBe(false);
  });
});

// ─── limitProductsByRank / syncTitleProductCount ──────────────────────────
describe("limitProductsByRank", () => {
  it("rank上限を超える商品を削除し、残りのrankを振り直す", () => {
    const content = `---
title: "おすすめ12選"
products:
  - rank: 1
    name: "商品1"
    rakutenUrl: "https://example.com/1"
  - rank: 2
    name: "商品2"
    rakutenUrl: "https://example.com/2"
  - rank: 11
    name: "商品11"
    rakutenUrl: "https://example.com/11"
  - rank: 12
    name: "商品12"
    rakutenUrl: "https://example.com/12"
---
本文
`;

    const result = limitProductsByRank(content, 10);

    expect(result.changed).toBe(true);
    expect(result.removed).toBe(2);
    expect(result.removedProducts).toEqual([
      {
        rank: 11,
        name: "商品11",
        capacity: null,
        reviewCount: null,
        rakutenUrl: "https://example.com/11",
      },
      {
        rank: 12,
        name: "商品12",
        capacity: null,
        reviewCount: null,
        rakutenUrl: "https://example.com/12",
      },
    ]);
    expect(result.content).toContain('name: "商品1"');
    expect(result.content).toContain('name: "商品2"');
    expect(result.content).not.toContain('name: "商品11"');
    expect(result.content).not.toContain('name: "商品12"');
    expect(result.content).toMatch(/- rank: 1[\s\S]*?name: "商品1"/);
    expect(result.content).toMatch(/- rank: 2[\s\S]*?name: "商品2"/);
    expect(result.log[0]).toContain("rank 11位以下を2件削除");
  });

  it("上限内の商品だけなら変更しない", () => {
    const result = limitProductsByRank(SAMPLE_FRONTMATTER, 10);
    expect(result.changed).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.content).toBe(SAMPLE_FRONTMATTER);
  });
});

describe("syncTitleProductCount", () => {
  it("titleのN選を実際の商品数に合わせる", () => {
    const content = `---
title: "歯磨き粉おすすめ4選"
products:
  - rank: 1
    name: "商品1"
  - rank: 2
    name: "商品2"
  - rank: 3
    name: "商品3"
---
本文
`;

    const result = syncTitleProductCount(content);

    expect(result.changed).toBe(true);
    expect(result.before).toBe("歯磨き粉おすすめ4選");
    expect(result.after).toBe("歯磨き粉おすすめ3選");
    expect(result.content).toContain('title: "歯磨き粉おすすめ3選"');
  });

  it("全角数字のN選も更新する", () => {
    const content = `---
title: "おすすめ８選"
products:
  - rank: 1
    name: "商品1"
  - rank: 2
    name: "商品2"
---
本文
`;

    const result = syncTitleProductCount(content);

    expect(result.changed).toBe(true);
    expect(result.after).toBe("おすすめ2選");
  });

  it("N選がないtitleは変更しない", () => {
    const result = syncTitleProductCount(SAMPLE_FRONTMATTER);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(SAMPLE_FRONTMATTER);
  });

  it("descriptionのN選も実際の商品数に合わせる", () => {
    const content = `---
title: "歯磨き粉おすすめ4選"
description: "人気4選を徹底比較"
products:
  - rank: 1
    name: "商品1"
  - rank: 2
    name: "商品2"
  - rank: 3
    name: "商品3"
---
本文
`;
    const result = syncTitleProductCount(content);

    expect(result.changed).toBe(true);
    expect(result.after).toBe("歯磨き粉おすすめ3選");
    expect(result.descAfter).toBe("人気3選を徹底比較");
    expect(result.content).toContain('description: "人気3選を徹底比較"');
  });

  it("descriptionにN選がなければdescriptionは変更しない", () => {
    const content = `---
title: "歯磨き粉おすすめ4選"
description: "コスパで選ぶ歯磨き粉ガイド"
products:
  - rank: 1
    name: "商品1"
  - rank: 2
    name: "商品2"
---
本文
`;
    const result = syncTitleProductCount(content);

    expect(result.changed).toBe(true);
    expect(result.after).toBe("歯磨き粉おすすめ2選");
    expect(result.descBefore).toBe(result.descAfter);
    expect(result.content).toContain('description: "コスパで選ぶ歯磨き粉ガイド"');
  });
});

// ─── updateUpdatedAt ──────────────────────────────────────────────────────
const UPDATED_AT_SAMPLE = `---
title: "テスト記事"
publishedAt: 2026-04-01
updatedAt: 2026-04-01
---
本文`;

describe("updateUpdatedAt", () => {
  it("既存の updatedAt を指定日付で置換する", () => {
    const result = updateUpdatedAt(UPDATED_AT_SAMPLE, "2026-05-06");
    expect(result).toContain("updatedAt: 2026-05-06");
    expect(result).not.toContain("updatedAt: 2026-04-01");
  });

  it("updatedAt がない場合は publishedAt の直後に挿入する", () => {
    const noUpdatedAt = UPDATED_AT_SAMPLE.replace("\nupdatedAt: 2026-04-01", "");
    const result = updateUpdatedAt(noUpdatedAt, "2026-05-06");
    expect(result).toContain("publishedAt: 2026-04-01\nupdatedAt: 2026-05-06");
  });

  it("publishedAt も updatedAt もない場合でも updatedAt を追加する", () => {
    const minimal = `---\ntitle: "テスト"\n---\n本文`;
    const result = updateUpdatedAt(minimal, "2026-05-06");
    expect(result).toContain("updatedAt: 2026-05-06");
  });

  it("本文部分は変更されない", () => {
    const result = updateUpdatedAt(UPDATED_AT_SAMPLE, "2026-05-06");
    expect(result).toContain("本文");
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

// ─── fixNameCapacityConflicts ─────────────────────────────────────────────

const CONFLICT_SAMPLE = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "ビオレ 素肌つるるんクレンジングウォーター 300mL"
    brand: "花王"
    price: 6263
    capacity: "290mL"
    rating: 4.4
    reviewCount: 800
    features:
      - "特徴1"
    pros:
      - "メリット1"
    cons:
      - "デメリット1"
    recommendedFor: "ライトメイクの方"
    rakutenUrl: "https://example.com/biore"
    imageUrl: "https://example.com/biore.jpg"
---
本文。
`;

describe("fixNameCapacityConflicts", () => {
  it("name の埋め込み容量が capacity と食い違う場合に capacity の値で置換する", () => {
    const result = fixNameCapacityConflicts(CONFLICT_SAMPLE);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"ビオレ 素肌つるるんクレンジングウォーター 290mL"');
    expect(result.content).not.toContain("300mL");
    expect(result.log).toHaveLength(1);
    expect(result.log[0]).toContain("rank 1");
    expect(result.log[0]).toContain("300mL");
    expect(result.log[0]).toContain("290mL");
  });

  it("name の埋め込み容量が capacity と完全一致する場合はスキップする", () => {
    const content = CONFLICT_SAMPLE.replace('capacity: "290mL"', 'capacity: "300mL"');
    const result = fixNameCapacityConflicts(content);
    expect(result.changed).toBe(false);
    expect(result.log).toHaveLength(0);
    expect(result.content).toBe(content);
  });

  it("name に埋め込まれた容量が × を含む複合表記の場合はスキップする", () => {
    const content = CONFLICT_SAMPLE
      .replace('"ビオレ 素肌つるるんクレンジングウォーター 300mL"', '"商品X 300mL×2個 詰め替えセット"');
    const result = fixNameCapacityConflicts(content);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
  });

  it("ティッシュの組数注釈つき箱数をnameへ重複追加しない", () => {
    const content = CONFLICT_SAMPLE
      .replace(
        '"ビオレ 素肌つるるんクレンジングウォーター 300mL"',
        '"エリエール ティシュー 200枚（100組）×12箱"'
      )
      .replace('capacity: "290mL"', 'capacity: "200枚（100組）×12箱"');

    const result = fixNameCapacityConflicts(content);

    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
  });

  it("name の埋め込み容量と capacity の単位が異なる場合はスキップする", () => {
    const content = CONFLICT_SAMPLE.replace('capacity: "290mL"', 'capacity: "290g"');
    const result = fixNameCapacityConflicts(content);
    expect(result.changed).toBe(false);
  });

  it("name と capacity の total が同じ場合はスキップする", () => {
    const content = CONFLICT_SAMPLE
      .replace('"ビオレ 素肌つるるんクレンジングウォーター 300mL"', '"商品Y 500g 詰め替え"')
      .replace('capacity: "290mL"', 'capacity: "500g"');
    const result = fixNameCapacityConflicts(content);
    expect(result.changed).toBe(false);
  });

  it("複数商品のうち食い違いがある商品だけを修正し他は変更しない", () => {
    const multi = `---
title: "テスト記事"
description: "テスト"
category: test
publishedAt: 2026-01-01
products:
  - rank: 1
    name: "商品A 300mL ローション"
    brand: "ブランドA"
    price: 1200
    capacity: "290mL"
    rating: 4.0
    reviewCount: 100
    features:
      - "特徴1"
    pros:
      - "メリット1"
    cons:
      - "デメリット1"
    recommendedFor: "テスト"
    rakutenUrl: "https://example.com/a"
    imageUrl: "https://example.com/a.jpg"
  - rank: 2
    name: "商品B 500g クリーム"
    brand: "ブランドB"
    price: 800
    capacity: "500g"
    rating: 4.0
    reviewCount: 100
    features:
      - "特徴2"
    pros:
      - "メリット2"
    cons:
      - "デメリット2"
    recommendedFor: "テスト"
    rakutenUrl: "https://example.com/b"
    imageUrl: "https://example.com/b.jpg"
---
本文。
`;
    const result = fixNameCapacityConflicts(multi);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"商品A 290mL ローション"');
    expect(result.content).toContain('"商品B 500g クリーム"');
    expect(result.log).toHaveLength(1);
    expect(result.log[0]).toContain("rank 1");
  });

  it("name に容量表記が含まれない場合はスキップする", () => {
    const content = CONFLICT_SAMPLE
      .replace('"ビオレ 素肌つるるんクレンジングウォーター 300mL"', '"シャンプー ナチュラル ハーブの香り"');
    const result = fixNameCapacityConflicts(content);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
  });
});

describe("analyzeCapacityFromItemName", () => {
  it("treats a single measurable capacity as high confidence", () => {
    const result = analyzeCapacityFromItemName("Sample 500mL");
    expect(result.capacity).toBe("500mL");
    expect(result.confidence).toBe("high");
    expect(result.shouldAutoUpdate).toBe(true);
  });

  it("treats a multiplier capacity as high confidence", () => {
    const result = analyzeCapacityFromItemName("Sample 400mL*3");
    expect(result.capacity).toBe("400mL×3");
    expect(result.confidence).toBe("high");
    expect(result.shouldAutoUpdate).toBe(true);
  });

  it("treats a simple count unit as high confidence", () => {
    const result = analyzeCapacityFromItemName("Sample 30枚");
    expect(result.capacity).toBe("30枚");
    expect(result.confidence).toBe("high");
    expect(result.shouldAutoUpdate).toBe(true);
  });

  it("treats multiple measurable capacities as low confidence", () => {
    const result = analyzeCapacityFromItemName("Sample 500mL 250mL 選べる");
    expect(result.confidence).toBe("low");
    expect(result.shouldAutoUpdate).toBe(false);
  });

  it("treats item names without parseable capacity as low confidence", () => {
    const result = analyzeCapacityFromItemName("Sample 本体+詰替");
    expect(result.capacity).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.shouldAutoUpdate).toBe(false);
  });
});

// ─── updateProductInFrontmatter - Yahoo offer 保持 ────────────────────────
describe("updateProductInFrontmatter - Yahoo offer 保持", () => {
  const CONTENT_WITH_YAHOO = `---
title: "テスト記事"
description: "説明"
category: test-category
publishedAt: 2026-04-01
products:
  - rank: 1
    name: "商品A"
    brand: "ブランドA"
    price: 5000
    capacity: "100m×60ロール"
    pricePerUnit: "約0.83円/m"
    features:
      - "特徴1"
    pros:
      - "メリット1"
    cons:
      - "デメリット1"
    recommendedFor: "テスト対象者"
    rakutenUrl: "https://hb.afl.rakuten.co.jp/example/"
    imageUrl: "https://example.com/image.jpg"
    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: 5100
        url: "https://store.shopping.yahoo.co.jp/example/item.html"
        available: true
        matchStatus: "matched"
        updatedAt: "2026-05-18"
---
本文
`;

  it("price 更新時に offers[] が保持される", () => {
    const updated = updateProductInFrontmatter(CONTENT_WITH_YAHOO, "商品A", {
      price: 4800,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
    });
    expect(updated).toContain('"yahoo"');
    expect(updated).toContain('"matched"');
    expect(updated).toContain("store.shopping.yahoo.co.jp");
  });

  it("imageUrl 更新時に offers[] が保持される", () => {
    const updated = updateProductInFrontmatter(CONTENT_WITH_YAHOO, "商品A", {
      price: null,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: "https://example.com/new-image.jpg",
    });
    expect(updated).toContain('"yahoo"');
    expect(updated).toContain("store.shopping.yahoo.co.jp");
    expect(updated).toContain("new-image.jpg");
  });

  it("newCapacity 更新時に offers[] が保持される", () => {
    const updated = updateProductInFrontmatter(CONTENT_WITH_YAHOO, "商品A", {
      price: null,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
      newCapacity: "100m×48ロール",
    });
    expect(updated).toContain('"yahoo"');
    expect(updated).toContain('"matched"');
    expect(updated).toContain("100m×48ロール");
  });
});
