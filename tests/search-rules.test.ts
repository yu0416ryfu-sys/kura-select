import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";
import {
  CATEGORY_SEARCH_RULES,
  DEFAULT_EXCLUDE_TERMS,
  getArticleSpecificAdditionRule,
  getAdditionSearchRule,
  resolveArticleSearchRule,
  checkAdditionCandidateCategory,
  getAdditionCandidateDiagnostics,
  scoreAdditionCandidate,
  isAllowedCapacityUnit,
  findTermHits,
  findExcludeTermHits,
  findRequiredGroupHits,
  uniqueStrings,
} from "../scripts/lib/search-rules.ts";
import {
  extractAllProductsData,
  extractArticleTitle,
  extractArticleCategory,
  buildArticleSearchKeyword,
} from "../scripts/lib/frontmatter.ts";

/**
 * Phase 0.5（`search-rules.ts` の切り出し）の回帰テスト。
 *
 * 本番のガードは stage1（カテゴリ判定）/ stage2（単位）/ stage4（スコア）の
 * 段構成なので、段ごとにテストを置く。段が欠けたまま切り出す事故を防ぐ。
 */
describe("search-rules: ルール解決", () => {
  it("カテゴリ未定義でも baseKeyword から3件のキーワードを組み立てる", () => {
    const rule = getAdditionSearchRule("__unknown__", "トイレットペーパー");
    expect(rule.keywords).toEqual([
      "トイレットペーパー",
      "トイレットペーパー 大容量",
      "トイレットペーパー まとめ買い",
    ]);
    expect(rule.include).toEqual(["トイレットペーパー"]);
    expect(rule.minScore).toBe(4);
    expect(rule.requireInclude).toBe(true);
    expect(rule.requiredGroups).toEqual([]);
    expect(rule.units).toBeNull();
  });

  it("exclude には常に DEFAULT_EXCLUDE_TERMS が前置される", () => {
    const rule = getAdditionSearchRule("adult-diaper", "大人用紙おむつ");
    expect(rule.exclude.slice(0, DEFAULT_EXCLUDE_TERMS.length)).toEqual(DEFAULT_EXCLUDE_TERMS);
    expect(rule.exclude).toContain("ベビー");
  });

  it("記事別ルールがカテゴリルールより優先される", () => {
    const specific = getArticleSpecificAdditionRule("cooking-pot", "フライパン 26cm");
    expect(specific).not.toBeNull();
    const rule = getAdditionSearchRule("cooking-pot", "フライパン 26cm");
    expect(rule.keywords[0]).toBe("IH対応 フライパン 26cm");
    expect(getArticleSpecificAdditionRule("cooking-pot", "圧力鍋")).toBeNull();
  });

  it("キーワードは重複を除いて先頭3件に切り詰める", () => {
    expect(uniqueStrings([" a ", "a", "", null, "b"])).toEqual(["a", "b"]);
    const rule = getAdditionSearchRule("adult-diaper", "大人用紙おむつ");
    expect(rule.keywords).toHaveLength(3);
    expect(new Set(rule.keywords).size).toBe(3);
  });

  it("resolveArticleSearchRule は baseKeyword とルールを同じ規則で解決する", () => {
    const article = {
      title: "大人用紙おむつおすすめ10選",
      products: [{ name: "ダミー" }],
      file: "adult-diaper-comparison.md",
      category: "adult-diaper",
    };
    const resolved = resolveArticleSearchRule(article);
    const baseKeyword = buildArticleSearchKeyword(article.title);
    expect(resolved.baseKeyword).toBe(baseKeyword);
    expect(resolved.rule).toEqual(getAdditionSearchRule(article.category, baseKeyword));
  });

  it("title が無ければ先頭商品名 → ファイル名の順にフォールバックする", () => {
    expect(
      resolveArticleSearchRule({
        products: [{ name: "トイレットペーパー 12ロール" }],
        file: "x-comparison.md",
        category: "__unknown__",
      }).baseKeyword
    ).toBe(buildArticleSearchKeyword("トイレットペーパー 12ロール"));
    expect(
      resolveArticleSearchRule({ file: "x-comparison.md", category: "__unknown__" }).baseKeyword
    ).toBe(buildArticleSearchKeyword("x-comparison.md"));
  });
});

describe("search-rules: stage1 カテゴリ判定", () => {
  const rule = getAdditionSearchRule("adult-wipes", "大人用おしりふき");

  it("除外語が1つでもあれば reject する（減点ではなく二値）", () => {
    const result = checkAdditionCandidateCategory({ name: "赤ちゃん用おしりふき 80枚" }, rule);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("除外語");
  });

  it("必須語グループが1つでも空なら reject する", () => {
    const result = checkAdditionCandidateCategory({ name: "おしりふき 80枚" }, rule);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("必須語なし");
  });

  it("カテゴリ語が無ければ reject する（必須語グループを持たないルールで確認）", () => {
    const noGroupRule = getAdditionSearchRule("adult-diaper", "大人用紙おむつ");
    expect(noGroupRule.requiredGroups).toEqual([]);
    const result = checkAdditionCandidateCategory({ name: "ウェットティッシュ 100枚" }, noGroupRule);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("カテゴリ語なし");
  });

  it("条件を満たせば通す", () => {
    expect(checkAdditionCandidateCategory({ name: "大人用おしりふき 大判 厚手 100枚" }, rule)).toEqual({
      ok: true,
      reason: null,
    });
  });

  it("全角・大文字小文字は正規化して突き合わせる", () => {
    expect(findTermHits("ｉｈ対応フライパン".normalize("NFKC").toLowerCase(), ["IH対応"])).toEqual([
      "IH対応",
    ]);
    expect(findRequiredGroupHits("大人用おしりふき", [["大人用", "介護"], ["ベビー"]])).toEqual([
      { group: ["大人用", "介護"], hits: ["大人用"] },
      { group: ["ベビー"], hits: [] },
    ]);
  });
});

describe("search-rules: 除外語の部分一致例外", () => {
  const rule = getAdditionSearchRule("mosquito-repellent-liquid", "液体蚊取り");

  it("除外語マットはノーマットの一部としてだけ現れる場合ヒットにしない", () => {
    expect(findExcludeTermHits("ノーマット 取替えボトル 60日用", ["マット"])).toEqual([]);
    expect(
      checkAdditionCandidateCategory({ name: "ノーマット 取替えボトル 60日用 無香料" }, rule).ok
    ).toBe(true);
  });

  it("器具本体のベープマットは従来どおり除外される", () => {
    expect(findExcludeTermHits("ベープマット 30日用", ["マット"])).toEqual(["マット"]);
    expect(checkAdditionCandidateCategory({ name: "アース ベープマット 取替え用 30枚" }, rule).ok).toBe(
      false
    );
  });

  it("例外語と単独出現が混在する場合はヒットとして扱う", () => {
    expect(findExcludeTermHits("ノーマット と ベープマット のセット", ["マット"])).toEqual(["マット"]);
  });

  it("例外を持たない除外語の挙動は findTermHits と一致する", () => {
    const text = "赤ちゃん用おしりふき";
    expect(findExcludeTermHits(text, ["ベビー", "赤ちゃん"])).toEqual(
      findTermHits(text, ["ベビー", "赤ちゃん"])
    );
  });
});

/**
 * rank2 実地照合（2026-09-04）で excluded-term の誤検知になった7件の回帰テスト。
 *
 * 出品名はレポート（reports/rank1-audit/rank2-audit-2026-09-04.md）の実測値だが、
 * レポートは再生成で消えるためここに文字列定数として写してある。
 * 誤検知を消すのと同時に「本来弾きたいもの」を通していないことも必ず対で確認する。
 */
describe("search-rules: rank2 誤検知7件（2026-09-04）", () => {
  // 記事の title から実際に組み立てられる baseKeyword と同じ形を使う。
  const coffeeFilter = getAdditionSearchRule("coffee-filter", "コーヒーフィルター");
  const ballpointPen = getAdditionSearchRule("ballpoint-pen", "ボールペン");
  const conditioner = getAdditionSearchRule("conditioner", "コンディショナー");
  const acnePatch = getAdditionSearchRule("acne-patch", "ニキビパッチ");
  const gloves = getAdditionSearchRule("disposable-gloves", "使い捨て手袋");
  const toiletPaperDouble = getAdditionSearchRule("toilet-paper", "トイレットペーパー ダブル");
  const oxiclean = getAdditionSearchRule("laundry-detergent", "オキシクリーンと過炭酸ナトリウム");

  it("店名の一部の『豆』は誤検知にしないが、コーヒー豆商品は弾く", () => {
    expect(findExcludeTermHits("グルメコーヒー豆専門加藤珈琲店", ["豆"])).toEqual([]);
    // 例外は店名の形に限定してあるので、豆そのものの出品は従来どおり落ちる
    expect(findExcludeTermHits("スペシャルティ コーヒー豆 200g 中深煎り", ["豆"])).toEqual(["豆"]);
    expect(findExcludeTermHits("コーヒー豆専門店の豆 1kg", ["豆"])).toEqual(["豆"]);

    expect(
      checkAdditionCandidateCategory(
        {
          name: "V60用ペーパーフィルターみさらし100枚箱入りVCF-02-100MK（1〜4杯用）/ハリオ（HARIO）コーヒーフィルター/アイス珈琲/アイスコーヒー/グルメコーヒー豆専門加藤珈琲店",
        },
        coffeeFilter
      ).ok
    ).toBe(true);
  });

  it("メーカー名の一部の『鉛筆』は誤検知にしないが、鉛筆商品は弾く", () => {
    expect(findExcludeTermHits("名入れ 三菱鉛筆 ジェットストリーム", ["鉛筆"])).toEqual([]);
    expect(findExcludeTermHits("色鉛筆 12色 三菱鉛筆", ["鉛筆"])).toEqual(["鉛筆"]);

    expect(
      checkAdditionCandidateCategory(
        {
          name: "名入れ ジェットストリーム 4&1 メタルエディション 0.5mm ボールペン 多機能ペン 三菱鉛筆 名前入り プレゼント",
        },
        ballpointPen
      ).ok
    ).toBe(true);
  });

  it("『ケース販売』は誤検知にしないが、収納ケースは弾く", () => {
    expect(findExcludeTermHits("ケース販売(12ロール×6パック入)", ["ケース"])).toEqual([]);
    expect(findExcludeTermHits("トイレットペーパー 収納ケース", ["ケース"])).toEqual(["ケース"]);

    expect(
      checkAdditionCandidateCategory(
        { name: "ハロー トイレットペーパー ダブル 2倍巻き 50m ケース販売(12ロール×6パック入)【ハロー】" },
        toiletPaperDouble
      ).ok
    ).toBe(true);
  });

  it("conditioner の『セット』は数量表記のときだけ通す", () => {
    const exc = conditioner.excludeContextExceptions;
    expect(findExcludeTermHits("つめかえ用(1800ml×4セット)", ["セット"], exc)).toEqual([]);
    expect(findExcludeTermHits("コンディショナー 500ml×2セット", ["セット"], exc)).toEqual([]);
    // 数量文脈でない詰め合わせは従来どおり落ちる
    expect(findExcludeTermHits("シャンプーとの詰め合わせセット", ["セット"], exc)).toEqual(["セット"]);
    // 乗算記号のない「2本セット」は extractCapacityTotal が総量を取れず単価がズレるので、
    // あえて例外にしない（総量 500ml のまま計算されるのを防ぐ）
    expect(findExcludeTermHits("コンディショナー 500ml 2本セット", ["セット"], exc)).toEqual([
      "セット",
    ]);

    expect(
      checkAdditionCandidateCategory(
        { name: "メリット コンディショナー つめかえ用(1800ml×4セット)【メリット】" },
        conditioner
      ).ok
    ).toBe(true);
  });

  it("cooking-pot のフライパン分岐は『3点セット』を従来どおり弾く（非回帰）", () => {
    const frypan = getAdditionSearchRule("cooking-pot", "IH対応 フライパン 26cm");
    // 文脈例外を宣言していないルールなので、数量表記でもヒットする
    expect(frypan.excludeContextExceptions).toEqual({});
    expect(findExcludeTermHits("フライパン 3点セット", ["セット"])).toEqual(["セット"]);
    expect(
      checkAdditionCandidateCategory({ name: "IH対応 フライパン 26cm 3点セット" }, frypan).ok
    ).toBe(false);
  });

  it("acne-patch は売り文句の『韓国パック』を通し、フェイスパック商品は弾く", () => {
    expect(
      checkAdditionCandidateCategory(
        {
          name: "【3個】VT PRO CICA CLEAR SPOT PATCH 48粒 【正規品】ブイティ 公式 韓国パック スキンケア シカ ニキビ 肌荒れ 集中ケア パッチ スポットパッチ ニキビパッチ",
        },
        acnePatch
      ).ok
    ).toBe(true);
    expect(
      checkAdditionCandidateCategory({ name: "ニキビケア フェイスパック 30枚入り" }, acnePatch).ok
    ).toBe(false);
  });

  it("disposable-gloves は用途併記の『作業用手袋』を通し、革手袋は弾く", () => {
    expect(
      checkAdditionCandidateCategory(
        {
          name: "PVCグローブ 100枚 ×20箱 2000枚 まとめ買い 使い捨て手袋 厚手ビニール手袋 介護用手袋 作業用手袋 ビニール手袋 PVC手袋 パウダーフリー",
        },
        gloves
      ).ok
    ).toBe(true);
    expect(
      checkAdditionCandidateCategory({ name: "耐切創 作業用 革手袋 Lサイズ 1双" }, gloves).ok
    ).toBe(false);
  });

  it("oxiclean 記事は用途併記の『洗濯槽クリーナー』を通す", () => {
    expect(
      checkAdditionCandidateCategory(
        {
          name: "酸素系漂白剤 4.5kg 【送料無料】Oxygen bleach (過炭酸ナトリウム 100%) 洗濯槽クリーナー 洗濯 掃除に NICHIGA(ニチガ) TK1",
        },
        oxiclean
      ).ok
    ).toBe(true);
  });

  it("washing-machine-cleaner 側の『洗濯槽クリーナー』除外は残っている（非回帰）", () => {
    // laundry-net など他ルールの除外語まで消していないことを確認する
    const laundryNet = getAdditionSearchRule("laundry-net", "洗濯ネット");
    expect(laundryNet.exclude).toContain("洗濯槽クリーナー");
  });

  it("未宣言のルールの excludeContextExceptions は空オブジェクト", () => {
    expect(getAdditionSearchRule("__unknown__", "なにか").excludeContextExceptions).toEqual({});
    expect(coffeeFilter.excludeContextExceptions).toEqual({});
  });

  it("conditioner のルールだけが『セット』の文脈例外を持つ", () => {
    expect(Object.keys(conditioner.excludeContextExceptions)).toEqual(["セット"]);
  });
});

describe("search-rules: rank2・rank3 の「カテゴリ語なし」誤検知（2026-09-10）", () => {
  // 実出品名をそのまま使う（rank2-audit-2026-09-04 の apiName）
  it("hand-cream はユースキンAa の詰め替えパウチを通す", () => {
    const rule = getAdditionSearchRule("hand-cream", "ハンドクリーム");
    expect(
      checkAdditionCandidateCategory(
        { name: "【2個セット】【指定医薬部外品】 ユースキンAa ポンプつけかえパウチ 180g ユースキン製薬 カートリッジ 詰替え ( 4987353190618-2)" },
        rule
      ).ok
    ).toBe(true);
    // 'ユースキン' 単体は入れていない（ローション等を通さない）
    expect(checkAdditionCandidateCategory({ name: "ユースキン シソラ ローション 170mL" }, rule).ok).toBe(false);
  });

  it("kitchen-bleach はキッチンパワーブリーチを通し、ヘアブリーチは通さない", () => {
    const rule = getAdditionSearchRule("kitchen-bleach", "キッチン漂白剤");
    expect(
      checkAdditionCandidateCategory(
        { name: "ライオン キッチンパワーブリーチ 5kg 大容量 詰め替え 業務用 コック付き 注ぎ口付き つけ置き 除菌 漂白 除臭 食器 油汚れ ふきん 調理器具 雑菌 悪臭 LION ライオンハイジーン" },
        rule
      ).ok
    ).toBe(true);
    expect(checkAdditionCandidateCategory({ name: "ヘアブリーチ 脱色剤 セルフカラー" }, rule).ok).toBe(false);
  });

  it("washing-machine-cleaner / kitchen-bleach はコストコ版オキシクリーンを通す（記事が酸素系を比較対象にしている）", () => {
    const name =
      "《即納品》オキシクリーン除菌OK！当店計量スプーン付き★増量！5.26kg！★【送料無料】オキシクリーン　マルチパーパスクリーナー　OxiClean Multi Purpose Cleaner 11LB (oxi clean) コストコ通販";
    expect(checkAdditionCandidateCategory({ name }, getAdditionSearchRule("washing-machine-cleaner", "洗濯槽クリーナー")).ok).toBe(true);
    expect(checkAdditionCandidateCategory({ name }, getAdditionSearchRule("kitchen-bleach", "キッチン漂白剤")).ok).toBe(true);
    // kitchen-bleach の『洗濯』除外は残っている（洗濯用のオキシクリーンは弾く）
    expect(
      checkAdditionCandidateCategory({ name: "オキシクリーン 洗濯用 1500g" }, getAdditionSearchRule("kitchen-bleach", "キッチン漂白剤")).ok
    ).toBe(false);
  });

  it("kids-toothpaste（toothpaste カテゴリ）はチェックアップ コドモを通す", () => {
    const rule = getAdditionSearchRule("toothpaste", "子ども用歯磨き粉");
    expect(
      checkAdditionCandidateCategory(
        { name: "ライオン DENT. チェックアップコドモ 60g グレープ x 3本 【送料無料】【最安値挑戦中】【対象商品PT10倍開催中】" },
        rule
      ).ok
    ).toBe(true);
  });
});

describe("search-rules: rank3 のカテゴリ適合 error の誤検知（2026-09-11）", () => {
  // 実出品名をそのまま使う（rank3-audit-2026-09-10 の apiName）。どれも「弾きたいもの」を対で確認する
  it("insect-repellent は「殺虫成分不使用」の '殺虫' に反応しない", () => {
    const rule = getAdditionSearchRule("insect-repellent", "虫除けスプレー");
    expect(
      checkAdditionCandidateCategory(
        { name: "【公式】カメムシ 対策 寄せ付けない 虫除け 虫除けスプレー 家中どこでも虫キライスプレー 防カビ 消臭 ベランダ 玄関 窓 蚊 蚊よけ クモ コバエ アリ 忌避剤 室内 殺虫成分不使用 天然精油 天然由来 カビ対策" },
        rule
      ).ok
    ).toBe(true);
    expect(checkAdditionCandidateCategory({ name: "虫除け 殺虫スプレー 蚊 ハエ 450ml" }, rule).ok).toBe(false);
  });

  it("natural-cleaning は重曹の用途列挙の '歯磨き' を通し、重曹歯磨き粉は弾く", () => {
    const rule = getAdditionSearchRule("natural-cleaning", "重曹・セスキ炭酸ソーダ・クエン酸");
    expect(
      checkAdditionCandidateCategory(
        { name: "重曹 ベーキングソーダー 大容量 6.1kg 6キロ コストコ アームアンドハンマー 食用グレード アルミニウムフリー 重曹 食品添加物 歯磨き 掃除 洗濯 脱臭 消臭 製菓 環境にやさしい エコ eco アメリカ産 天然鉱石 ジップロックタイプ ベーキングパウダー 【4個まで1送料】" },
        rule
      ).ok
    ).toBe(true);
    expect(checkAdditionCandidateCategory({ name: "重曹 歯磨き粉 100g ホワイトニング" }, rule).ok).toBe(false);
  });

  it("bath-drain-hair-catcher は「排水口ホルダー」を通し、他のホルダーは弾く", () => {
    const rule = getAdditionSearchRule("bath-drain-hair-catcher", "浴室排水口ヘアキャッチャー");
    expect(
      checkAdditionCandidateCategory(
        { name: "ヘアーキャッチャー お風呂の排水口用 （ 排水口ホルダー ヘアー キャッチャー ミューファン 抗菌 日本製 排水口カバー ヘアーストッパー 髪の毛キャッチャー 排水溝 ゴミ受け ヌメリ防止 お手入れ簡単 ）" },
        rule
      ).ok
    ).toBe(true);
    expect(checkAdditionCandidateCategory({ name: "排水口 ゴミ受け 掃除用 スポンジホルダー" }, rule).ok).toBe(false);
  });

  it("father-day-gift は父の日を含む用途列挙を通し、母の日専用ギフトは弾く", () => {
    const rule = getAdditionSearchRule("gift", "父の日プレゼントランキング");
    expect(
      checkAdditionCandidateCategory(
        { name: "名入れ ボールペン [ラミー] サファリ 国内正規品 ギフトBOX付き LAMY safari ボール 父の日 母の日 入学祝 就職祝 卒業記念 成人祝 プレゼント クリスマス 高級 筆記具 記念品 誕生日 名入り 名前入り 名入れペン 成人式" },
        rule
      ).ok
    ).toBe(true);
    expect(checkAdditionCandidateCategory({ name: "母の日 プレゼント カーネーション ギフト" }, rule).ok).toBe(false);
    expect(checkAdditionCandidateCategory({ name: "クリスマス ギフト セット" }, rule).ok).toBe(false);
  });

  it("body-lotion はビオレu お風呂で使ううるおいミルクを通す", () => {
    const rule = getAdditionSearchRule("body-lotion", "ボディローション");
    expect(checkAdditionCandidateCategory({ name: "ビオレu お風呂で使ううるおいミルク 無香料 300ml" }, rule).ok).toBe(true);
    expect(checkAdditionCandidateCategory({ name: "うるおいミルク 洗顔 150ml" }, rule).ok).toBe(false);
  });

  it("room-deodorizer（mukokukan-vs-shoshuriki）は無香空間を通す", () => {
    const rule = getAdditionSearchRule("room-deodorizer", "無香空間と消臭力どっちがいい？");
    expect(checkAdditionCandidateCategory({ name: "無香空間 本体 315g 小林製薬" }, rule).ok).toBe(true);
    expect(checkAdditionCandidateCategory({ name: "無香空間 車用 ゲル" }, rule).ok).toBe(false);
  });
});

describe("search-rules: stage2 単位判定", () => {
  const rule = getAdditionSearchRule("adult-diaper", "大人用紙おむつ");

  it("units が未指定のルールは常に通す", () => {
    const noUnits = getAdditionSearchRule("__unknown__", "簡易トイレ");
    expect(noUnits.units).toBeNull();
    expect(isAllowedCapacityUnit("100回分", noUnits)).toBe(true);
  });

  it("単位が一致すれば通し、違えば落とす", () => {
    expect(isAllowedCapacityUnit("22枚", rule)).toBe(true);
    expect(isAllowedCapacityUnit("1.5L", rule)).toBe(false);
  });

  it("容量を解釈できなければ落とす", () => {
    expect(isAllowedCapacityUnit("-", rule)).toBe(false);
  });
});

describe("search-rules: stage4 スコア", () => {
  const rule = getAdditionSearchRule("adult-wipes", "大人用おしりふき");
  const base = { name: "大人用おしりふき 大判 厚手 100枚", price: 980, reviewCount: 0, rating: 0 };

  it("カテゴリ語・必須語・価格を加点する", () => {
    const { score, reasons } = scoreAdditionCandidate(base, rule);
    // カテゴリ語 2件で 3+1 / 必須語 2 / 価格 1
    expect(score).toBe(7);
    expect(reasons).toContain("価格あり");
  });

  it("除外語は1語につき -4 する", () => {
    const withExclude = scoreAdditionCandidate({ ...base, name: `${base.name} ベビー` }, rule);
    expect(withExclude.score).toBe(scoreAdditionCandidate(base, rule).score - 4);
  });

  it("レビュー件数と評価の刻みで加点する", () => {
    const at = (reviewCount: number, rating: number) =>
      scoreAdditionCandidate({ ...base, reviewCount, rating }, rule).score;
    const zero = at(0, 0);
    expect(at(49, 3.9)).toBe(zero);
    expect(at(50, 4.0)).toBe(zero + 2);
    expect(at(300, 4.5)).toBe(zero + 4);
    expect(at(1000, 4.9)).toBe(zero + 5);
  });

  it("price が null なら価格の加点をしない", () => {
    expect(scoreAdditionCandidate({ ...base, price: null }, rule).score).toBe(
      scoreAdditionCandidate(base, rule).score - 1
    );
  });

  it("診断はスコアと同じヒット集合を返す", () => {
    const diagnostics = getAdditionCandidateDiagnostics(base, rule);
    expect(diagnostics.includeHits.length).toBeGreaterThan(0);
    expect(diagnostics.excludeHits).toEqual([]);
    expect(diagnostics.requiredGroupHits.every(g => g.hits.length > 0)).toBe(true);
  });
});

describe("search-rules: 全記事に対する解決（スモーク）", () => {
  const dir = resolve(process.cwd(), "src/content/articles");
  const files = readdirSync(dir).filter(f => f.endsWith("-comparison.md")).sort();

  it("全 comparison 記事でルールが解決でき、キーワードが空にならない", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      const products = extractAllProductsData(content);
      const { baseKeyword, rule } = resolveArticleSearchRule({
        title: extractArticleTitle(content),
        products,
        file,
        category: extractArticleCategory(content) ?? "",
      });
      expect(baseKeyword, file).not.toBe("");
      expect(rule.keywords.length, file).toBeGreaterThan(0);
      expect(rule.keywords.every(k => k.trim().length > 0), file).toBe(true);
      expect(rule.include.length, file).toBeGreaterThan(0);
      expect(rule.minScore, file).toBeGreaterThan(0);
    }
  });

  it("CATEGORY_SEARCH_RULES の include と exclude が同じ語を持たない", () => {
    for (const [category, rule] of Object.entries(CATEGORY_SEARCH_RULES)) {
      const include = new Set(rule.include ?? []);
      const collided = (rule.exclude ?? []).filter(term => include.has(term));
      expect(collided, category).toEqual([]);
    }
  });
});

/**
 * 優先24本への記事別ルール追加＋include 補強（2026-08-27）の回帰テスト。
 *
 * 目的は Phase 1（`check-category-fit`）の前提条件を固定すること。
 * ルールが無い / 兄弟記事の主題に寄っていると、記事が自分の商品を
 * stage1 で「カテゴリ語なし」に落とすため、スキャンが誤検知だらけになる。
 */
describe("search-rules: 優先24本のルール（2026-08-27 追加）", () => {
  const dir = resolve(process.cwd(), "src/content/articles");

  /** 記事の既存商品を本番と同じ順（stage1 → stage2 → stage4）で判定する */
  function judgeArticleProducts(slug: string) {
    const content = readFileSync(join(dir, `${slug}-comparison.md`), "utf-8");
    const products = extractAllProductsData(content);
    const { rule } = resolveArticleSearchRule({
      title: extractArticleTitle(content),
      products,
      file: `${slug}-comparison.md`,
      category: extractArticleCategory(content) ?? "",
    });
    return products.map(product => {
      const category = checkAdditionCandidateCategory({ name: product.name }, rule);
      if (!category.ok) return { name: product.name, verdict: "error", reason: category.reason };
      const score = scoreAdditionCandidate({ name: product.name }, rule);
      if (score.score < rule.minScore) return { name: product.name, verdict: "error", reason: `score ${score.score}` };
      return { name: product.name, verdict: "ok", reason: null };
    });
  }

  // ルールが無く include が空だったため、stage1 が全商品を落としていた13カテゴリ
  const RULE_ADDED_CATEGORIES = [
    "acne-patch", "baby-wipes", "bath-mat", "body-lotion", "cat-food", "cat-litter",
    "cooling-pack", "cotton-swab", "hair-color", "hair-oil", "insect-repellent",
    "mineral-water", "razor",
  ];

  it.each(RULE_ADDED_CATEGORIES)("%s にカテゴリルールがあり include が空でない", category => {
    const rule = CATEGORY_SEARCH_RULES[category];
    expect(rule, category).toBeDefined();
    expect((rule?.include ?? []).length, category).toBeGreaterThan(0);
    expect((rule?.keywords ?? []).length, category).toBe(3);
  });

  // 兄弟記事とカテゴリを共有していて、カテゴリ rule が兄弟の主題に寄っていた記事
  const ARTICLE_RULE_SLUGS: [string, string][] = [
    ["fabric-softener", "柔軟剤"],
    ["laundry-detergent", "洗濯洗剤"],
    ["room-dry-detergent", "部屋干し洗剤"],
    ["oxiclean-vs-percarbonate", "オキシクリーンと過炭酸ナトリウムを徹底比較"],
    ["room-deodorizer", "消臭剤"],
    ["sanitizing-spray", "除菌スプレー"],
    ["tissue-paper", "ティッシュペーパー"],
    ["toilet-cleaner", "トイレ用洗剤"],
    ["toothpaste", "歯磨き粉"],
    ["wrap-foil", "ラップ・アルミホイル"],
  ];

  it.each(ARTICLE_RULE_SLUGS)("%s は記事別ルールに解決される", (slug, baseKeyword) => {
    const content = readFileSync(join(dir, `${slug}-comparison.md`), "utf-8");
    const category = extractArticleCategory(content) ?? "";
    expect(buildArticleSearchKeyword(extractArticleTitle(content)), slug).toBe(baseKeyword);
    expect(getArticleSpecificAdditionRule(category, baseKeyword), slug).not.toBeNull();
  });

  it("兄弟記事の個別ルールを新ルールが横取りしない", () => {
    // 上で先に return される兄弟。ここが崩れると兄弟記事の候補生成が壊れる
    const siblings: [string, string, string][] = [
      ["fabric-softener", "敏感肌・赤ちゃん向け柔軟剤", "無添加"],
      ["laundry-detergent", "衣料用漂白剤", "漂白剤"],
      ["toothpaste", "デンタルフロス", "フロス"],
      ["toothpaste", "歯間ブラシ", "歯間ブラシ"],
      ["toilet-cleaner", "トイレ掃除シート", "トイレ掃除"],
      ["wrap-foil", "保存袋・フリーザーバッグ", "フリーザーバッグ"],
    ];
    for (const [category, baseKeyword, expectedInclude] of siblings) {
      const rule = getArticleSpecificAdditionRule(category, baseKeyword);
      expect(rule, baseKeyword).not.toBeNull();
      expect(rule?.include ?? [], baseKeyword).toContain(expectedInclude);
    }
  });

  it("子ども用歯磨き粉は歯磨き粉ルールに巻き込まれない", () => {
    expect(getArticleSpecificAdditionRule("toothpaste", "子ども用歯磨き粉")).toBeNull();
  });

  // 24本のうち、自記事の商品が1件も stage1/stage4 に落ちない22本。
  // 残る2本（bathroom-cleaner / toothpaste）は下で「意図した検出」として固定する
  const CLEAN_SLUGS = [
    "fabric-softener", "ih-single-pot", "laundry-detergent", "oxiclean-vs-percarbonate",
    "room-deodorizer", "room-dry-detergent", "sanitizing-spray", "tissue-paper",
    "toilet-cleaner", "wrap-foil",
    "acne-patch", "baby-wipes", "bath-mat", "cat-litter", "cotton-swab",
    "hair-color", "mineral-water",
  ];

  it.each(CLEAN_SLUGS)("%s は自記事の商品が stage1/stage4 に落ちない", slug => {
    const errors = judgeArticleProducts(slug).filter(row => row.verdict === "error");
    expect(errors.map(row => `${row.name} (${row.reason})`), slug).toEqual([]);
  });

  it("bathroom-cleaner の include 補強で風呂釜・バスタブ・湯アカが通る", () => {
    const rule = getAdditionSearchRule("bathroom-cleaner", "お風呂用洗剤");
    for (const name of [
      "ライオン おふろのルック つめかえ用 350ml",
      "ルックプラス バスタブクレンジング 銀イオンプラス 詰替 800mL",
      "リンレイ 速攻湯アカ分解 3点セット",
      "エコメイト 風呂釜クリーナー 6個セット",
    ]) {
      expect(checkAdditionCandidateCategory({ name }, rule).ok, name).toBe(true);
    }
    // exclude は触っていないので、トイレ用・キッチン用は従来どおり落ちる
    expect(checkAdditionCandidateCategory({ name: "トイレ用洗剤 500ml" }, rule).ok).toBe(false);
  });

  it("歯磨き粉ルールは兄弟記事の主題（歯ブラシ・フロス）を混入として弾く", () => {
    const rule = getAdditionSearchRule("toothpaste", "歯磨き粉");
    expect(checkAdditionCandidateCategory({ name: "システマ ハグキプラス プレミアム 95g×4本セット" }, rule).ok).toBe(true);
    expect(checkAdditionCandidateCategory({ name: "歯ブラシ まとめ買い 大人 おとな用歯ブラシアソート" }, rule).ok).toBe(false);
    expect(checkAdditionCandidateCategory({ name: "デンタルフロス 50m" }, rule).ok).toBe(false);
  });

  it("オキシクリーン記事は主題である酸素系漂白剤を除外語で落とさない", () => {
    const rule = getAdditionSearchRule("laundry-detergent", "オキシクリーンと過炭酸ナトリウムを徹底比較");
    expect(rule.exclude).not.toContain("漂白剤");
    expect(checkAdditionCandidateCategory({ name: "NICHIGA 酸素系漂白剤 過炭酸ナトリウム 3kg" }, rule).ok).toBe(true);
    // 兄弟の laundry-bleach 側は従来どおり '漂白剤' を主題語として持つ
    const bleach = getAdditionSearchRule("laundry-detergent", "衣料用漂白剤");
    expect(bleach.include).toContain("漂白剤");
  });

  it("ラップ記事はケース販売のまとめ買い出品を落とさない", () => {
    const rule = getAdditionSearchRule("wrap-foil", "ラップ・アルミホイル");
    expect(checkAdditionCandidateCategory({ name: "【ケース販売】サランラップ 業務用 BOXタイプ 30cm×50m" }, rule).ok).toBe(true);
    // 'ケースのみ' は DEFAULT_EXCLUDE_TERMS 側で担保される
    expect(rule.exclude).toContain("ケースのみ");
    expect(checkAdditionCandidateCategory({ name: "ラップホルダー ケースのみ" }, rule).ok).toBe(false);
  });

  it("まとめ買い出品が stage2（単位）で落ちない", () => {
    // units を新設した13カテゴリで「3本」「2個」等が容量として抽出されるケース
    const cases: [string, string, string][] = [
      ["body-lotion", "ボディローション", "3本"],
      ["cotton-swab", "綿棒", "3個"],
      ["hair-color", "白髪染め", "2個"],
    ];
    for (const [category, baseKeyword, capacity] of cases) {
      const rule = getAdditionSearchRule(category, baseKeyword);
      expect(isAllowedCapacityUnit(capacity, rule), `${category}/${capacity}`).toBe(true);
    }
  });
});
