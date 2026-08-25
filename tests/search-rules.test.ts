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
