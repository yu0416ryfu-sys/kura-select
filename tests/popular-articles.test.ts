import { describe, it, expect } from "vitest";
import {
  normalizeArticleId,
  toArticleId,
  aggregatePageRows,
  normalizePolicy,
  filterEligible,
  selectPopularArticles,
  diffSelection,
  renderPopularArticlesFile,
  DEFAULT_POLICY,
  type ArticleStat,
  type GscPageRow,
} from "../scripts/lib/popular-articles.ts";

const BASE = "https://www.kura-select.com";

function pageRow(partial: Partial<GscPageRow> = {}): GscPageRow {
  return {
    page: `${BASE}/articles/wet-tissue-comparison/`,
    clicks: 1,
    impressions: 10,
    ctr: 0.1,
    position: 10,
    ...partial,
  };
}

function stat(id: string, partial: Partial<ArticleStat> = {}): ArticleStat {
  return { id, clicks: 1, impressions: 10, position: 10, ...partial };
}

describe("normalizeArticleId", () => {
  it("3経路（URL 由来・ファイルパス由来・手書き）が同一の id に収束する", () => {
    const fromUrl = normalizeArticleId("/articles/wet-tissue-comparison/");
    const fromPath = normalizeArticleId("wet-tissue-comparison.md");
    const fromPolicy = normalizeArticleId("  wet-tissue-comparison  ");
    expect(fromUrl).toBe("wet-tissue-comparison");
    expect(fromPath).toBe("wet-tissue-comparison");
    expect(fromPolicy).toBe("wet-tissue-comparison");
  });

  it("/articles/ 前置き・前後空白・.mdx・パーセントエンコードを吸収する", () => {
    expect(normalizeArticleId("articles/foo/")).toBe("foo");
    expect(normalizeArticleId(" foo.mdx ")).toBe("foo");
    expect(normalizeArticleId("/articles/%E3%81%82/")).toBe("あ");
  });

  it("大文字を小文字化しない", () => {
    expect(normalizeArticleId("Foo-Bar")).toBe("Foo-Bar");
  });

  it("Windows のパス区切り（\\）を / に変換する", () => {
    // 実在ファイル: src/content/articles/reviews/shampoo-pantene-damage-care-review.md
    expect(normalizeArticleId("reviews\\shampoo-pantene-damage-care-review.md")).toBe(
      "reviews/shampoo-pantene-damage-care-review",
    );
  });

  it("文字列以外は空文字になる", () => {
    expect(normalizeArticleId(null)).toBe("");
    expect(normalizeArticleId(undefined)).toBe("");
    expect(normalizeArticleId(42)).toBe("");
  });
});

describe("toArticleId", () => {
  it("空値は null", () => {
    expect(toArticleId("")).toBeNull();
    expect(toArticleId(null)).toBeNull();
    expect(toArticleId(undefined)).toBeNull();
  });

  it("末尾スラッシュ有無どちらも id を返す", () => {
    expect(toArticleId(`${BASE}/articles/wet-tissue-comparison/`)).toBe(
      "wet-tissue-comparison",
    );
    expect(toArticleId(`${BASE}/articles/diaper-pants-comparison`)).toBe(
      "diaper-pants-comparison",
    );
  });

  it("フラグメント付き URL でも本体の id を返す", () => {
    expect(
      toArticleId(
        `${BASE}/articles/frosch-vs-yashinomi-comparison/#%E7%B5%90%E8%AB%96`,
      ),
    ).toBe("frosch-vs-yashinomi-comparison");
  });

  it("サブディレクトリ配下の記事はスラッシュ込みの id になる", () => {
    expect(toArticleId(`${BASE}/articles/reviews/foo/`)).toBe("reviews/foo");
  });

  it("記事以外は null", () => {
    expect(toArticleId(`${BASE}/category/toilet-paper/`)).toBeNull();
    expect(toArticleId(`${BASE}/`)).toBeNull();
    expect(toArticleId(`${BASE}/about/`)).toBeNull();
  });

  it("URL としてパースできない文字列は null", () => {
    expect(toArticleId("not a url")).toBeNull();
  });
});

describe("aggregatePageRows", () => {
  it("フラグメント行と本体行が1件に合算される", () => {
    const stats = aggregatePageRows([
      pageRow({ page: `${BASE}/articles/foo/`, clicks: 3, impressions: 100, position: 10 }),
      pageRow({ page: `${BASE}/articles/foo/#x`, clicks: 2, impressions: 100, position: 20 }),
    ]);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.id).toBe("foo");
    expect(stats[0]!.clicks).toBe(5);
    expect(stats[0]!.impressions).toBe(200);
  });

  it("position は impressions 加重平均になる", () => {
    const stats = aggregatePageRows([
      pageRow({ page: `${BASE}/articles/foo/`, impressions: 90, position: 10 }),
      pageRow({ page: `${BASE}/articles/foo/`, impressions: 10, position: 20 }),
    ]);
    expect(stats[0]!.position).toBeCloseTo(11, 6);
  });

  it("impressions 合計が 0 なら position は null", () => {
    const stats = aggregatePageRows([
      pageRow({ page: `${BASE}/articles/foo/`, clicks: 0, impressions: 0, position: 0 }),
    ]);
    expect(stats[0]!.position).toBeNull();
  });

  it("記事以外の行は除外される", () => {
    const stats = aggregatePageRows([
      pageRow({ page: `${BASE}/category/rice/` }),
      pageRow({ page: `${BASE}/` }),
    ]);
    expect(stats).toHaveLength(0);
  });
});

describe("normalizePolicy", () => {
  it("空オブジェクトで DEFAULT_POLICY になる", () => {
    expect(normalizePolicy({})).toEqual(DEFAULT_POLICY);
  });

  it("部分指定はマージされる", () => {
    const policy = normalizePolicy({ slots: 4, spotlight: "foo-comparison" });
    expect(policy.slots).toBe(4);
    expect(policy.minClicks).toBe(DEFAULT_POLICY.minClicks);
    expect(policy.spotlight).toBe("foo-comparison");
  });

  it("slots が 0 以下なら既定に戻る", () => {
    expect(normalizePolicy({ slots: 0 }).slots).toBe(DEFAULT_POLICY.slots);
    expect(normalizePolicy({ slots: -3 }).slots).toBe(DEFAULT_POLICY.slots);
    expect(normalizePolicy({ slots: "abc" }).slots).toBe(DEFAULT_POLICY.slots);
  });

  it("配列要素と spotlight が normalizeArticleId を通っている", () => {
    const policy = normalizePolicy({
      pinned: ["/articles/foo/", " bar.md "],
      excluded: ["articles/baz"],
      spotlight: "/articles/qux/",
    });
    expect(policy.pinned).toEqual(["foo", "bar"]);
    expect(policy.excluded).toEqual(["baz"]);
    expect(policy.spotlight).toBe("qux");
  });

  it("spotlight が空なら null", () => {
    expect(normalizePolicy({ spotlight: "" }).spotlight).toBeNull();
    expect(normalizePolicy({ spotlight: null }).spotlight).toBeNull();
  });
});

describe("filterEligible", () => {
  const available = new Set(["a", "b", "c", "spot", "pin"]);

  it("excluded が落ちる", () => {
    const policy = normalizePolicy({ excluded: ["b"] });
    const { eligible, dropped } = filterEligible(
      [stat("a"), stat("b")],
      policy,
      available,
    );
    expect(eligible.map((s) => s.id)).toEqual(["a"]);
    expect(dropped).toContainEqual({ id: "b", reason: "excluded" });
  });

  it("availableIds に無い id が not-found で落ちる", () => {
    const { dropped } = filterEligible([stat("zzz")], normalizePolicy({}), available);
    expect(dropped).toContainEqual({ id: "zzz", reason: "not-found" });
  });

  it("minClicks 未満が below-min-clicks で落ちる", () => {
    const { eligible, dropped } = filterEligible(
      [stat("a", { clicks: 0 }), stat("b", { clicks: 1 })],
      normalizePolicy({ minClicks: 1 }),
      available,
    );
    expect(eligible.map((s) => s.id)).toEqual(["b"]);
    expect(dropped).toContainEqual({ id: "a", reason: "below-min-clicks" });
  });

  it("pinned は minClicks を免除される", () => {
    const policy = normalizePolicy({ minClicks: 5, pinned: ["pin"] });
    const { eligible } = filterEligible([stat("pin", { clicks: 0 })], policy, available);
    expect(eligible.map((s) => s.id)).toEqual(["pin"]);
  });

  it("spotlight は 0 クリックでも残る", () => {
    const policy = normalizePolicy({ minClicks: 1, spotlight: "spot" });
    const { eligible } = filterEligible([stat("spot", { clicks: 0 })], policy, available);
    expect(eligible.map((s) => s.id)).toEqual(["spot"]);
  });

  it("stats に行が無い pinned・spotlight が clicks 0 で補われる", () => {
    const policy = normalizePolicy({ pinned: ["pin"], spotlight: "spot" });
    const { eligible } = filterEligible([stat("a")], policy, available);
    const ids = eligible.map((s) => s.id).sort();
    expect(ids).toEqual(["a", "pin", "spot"]);
    const spot = eligible.find((s) => s.id === "spot")!;
    expect(spot.clicks).toBe(0);
    expect(spot.impressions).toBe(0);
    expect(spot.position).toBeNull();
  });

  it("stats に行が無く availableIds にも無い pinned は not-found で落ちる", () => {
    const policy = normalizePolicy({ pinned: ["ghost"] });
    const { eligible, dropped } = filterEligible([], policy, available);
    expect(eligible).toHaveLength(0);
    expect(dropped).toContainEqual({ id: "ghost", reason: "not-found" });
  });

  it("同じ id が excluded と pinned の両方にあるとき excluded が勝つ", () => {
    const policy = normalizePolicy({ pinned: ["a"], excluded: ["a"] });
    const { eligible, dropped } = filterEligible([stat("a")], policy, available);
    expect(eligible).toHaveLength(0);
    expect(dropped).toContainEqual({ id: "a", reason: "excluded" });
  });
});

describe("selectPopularArticles", () => {
  const available = new Set(["a", "b", "c", "d", "e", "f", "g", "spot", "pin"]);

  it("クリック降順に並ぶ", () => {
    const result = selectPopularArticles(
      [stat("a", { clicks: 1 }), stat("b", { clicks: 9 }), stat("c", { clicks: 5 })],
      normalizePolicy({}),
      available,
    );
    expect(result.ids).toEqual(["b", "c", "a"]);
  });

  it("pinned が先頭に来る", () => {
    const result = selectPopularArticles(
      [stat("a", { clicks: 9 }), stat("pin", { clicks: 1 })],
      normalizePolicy({ pinned: ["pin"] }),
      available,
    );
    expect(result.ids[0]).toBe("pin");
  });

  it("spotlight が末尾1枠に入る", () => {
    const result = selectPopularArticles(
      [
        stat("a", { clicks: 9 }),
        stat("b", { clicks: 8 }),
        stat("spot", { clicks: 0 }),
      ],
      normalizePolicy({ slots: 3, spotlight: "spot" }),
      available,
    );
    expect(result.ids).toEqual(["a", "b", "spot"]);
  });

  it("spotlight が実績上位でも重複しない", () => {
    const result = selectPopularArticles(
      [
        stat("spot", { clicks: 100 }),
        stat("a", { clicks: 9 }),
        stat("b", { clicks: 8 }),
      ],
      normalizePolicy({ slots: 3, spotlight: "spot" }),
      available,
    );
    expect(result.ids).toEqual(["a", "b", "spot"]);
    expect(new Set(result.ids).size).toBe(3);
  });

  it("spotlight が availableIds に無いときは無視され通常候補で埋まる", () => {
    const result = selectPopularArticles(
      [stat("a", { clicks: 9 }), stat("b", { clicks: 8 }), stat("c", { clicks: 7 })],
      normalizePolicy({ slots: 3, spotlight: "ghost" }),
      available,
    );
    expect(result.ids).toEqual(["a", "b", "c"]);
  });

  it("候補が slots に満たないとき shortfall が立つ", () => {
    const result = selectPopularArticles(
      [stat("a"), stat("b")],
      normalizePolicy({ slots: 6 }),
      available,
    );
    expect(result.ids).toHaveLength(2);
    expect(result.shortfall).toBe(4);
  });

  it("slots ちょうどなら shortfall は 0", () => {
    const result = selectPopularArticles(
      [stat("a"), stat("b")],
      normalizePolicy({ slots: 2 }),
      available,
    );
    expect(result.shortfall).toBe(0);
  });

  it("同着のタイブレークが id 昇順で決定的", () => {
    const rows = [stat("c"), stat("a"), stat("b")];
    const result = selectPopularArticles(rows, normalizePolicy({}), available);
    expect(result.ids).toEqual(["a", "b", "c"]);
    const reversed = selectPopularArticles([...rows].reverse(), normalizePolicy({}), available);
    expect(reversed.ids).toEqual(["a", "b", "c"]);
  });

  it("position が null の記事は同 clicks・同 impressions では最下位になる", () => {
    const result = selectPopularArticles(
      [
        stat("a", { clicks: 1, impressions: 0, position: null }),
        stat("b", { clicks: 1, impressions: 0, position: 5 }),
      ],
      normalizePolicy({}),
      available,
    );
    expect(result.ids).toEqual(["b", "a"]);
  });
});

describe("diffSelection", () => {
  it("入れ替わり件数を返す", () => {
    const diff = diffSelection(["a", "b", "c"], ["a", "x", "y"]);
    expect(diff.added).toEqual(["x", "y"]);
    expect(diff.removed).toEqual(["b", "c"]);
    expect(diff.changed).toBe(2);
  });

  it("全同一で 0", () => {
    expect(diffSelection(["a", "b"], ["b", "a"]).changed).toBe(0);
  });

  it("4件差を検出する", () => {
    const diff = diffSelection(
      ["a", "b", "c", "d", "e", "f"],
      ["a", "b", "w", "x", "y", "z"],
    );
    expect(diff.changed).toBe(4);
  });
});

describe("renderPopularArticlesFile", () => {
  const meta = {
    baselinePath: "reports/gsc-harvest/baseline-2026-09-07.json",
    startDate: "2026-08-10",
    endDate: "2026-09-04",
    generatedAt: "2026-09-12",
    policyPath: "data/popular-articles-policy.json",
  };

  it("as const で終わる", () => {
    const output = renderPopularArticlesFile(["foo", "bar"], meta);
    expect(output.trimEnd().endsWith("] as const;")).toBe(true);
  });

  it("id が二重引用符で囲まれる", () => {
    const output = renderPopularArticlesFile(["foo"], meta);
    expect(output).toContain('  "foo",');
  });

  it("出典コメントに baseline パスと窓が入る", () => {
    const output = renderPopularArticlesFile(["foo"], meta);
    expect(output).toContain("baseline-2026-09-07.json");
    expect(output).toContain("2026-08-10 〜 2026-09-04");
    expect(output).toContain("手で編集しないでください");
    expect(output).toContain("data/popular-articles-policy.json");
  });
});
