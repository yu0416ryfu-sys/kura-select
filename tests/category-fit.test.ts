import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  judgeProduct,
  judgeArticle,
  buildFitProducts,
  detectRuleMissing,
  classifyStage1Reason,
  summarize,
  type FitProduct,
} from "../scripts/lib/category-fit.ts";
import { getAdditionSearchRule } from "../scripts/lib/search-rules.ts";
import { toRakutenUrlKey } from "../scripts/lib/rakuten-url.ts";

/**
 * カテゴリ適合スキャン（低順位記事の底上げ Phase 1）のテスト。
 *
 * 中核は §4.8 の必須レグレッション: 是正前 `laundry-gel-ball` の誤商品が
 * 「記事別ルールあり」で全件 error になり、「記事別ルールなし」では大半が通過すること。
 * これが崩れると、§4.6 手順3（記事別ルールの追加）が必須である根拠が失われる。
 */

/** 是正前 laundry-gel-ball の実出品名。削除済み商品なので再取得できない（reports/ai-capacity-input-*.jsonl から復元） */
const GEL_BALL_BEFORE = [
  {
    key: "l-plus/7175761",
    recordedName: "さらさ 洗濯洗剤 詰め替え 6個セット",
    itemName:
      "【6個セット】 さらさ 洗濯洗剤 液体 詰め替え 超ジャンボ 1490g 衣料用洗剤 液体洗剤 しっかり洗浄 植物由来成分 赤ちゃん すすぎ1回 無添加 ペット 柑橘系の香り つめかえ用 P&G",
    expectedReason: "除外語: 液体洗剤",
  },
  {
    key: "k-home/7175761",
    recordedName: "さらさ 洗濯洗剤 詰め替え",
    itemName:
      "【6個】さらさ 洗剤 詰め替え 超ジャンボ 1490g 洗濯洗剤 液体 詰替 送料無料 衣料用洗剤 液体洗剤 しっかり洗浄 植物由来成分 赤ちゃん すすぎ1回 無添加 ペット 柑橘系の香り つめかえ用 P&G",
    expectedReason: "除外語: 液体洗剤",
  },
  {
    key: "k-home/7091429",
    recordedName: "緑の魔女 ランドリー 2個セット",
    itemName:
      "緑の魔女 ランドリー 5l 2個セット 緑の魔女 ランドリー 業務用 5L 5kg 洗濯洗剤 ミマスクリーンケア 送料無料 洗剤 5000mL 2本セット 液体洗剤 衣類用 大容量 洗濯機 パイプクリーナー 排水管 掃除",
    expectedReason: "除外語: 液体洗剤",
  },
  {
    key: "hibec/00000101",
    recordedName: "ハイベック プレミアムドライ",
    itemName:
      "【365日出荷対応】洗濯 洗剤 洗濯洗剤 ドライ洗剤 おしゃれ着洗剤 ハイベック プレミアムドライ 1100g 最強配送 おしゃれ 経済的 節約 エコ 無香料 高洗浄力 おしゃれ着洗い 液体洗剤 ドライクリーニング 衣類用洗剤 洗剤 おうちクリーニング 衣替え 洗濯 コート ダウン",
    expectedReason: "除外語: ドライ洗剤, おしゃれ着, 液体洗剤",
  },
  {
    key: "einverse-hokkaido/rjk-10",
    recordedName: "さらさ ジェルボール 詰め替え",
    itemName:
      "JK-0.5芯 サラサ3 サラサ4 サラサ2 よりどり選べる10本セット ジェル ボールペン替え芯 替芯 0.5mm 黒 赤 青 緑 RJK-BK RJK-BL RJK-R RJK-G ゼブラ SARASA3 ボールペン 芯 詰め替え 詰替",
    expectedReason: "除外語: ボールペン, 替芯",
  },
  {
    key: "lgo-2023/3931-000027",
    recordedName: "アタックZERO ワンパック 7個パック",
    itemName:
      "アタック どこでも袋でお洗たく 5L【＋ワンパックアタックZERO 合計10袋】 アタックゼロ アタック0 携帯 洗濯パック 携帯洗濯袋 洗濯 袋 アウトドア キャンプ 洗剤 携帯用 袋で洗濯 非常用 洗濯袋 旅行 トラベル 旅 洗濯セット 防災グッズ 避難所 災害時 洗濯機 災害グッズ",
    expectedReason: "必須語なし: ジェルボール",
  },
] as const;

/** 是正後の正商品（現 frontmatter にある実出品名）。NNB1 の反転を二度と起こさないため両方向を固定する */
const GEL_BALL_AFTER = [
  {
    recordedName: "ボールド ジェルボール 4D 詰め替え 大容量",
    itemName:
      "【大容量70個入！ 】ボールド ジェルボール 4D 華やかおひさまとプレミアムブロッサムの香り 詰め替え 洗濯洗剤 柔軟剤入り",
  },
  {
    recordedName: "ボールド ジェルボール 4in1 詰め替え",
    itemName: "ボールド 洗濯洗剤 ジェルボール 4in1 詰替(57個入) 部屋干し",
  },
] as const;

const GEL_BALL_BASE_KEYWORD = "ジェルボール洗剤おすすめ10選｜コスパ最強ランキング";

/** 楽天APIの候補は必ず価格を持つので、テストでも price を与えて素点を本番に揃える */
function candidate(itemName: string, recordedName: string): FitProduct {
  return {
    slug: "laundry-gel-ball",
    articleFile: "laundry-gel-ball-comparison.md",
    rank: null,
    currentName: recordedName,
    itemName,
    method: "[Item/Get]",
    price: 1000,
    reviewCount: 0,
    rating: 0,
  };
}

describe("category-fit: §4.8 必須レグレッション（是正前 gel-ball）", () => {
  const withArticleRule = getAdditionSearchRule("laundry-detergent", GEL_BALL_BASE_KEYWORD);
  // 記事別ルールが引かれない baseKeyword を渡すと CATEGORY_SEARCH_RULES['laundry-detergent'] に落ちる
  const categoryOnly = getAdditionSearchRule("laundry-detergent", "__記事別ルールなし__");

  it("記事別ルールありなら是正前の誤商品6件は全件 error（stage1）", () => {
    for (const product of GEL_BALL_BEFORE) {
      const finding = judgeProduct(candidate(product.itemName, product.recordedName), withArticleRule);
      expect(finding.severity, product.key).toBe("error");
      expect(finding.stage, product.key).toBe("stage1");
      expect(finding.reason, product.key).toBe(product.expectedReason);
    }
  });

  it("記事別ルールなし（カテゴリのみ）だと6件中5件が通過してしまう", () => {
    // §4.6 手順3（記事別ルールの追加）が必須である根拠。ここが崩れたら手順3 を省ける
    const passed = GEL_BALL_BEFORE.filter(
      product => judgeProduct(candidate(product.itemName, product.recordedName), categoryOnly).severity !== "error"
    );
    expect(passed.length).toBe(5);
    // 落ちる1件はボールペン（カテゴリ語が1つも当たらない）
    const rejected = GEL_BALL_BEFORE.filter(
      product => judgeProduct(candidate(product.itemName, product.recordedName), categoryOnly).severity === "error"
    );
    expect(rejected.map(r => r.key)).toEqual(["einverse-hokkaido/rjk-10"]);
    expect(
      judgeProduct(candidate(rejected[0].itemName, rejected[0].recordedName), categoryOnly).reason
    ).toBe("カテゴリ語なし");
  });

  it("是正後の正商品は記事別ルールありで error にならない（NNB1 の反転防止）", () => {
    for (const product of GEL_BALL_AFTER) {
      const finding = judgeProduct(candidate(product.itemName, product.recordedName), withArticleRule);
      expect(finding.severity, product.itemName).not.toBe("error");
    }
  });

  it("是正後 rank3 はカテゴリのみだと逆に error になる（記事別ルールは誤検知も抑えている）", () => {
    const rank3 = GEL_BALL_AFTER[0];
    const finding = judgeProduct(candidate(rank3.itemName, rank3.recordedName), categoryOnly);
    expect(finding.severity).toBe("error");
    expect(finding.reason).toContain("柔軟剤");
  });
});

describe("category-fit: 判定の段と重大度", () => {
  const rule = getAdditionSearchRule("laundry-detergent", GEL_BALL_BASE_KEYWORD);

  it("実出品名が無い商品は unknown（error でも ok でもない）", () => {
    const finding = judgeProduct(
      { ...candidate("", "アタック 詰め替え"), itemName: null, method: null },
      rule
    );
    expect(finding.code).toBe("unknown");
    expect(finding.severity).toBe("unknown");
  });

  it("method が [Item/Get] 以外なら name-mismatch（別商品の可能性）", () => {
    const finding = judgeProduct(
      { ...candidate("ボールド ジェルボール 4in1 詰替(57個入)", "ボールド ジェルボール 4in1 詰め替え"), method: "[Search]" },
      rule
    );
    expect(finding.code).toBe("name-mismatch");
    expect(finding.stage).toBe("name");
  });

  it("記事の商品名が実出品名と噛み合わなければ name-mismatch（商品名ドリフト）", () => {
    const finding = judgeProduct(
      candidate("ボールド ジェルボール 4in1 詰替(57個入) 部屋干し", "ムーニー おしりふき 詰め替え"),
      rule
    );
    expect(finding.code).toBe("name-mismatch");
  });

  it("stage2（unit-mismatch）は warn であって error ではない", () => {
    // 販促文字列から「365日」を容量として拾ってしまう既知の誤爆パターン
    const softener = getAdditionSearchRule("fabric-softener", "柔軟剤");
    const finding = judgeProduct(
      {
        ...candidate("【365日出荷】ソフラン アロマリッチ 柔軟剤 詰替", "ソフラン アロマリッチ 柔軟剤 詰替"),
        slug: "fabric-softener",
      },
      softener
    );
    expect(finding.code).toBe("unit-mismatch");
    expect(finding.severity).toBe("warn");
  });

  it("容量が抽出できない商品は stage2 で落とさない（capacity && ガード）", () => {
    const softener = getAdditionSearchRule("fabric-softener", "柔軟剤");
    const finding = judgeProduct(
      { ...candidate("ソフラン アロマリッチ 柔軟剤 詰替", "ソフラン アロマリッチ 柔軟剤 詰替"), slug: "fabric-softener" },
      softener
    );
    expect(finding.capacity).toBeNull();
    expect(finding.code).not.toBe("unit-mismatch");
    expect(finding.severity).not.toBe("error");
  });

  it("classifyStage1Reason が本番の reason 文言をコードに割り当てる", () => {
    expect(classifyStage1Reason("除外語: 液体洗剤")).toBe("excluded-term");
    expect(classifyStage1Reason("必須語なし: ジェルボール")).toBe("required-group-miss");
    expect(classifyStage1Reason("カテゴリ語なし")).toBe("no-include-hit");
    expect(classifyStage1Reason(null)).toBe("no-include-hit");
  });
});

describe("category-fit: 候補の組み立て", () => {
  const root = resolve(process.cwd(), "src/content/articles");
  const content = readFileSync(resolve(root, "cooling-pack-comparison.md"), "utf-8");

  it("price / rating を frontmatter から補う（extractAllProductsData は返さない）", () => {
    // ここが欠けると 価格あり +1 が付かず below-min-score が誤発火する（実測: 35件）
    const products = buildFitProducts(content, {
      slug: "cooling-pack",
      articleFile: "src/content/articles/cooling-pack-comparison.md",
      itemNames: new Map(),
    });
    expect(products.length).toBeGreaterThan(0);
    expect(products.some(p => typeof p.price === "number")).toBe(true);
    expect(products.some(p => typeof p.rating === "number")).toBe(true);
  });

  it("実出品名は toRakutenUrlKey で引く（キー生成が別実装だと全件 unknown になる）", () => {
    const bare = buildFitProducts(content, {
      slug: "cooling-pack",
      articleFile: "src/content/articles/cooling-pack-comparison.md",
      itemNames: new Map(),
    });
    expect(bare.every(p => p.itemName === null)).toBe(true);

    const first = bare[0];
    const key = toRakutenUrlKey(
      (readFileSync(resolve(root, "cooling-pack-comparison.md"), "utf-8").match(
        /rakutenUrl:\s*"([^"]+)"/
      ) ?? [])[1] ?? ""
    );
    expect(key).not.toBeNull();

    const withNames = buildFitProducts(content, {
      slug: "cooling-pack",
      articleFile: "src/content/articles/cooling-pack-comparison.md",
      itemNames: new Map([[key as string, { itemName: "テスト実出品名", method: "[Item/Get]" }]]),
    });
    const matched = withNames.filter(p => p.itemName !== null);
    expect(matched.length).toBe(1);
    expect(matched[0].rank).toBe(first.rank);
  });
});

describe("category-fit: ルール未定義の検出", () => {
  it("カテゴリ rule 自体が無ければ no-category-rule", () => {
    expect(detectRuleMissing("__存在しないカテゴリ__", "何か", 1)).toBe("no-category-rule");
  });

  it("兄弟とカテゴリを共有していて記事別 rule が無ければ shared-category-no-article-rule", () => {
    expect(detectRuleMissing("toothpaste", "歯ブラシ", 6)).toBe("shared-category-no-article-rule");
  });

  it("記事別 rule があれば未定義ではない", () => {
    expect(detectRuleMissing("laundry-detergent", GEL_BALL_BASE_KEYWORD, 5)).toBeNull();
    expect(detectRuleMissing("toothpaste", "歯磨き粉", 6)).toBeNull();
  });

  it("単独カテゴリで rule があれば未定義ではない", () => {
    expect(detectRuleMissing("acne-patch", "ニキビパッチ", 1)).toBeNull();
  });
});

describe("category-fit: 集計", () => {
  function article(slug: string, products: FitProduct[]) {
    return judgeArticle({
      slug,
      articleFile: `${slug}-comparison.md`,
      title: "ジェルボール洗剤おすすめ10選｜コスパ最強ランキング",
      category: "laundry-detergent",
      articlesInCategory: 5,
      products,
    });
  }

  it("unknown を error 率の分母から除く", () => {
    const products = [
      candidate(GEL_BALL_BEFORE[0].itemName, GEL_BALL_BEFORE[0].recordedName),
      { ...candidate("", "未集約商品"), itemName: null, method: null },
      { ...candidate("", "未集約商品2"), itemName: null, method: null },
    ];
    const result = article("laundry-gel-ball", products);
    expect(result.total).toBe(3);
    expect(result.unknown).toBe(2);
    expect(result.judged).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.errorRate).toBe(1);
  });

  it("判定できた商品が0本の記事は過半数 error に数えない", () => {
    const allUnknown = article("laundry-gel-ball", [
      { ...candidate("", "未集約商品"), itemName: null, method: null },
    ]);
    expect(allUnknown.errorRate).toBeNull();
    expect(summarize([allUnknown]).majorityErrorSlugs).toEqual([]);
  });

  it("summarize が判定コード別の件数を返す", () => {
    const result = article("laundry-gel-ball", GEL_BALL_BEFORE.map(p => candidate(p.itemName, p.recordedName)));
    const summary = summarize([result]);
    expect(summary.judged).toBe(6);
    expect(summary.errors).toBe(6);
    expect(summary.byCode.find(c => c.code === "excluded-term")?.count).toBe(5);
    expect(summary.byCode.find(c => c.code === "required-group-miss")?.count).toBe(1);
  });
});
