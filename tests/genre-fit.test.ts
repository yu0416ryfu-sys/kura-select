import { describe, it, expect } from "vitest";
import {
  CONTAMINATION_MAX_RATIO,
  tallyGenres,
  proposeExpectedGenres,
  normalizePolicy,
  judgeArticleGenres,
  summarizeGenreFit,
  formatGenreFitReport,
  type GenreProduct,
  type ArticleGenreFit,
} from "../scripts/lib/genre-fit";

/** genreId の並びから商品配列を組み立てる（rank は 1 始まり） */
function products(genreIds: Array<string | null>): GenreProduct[] {
  return genreIds.map((genreId, index) => ({
    rank: index + 1,
    name: `商品${index + 1}`,
    genreId,
  }));
}

function judge(genreIds: Array<string | null>, expected: string[] | null, heldUntil: string | null = null) {
  return judgeArticleGenres({
    slug: "test",
    products: products(genreIds),
    policy: expected === null ? null : { expected },
    heldUntil,
  });
}

describe("tallyGenres", () => {
  // G1
  it("件数降順で返す", () => {
    expect(tallyGenres(products(["a", "b", "a", "c", "a", "b"]))).toEqual([
      { genreId: "a", count: 3 },
      { genreId: "b", count: 2 },
      { genreId: "c", count: 1 },
    ]);
  });

  // G2
  it("全件 null なら空配列", () => {
    expect(tallyGenres(products([null, null]))).toEqual([]);
  });
});

describe("proposeExpectedGenres", () => {
  // G3
  it("8:2 に割れたら多数派のみ返す", () => {
    const genreIds = [...Array(8).fill("216044"), "205838", "550088"];
    expect(proposeExpectedGenres(products(genreIds))).toEqual(["216044"]);
  });

  it("同数なら全部返す", () => {
    expect(proposeExpectedGenres(products(["a", "b"]))).toEqual(["a", "b"]);
  });
});

describe("judgeArticleGenres", () => {
  // G4: 実測 garbage-bag
  it("garbage-bag は contamination（外れ2/10）", () => {
    const result = judge([...Array(8).fill("216044"), "205838", "550088"], ["216044"]);
    expect(result.code).toBe("contamination");
    expect(result.outliers).toBe(2);
    expect(result.outlierRatio).toBeCloseTo(0.2);
    expect(result.findings.filter(f => f.isOutlier).map(f => f.genreId)).toEqual(["205838", "550088"]);
  });

  // G5: 実測 diaper-tape-m
  it("diaper-tape-m は clean", () => {
    const result = judge(["205198", "205198", "205198"], ["205198"]);
    expect(result.code).toBe("clean");
    expect(result.outliers).toBe(0);
  });

  // G6: 実測 interdental-brush（多数決に引きずられない）
  it("interdental-brush は design-review", () => {
    const genreIds = [...Array(5).fill("208218"), "204758", "204758", "506385", "201528"];
    const result = judge(genreIds, ["204758"]);
    expect(result.code).toBe("design-review");
    expect(result.outliers).toBe(7);
  });

  // G7
  it("policy が null なら unconfigured で提案値が入る", () => {
    const result = judge(["216044", "216044", "205838"], null);
    expect(result.code).toBe("unconfigured");
    expect(result.proposedExpected).toEqual(["216044"]);
    expect(result.outliers).toBe(0);
  });

  // G8
  it("全商品 genreId=null なら no-data / outlierRatio は null", () => {
    const result = judge([null, null], ["216044"]);
    expect(result.code).toBe("no-data");
    expect(result.outlierRatio).toBeNull();
    expect(result.withGenre).toBe(0);
    expect(result.total).toBe(2);
  });

  // G9
  it("分母は withGenre であって total ではない", () => {
    const result = judge(["216044", "216044", "216044", "205838", null, null], ["216044"]);
    expect(result.total).toBe(6);
    expect(result.withGenre).toBe(4);
    expect(result.outlierRatio).toBeCloseTo(0.25);
    expect(result.code).toBe("contamination");
  });

  // G10
  it("expected が複数なら両方とも外れにならない", () => {
    const result = judge(["a", "a", "b", "b"], ["a", "b"]);
    expect(result.code).toBe("clean");
    expect(result.outliers).toBe(0);
  });

  // G11
  it("heldUntil は結果に載るが code は変えない", () => {
    const genreIds = [...Array(8).fill("216044"), "205838", "550088"];
    const held = judge(genreIds, ["216044"], "2026-09-12");
    expect(held.heldUntil).toBe("2026-09-12");
    expect(held.code).toBe("contamination");
    expect(judge(genreIds, ["216044"], null).code).toBe(held.code);
  });

  // G12
  it("外れ率ちょうど 0.25 は contamination（境界を含む）", () => {
    const result = judge(["a", "a", "a", "b"], ["a"]);
    expect(result.outlierRatio).toBe(CONTAMINATION_MAX_RATIO);
    expect(result.code).toBe("contamination");

    // 境界を1件超えると design-review
    expect(judge(["a", "a", "b", "b"], ["a"]).code).toBe("design-review");
  });

  // G15: 両辺の正規化（片側が number でも外れにならない）
  it("商品が文字列・ポリシーが number でも外れ0", () => {
    const policy = normalizePolicy({ expected: [216044] });
    const result = judgeArticleGenres({
      slug: "test",
      products: products(["216044", "216044"]),
      policy,
      heldUntil: null,
    });
    expect(result.outliers).toBe(0);
    expect(result.code).toBe("clean");
  });

  it("商品が number でも外れ0（yaml が number でパースするケース）", () => {
    const result = judgeArticleGenres({
      slug: "test",
      products: [{ rank: 1, name: "商品1", genreId: 216044 as unknown as string }],
      policy: { expected: ["216044"] },
      heldUntil: null,
    });
    expect(result.outliers).toBe(0);
  });
});

describe("normalizePolicy", () => {
  // G13
  it("number 手書きの expected を文字列に寄せる", () => {
    expect(normalizePolicy({ expected: [216044] })).toEqual({ expected: ["216044"] });
    expect(normalizePolicy({ expected: ["216044"], note: "ゴミ袋" })).toEqual({
      expected: ["216044"],
      note: "ゴミ袋",
    });
  });

  // G14
  it.each([
    [{ expected: [] }],
    [{}],
    [null],
    [undefined],
    [{ expected: "216044" }],
    [{ expected: [null, ""] }],
  ])("%p は null（unconfigured 扱い）", (raw) => {
    expect(normalizePolicy(raw)).toBeNull();
  });
});

describe("summarizeGenreFit", () => {
  const contaminated = judge([...Array(8).fill("a"), "b", "c"], ["a"]);
  const held = { ...judge([...Array(8).fill("a"), "b", "c"], ["a"], "2026-09-12"), slug: "held" };
  const clean = { ...judge(["a"], ["a"]), slug: "clean" };

  // G16
  it("code 別件数が合い、0件の code もキーが残る", () => {
    const summary = summarizeGenreFit([contaminated, held, clean]);
    expect(summary.articles).toBe(3);
    expect(summary.byCode).toEqual({
      clean: 1,
      contamination: 2,
      "design-review": 0,
      unconfigured: 0,
      "no-data": 0,
    });
    expect(summary.products).toBe(21);
    expect(summary.withGenre).toBe(21);
  });

  // G17
  it("actionable は凍結中でない contamination だけ数える", () => {
    expect(summarizeGenreFit([contaminated, held]).actionable).toBe(1);
  });
});

describe("formatGenreFitReport", () => {
  it("混入候補・凍結表示・prohibitions の注記を出す", () => {
    const articles: ArticleGenreFit[] = [
      { ...judge([...Array(8).fill("216044"), "205838", "550088"], ["216044"]), slug: "garbage-bag" },
      { ...judge([...Array(8).fill("a"), "b", "c"], ["a"], "2026-09-12"), slug: "laundry-gel-ball" },
      { ...judge(["a", "a", "b", "b"], ["a"]), slug: "cooling-pack" },
      { ...judge(["a", "b"], null), slug: "unset" },
      { ...judge([null], ["a"]), slug: "nodata" },
      { ...judge(["a"], ["a"]), slug: "ok" },
    ];
    const report = formatGenreFitReport(articles, summarizeGenreFit(articles), { today: "2026-09-05" });

    expect(report).toContain("garbage-bag — 着手可");
    expect(report).toContain("laundry-gel-ball — 2026-09-12 以降に着手可");
    expect(report).not.toContain("解除日");
    expect(report).toContain("prohibitions");
    expect(report).toContain("## 混入候補（2件）");
    expect(report).toContain("## 記事設計の要判断（1件）");
    expect(report).toContain("unset: 提案 a / b");
  });

  it("期限なし凍結を「期限なし」と表示する", () => {
    const articles: ArticleGenreFit[] = [
      { ...judge([...Array(8).fill("a"), "b", "c"], ["a"], "open-ended"), slug: "x" },
    ];
    const report = formatGenreFitReport(articles, summarizeGenreFit(articles), { today: "2026-09-05" });
    expect(report).toContain("x — 凍結中（期限なし）");
  });
});
