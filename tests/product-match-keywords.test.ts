import { describe, expect, it } from "vitest";
import {
  buildProductMatchSearchKeywords,
  createCandidateSelector,
  extractQuantityToken,
  getCandidateSlotLimit,
  isGenericProductName,
  stripCapacityForKeyword,
  stripSizeAndCapacityForKeyword,
} from "../scripts/lib/product-match-keywords";

const MASK_CATEGORY_KEYWORDS = ["使い捨てマスク", "不織布マスク", "マスク 50枚"];

describe("stripCapacityForKeyword", () => {
  it("容量・入数以降を落とす", () => {
    expect(stripCapacityForKeyword("ジップロック ストックバッグ L 大容量 32枚入×3箱"))
      .toBe("ジップロック ストックバッグ L 大容量");
    expect(stripCapacityForKeyword("8x4 パウダースプレー 無香料 150g"))
      .toBe("8x4 パウダースプレー 無香料");
  });

  it("括弧内の補足を落とす", () => {
    expect(stripCapacityForKeyword("十六爽健麦茶 ティーバッグ（8g×24袋）"))
      .toBe("十六爽健麦茶 ティーバッグ");
  });
});

describe("stripSizeAndCapacityForKeyword", () => {
  it("サイズ訴求語も落とす", () => {
    expect(stripSizeAndCapacityForKeyword("ジップロック ストックバッグ L 大容量 32枚入×3箱"))
      .toBe("ジップロック ストックバッグ");
  });
});

describe("extractQuantityToken", () => {
  it("先頭の入数トークンを取り出す", () => {
    expect(extractQuantityToken("不織布プリーツマスク 300枚")).toBe("300枚");
    expect(extractQuantityToken("リセッシュ 詰替 680mL")).toBe("680mL");
    expect(extractQuantityToken("ペットシーツ 薄型 ダブルワイド 200枚 大容量")).toBe("200枚");
  });

  it("入数が無ければ null", () => {
    expect(extractQuantityToken("ナチュラルパフ コットンパフ セット")).toBeNull();
  });
});

describe("isGenericProductName", () => {
  it("ブランド名を含まない一般名を検出する", () => {
    expect(isGenericProductName("不織布プリーツマスク", MASK_CATEGORY_KEYWORDS)).toBe(true);
  });

  it("カテゴリ一般語と完全一致する名前は一般名とみなす", () => {
    expect(isGenericProductName("マスク 50枚", MASK_CATEGORY_KEYWORDS)).toBe(true);
  });

  it("ブランド名を持つ商品は一般名扱いしない", () => {
    expect(isGenericProductName("アイリスオーヤマ ナノエアーマスク ふつう", MASK_CATEGORY_KEYWORDS)).toBe(false);
  });

  it("ブランド名＋カテゴリ語の商品は部分一致で一般名扱いしない", () => {
    expect(isGenericProductName("ラックス スーパーリッチシャイン ダメージリペア コンディショナー", ["コンディショナー", "リンス"])).toBe(false);
    expect(isGenericProductName("パンパース おしりふき 肌へのいちばん", ["おしりふき"])).toBe(false);
  });
});

describe("buildProductMatchSearchKeywords", () => {
  it("一般名商品は入数・大容量つきキーワードをカテゴリ一般語より先に出す", () => {
    const keywords = buildProductMatchSearchKeywords({
      productName: "不織布プリーツマスク 300枚",
      baseKeyword: "不織布プリーツマスク",
      articleKeyword: "使い捨て不織布マスク",
      categoryKeywords: MASK_CATEGORY_KEYWORDS,
    });

    expect(keywords).toContain("不織布プリーツマスク 300枚");
    expect(keywords).toContain("不織布プリーツマスク 大容量");
    expect(keywords).toContain("不織布プリーツマスク まとめ買い");
    expect(keywords.indexOf("不織布プリーツマスク 300枚"))
      .toBeLessThan(keywords.indexOf("使い捨てマスク"));
  });

  it("ブランド名つき商品には入数ブースト語を足さない", () => {
    const keywords = buildProductMatchSearchKeywords({
      productName: "アイリスオーヤマ ナノエアーマスク ふつう 7枚",
      baseKeyword: "アイリスオーヤマ ナノエアーマスク ふつう",
      articleKeyword: "使い捨て不織布マスク",
      categoryKeywords: MASK_CATEGORY_KEYWORDS,
    });

    expect(keywords[0]).toBe("アイリスオーヤマ ナノエアーマスク ふつう");
    expect(keywords.some(keyword => keyword.endsWith("まとめ買い"))).toBe(false);
  });

  it("段階的に短縮したキーワードを含む", () => {
    const keywords = buildProductMatchSearchKeywords({
      productName: "ジップロック ストックバッグ L 大容量 32枚入×3箱",
      baseKeyword: "ジップロック ストックバッグ",
      categoryKeywords: [],
    });

    expect(keywords).toContain("ジップロック ストックバッグ L 大容量");
    expect(keywords).toContain("ジップロック ストックバッグ");
  });

  it("最大6件・重複なし・2文字未満を除外する", () => {
    const keywords = buildProductMatchSearchKeywords({
      productName: "不織布プリーツマスク 300枚",
      baseKeyword: "不織布プリーツマスク",
      articleKeyword: "使い捨て不織布マスク",
      categoryKeywords: MASK_CATEGORY_KEYWORDS,
    });

    expect(keywords.length).toBeLessThanOrEqual(6);
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(keywords.every(keyword => keyword.length >= 2)).toBe(true);
  });
});

describe("getCandidateSlotLimit", () => {
  it("先頭キーワードは後続用に枠を残す", () => {
    expect(getCandidateSlotLimit(0, 6, 10)).toBe(7);
  });

  it("2番目以降は上限まで使える", () => {
    expect(getCandidateSlotLimit(1, 6, 10)).toBe(10);
    expect(getCandidateSlotLimit(5, 6, 10)).toBe(10);
  });

  it("キーワードが1件だけなら制限しない", () => {
    expect(getCandidateSlotLimit(0, 1, 10)).toBe(10);
  });

  it("候補上限が小さくても1枠以上は残る", () => {
    expect(getCandidateSlotLimit(0, 3, 2)).toBe(1);
  });
});

describe("createCandidateSelector", () => {
  /** キーワードごとの検索結果を順に selector へ流す */
  function collect(resultsByKeyword: string[][], maxCandidates = 10): string[] {
    const selector = createCandidateSelector<string>(resultsByKeyword.length, maxCandidates);
    const seen = new Set<string>();
    resultsByKeyword.forEach((items, keywordIndex) => {
      if (selector.isFull()) return;
      for (const item of items) {
        if (seen.has(item)) continue;
        seen.add(item);
        selector.offer(item, keywordIndex);
      }
    });
    return selector.finish();
  }

  const primary = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"];

  it("後続キーワードに固有候補があれば枠を明け渡す", () => {
    const result = collect([primary, ["b1", "b2", "b3", "b4"], ["c1"]]);
    expect(result).toHaveLength(10);
    expect(result.slice(0, 7)).toEqual(primary.slice(0, 7));
    expect(result.slice(7)).toEqual(["b1", "b2", "b3"]);
  });

  it("後続キーワードが0件でも件数が減らない（見送り分で補充する）", () => {
    const result = collect([primary, [], []]);
    expect(result).toEqual(primary);
  });

  it("後続キーワードが全て重複でも件数が減らない", () => {
    const result = collect([primary, ["a1", "a2"], ["a3"]]);
    expect(result).toEqual(primary);
  });

  it("後続キーワードが確保枠を一部しか埋めない場合は残りを補充する", () => {
    const result = collect([primary, ["b1"], []]);
    expect(result).toHaveLength(10);
    expect(result).toContain("b1");
    expect(result.filter(item => item.startsWith("a"))).toHaveLength(9);
  });

  it("キーワードが1件だけなら枠を確保しない", () => {
    expect(collect([primary])).toEqual(primary);
  });

  it("候補が上限に満たない場合はそのまま返す", () => {
    expect(collect([["a1", "a2"], ["b1"]])).toEqual(["a1", "a2", "b1"]);
  });

  it("上限に達したら isFull が true になり以降の offer を無視する", () => {
    const selector = createCandidateSelector<string>(1, 2);
    selector.offer("a1", 0);
    selector.offer("a2", 0);
    expect(selector.isFull()).toBe(true);
    selector.offer("a3", 0);
    expect(selector.finish()).toEqual(["a1", "a2"]);
  });
});
