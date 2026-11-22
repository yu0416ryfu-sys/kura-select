import { describe, it, expect } from "vitest";
import {
  addDays,
  articleIdFromUrl,
  assessBingFetchHealth,
  classifyRotationCandidates,
  parseImprovementLog,
  parseRecoverPending,
  parseTrialFailures,
  resolveLogSlug,
  selectLatestBingWeeks,
  sumByArticleId,
} from "../scripts/lib/rotation-candidates.mjs";

const TODAY = "2026-11-21";

/** 既定では「公開90日・GSC 0・送客0・Bing 5・凍結なし・季節品でない・加筆なし」＝ M4 になる入力 */
function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    today: TODAY,
    articles: [{ id: "a-comparison", publishedAt: addDays(TODAY, -90) }],
    gscImpressions: new Map<string, number>(),
    outbound: new Map<string, number>(),
    bingImpressions: new Map<string, number>([["a-comparison", 5]]),
    frozen: new Set<string>(),
    noindexed: new Set<string>(),
    seasonal: new Set<string>(),
    improvements: [] as { id: string; date: string }[],
    recoverPending: new Set<string>(),
    ...overrides,
  };
}

function verdictOf(overrides: Record<string, unknown> = {}) {
  const rows = classifyRotationCandidates(baseInput(overrides));
  return rows[0]?.verdict;
}

describe("classifyRotationCandidates: 対象の条件", () => {
  it("公開59日は返さない／60日は返す", () => {
    expect(classifyRotationCandidates(baseInput({ articles: [{ id: "a-comparison", publishedAt: addDays(TODAY, -59) }] }))).toHaveLength(0);
    expect(classifyRotationCandidates(baseInput({ articles: [{ id: "a-comparison", publishedAt: addDays(TODAY, -60) }] }))).toHaveLength(1);
  });
  it("GSC 9 は返す／10 は返さない", () => {
    expect(classifyRotationCandidates(baseInput({ gscImpressions: new Map([["a-comparison", 9]]) }))).toHaveLength(1);
    expect(classifyRotationCandidates(baseInput({ gscImpressions: new Map([["a-comparison", 10]]) }))).toHaveLength(0);
  });
  it("noindex 済みは返さない", () => {
    expect(classifyRotationCandidates(baseInput({ noindexed: new Set(["a-comparison"]) }))).toHaveLength(0);
  });
  it("試験枠で ❌ の記事は公開27日は返さない／28日は返す（ほかの記事は60日のまま）", () => {
    const at = (days: number, trialFailed: Set<string>) =>
      classifyRotationCandidates(baseInput({ articles: [{ id: "a-comparison", publishedAt: addDays(TODAY, -days) }], trialFailed }));
    expect(at(27, new Set(["a-comparison"]))).toHaveLength(0);
    const [row] = at(28, new Set(["a-comparison"]));
    expect(row.verdict).toBe("M4");
    expect(row.trialFailed).toBe(true);
    expect(at(28, new Set())).toHaveLength(0);
  });
});

describe("parseTrialFailures", () => {
  const text = [
    "**新規記事**",
    "| 公開日 | 記事 | 型 | 採択時の表示・測ったクエリ | 2週後の順位帯 |",
    "|---|---|---|---|---|",
    "| 10-14 | `paper-towel-comparison` | 比較記事（前借り） | 未測定 | ❌未離陸（境界） |",
    "| 10-25 | `water-filter-cartridge-comparison` | 比較記事（試験枠） | なし | ❌未離陸（0行） |",
    "| 11-02 | `sheet-mask-comparison` | 比較記事（試験枠） | なし | ❌未離陸・⚠️暫定（取り直し） |",
    "| 11-02 | `baby-formula-comparison` | 比較記事（試験枠） | なし | ✅離陸・⚠️暫定 |",
    "| 11-12 | `lip-balm-comparison` | 比較記事（試験枠・11月3本目） | なし | 11-28 判定 |",
    "**外した記事**",
    "| 実施日 | 記事 | 区分 | 備考 |",
    "|---|---|---|---|",
    "| 10-17 | `razor-comparison` | 試験枠 | ❌ |",
  ].join("\n");
  it("試験枠・❌・暫定でない記事だけを返し、次の表は読まない", () => {
    expect([...parseTrialFailures(text)]).toEqual(["water-filter-cartridge-comparison"]);
  });
  it("表が無ければ空の Set", () => {
    expect(parseTrialFailures("# なし").size).toBe(0);
  });
});

describe("classifyRotationCandidates: M0", () => {
  it("凍結中は M0、凍結台帳を読めなければ hold", () => {
    expect(verdictOf({ frozen: new Set(["a-comparison"]) })).toBe("M0");
    expect(verdictOf({ frozen: null })).toBe("hold");
  });
  it("加筆が28日前ちょうどは M0、29日前は M0 にならない", () => {
    expect(verdictOf({ improvements: [{ id: "a-comparison", date: addDays(TODAY, -28) }] })).toBe("M0");
    expect(verdictOf({ improvements: [{ id: "a-comparison", date: addDays(TODAY, -29) }] })).toBe("M4");
  });
  it("未登録の復帰の +28日 が空なら M0、改善ログが無ければ hold", () => {
    expect(verdictOf({ recoverPending: new Set(["a-comparison"]) })).toBe("M0");
    expect(verdictOf({ improvements: null })).toBe("hold");
    expect(verdictOf({ recoverPending: null })).toBe("hold");
  });
});

describe("classifyRotationCandidates: M1〜M4", () => {
  it("送客1は M1、GA4 取得失敗は hold", () => {
    expect(verdictOf({ outbound: new Map([["a-comparison", 1]]) })).toBe("M1");
    expect(verdictOf({ outbound: null })).toBe("hold");
  });
  it("Bing 99 は M2 にならない／100 は M2", () => {
    expect(verdictOf({ bingImpressions: new Map([["a-comparison", 99]]) })).toBe("M4");
    expect(verdictOf({ bingImpressions: new Map([["a-comparison", 100]]) })).toBe("M2");
  });
  it("Bing 行なしは M2-hold で、bing は '行なし' のまま・表示0とみなした判定を並べる", () => {
    const [row] = classifyRotationCandidates(baseInput({ bingImpressions: new Map() }));
    expect(row.verdict).toBe("M2-hold");
    expect(row.bing).toBe("行なし");
    expect(row.verdictIfBingZero).toBe("M4");
    const [seasonalRow] = classifyRotationCandidates(baseInput({ bingImpressions: new Map(), seasonal: new Set(["a-comparison"]) }));
    expect(seasonalRow.verdictIfBingZero).toBe("M3");
  });
  it("M2-hold 以外の行の verdictIfBingZero は null", () => {
    const [row] = classifyRotationCandidates(baseInput());
    expect(row.verdict).toBe("M4");
    expect(row.verdictIfBingZero).toBeNull();
  });
  it("Bing 取得失敗は hold", () => {
    expect(verdictOf({ bingImpressions: null })).toBe("hold");
  });
  it("取得が正常なら Bing 行なしは M4（季節品は M3）・bing は '行なし'・verdictIfBingZero は null", () => {
    const [row] = classifyRotationCandidates(baseInput({ bingImpressions: new Map(), bingHealthy: true }));
    expect(row.verdict).toBe("M4");
    expect(row.bing).toBe("行なし");
    expect(row.verdictIfBingZero).toBeNull();
    expect(row.reason).toContain("取得は正常・表示0とみなす");
    const [seasonalRow] = classifyRotationCandidates(
      baseInput({ bingImpressions: new Map(), bingHealthy: true, seasonal: new Set(["a-comparison"]) }),
    );
    expect(seasonalRow.verdict).toBe("M3");
  });
  it("bingHealthy: false を明示しても行なしは M2-hold", () => {
    expect(verdictOf({ bingImpressions: new Map(), bingHealthy: false })).toBe("M2-hold");
  });
  it("Bing 取得失敗（null）は bingHealthy: true でも hold", () => {
    expect(verdictOf({ bingImpressions: null, bingHealthy: true })).toBe("hold");
  });
  it("季節品は M3、どれにも当たらなければ M4", () => {
    expect(verdictOf({ seasonal: new Set(["a-comparison"]) })).toBe("M3");
    expect(verdictOf()).toBe("M4");
  });
});

describe("classifyRotationCandidates: 順番と空値", () => {
  it("凍結中かつ送客ありは M0（上から最初に当たったもの）", () => {
    expect(verdictOf({ frozen: new Set(["a-comparison"]), outbound: new Map([["a-comparison", 3]]) })).toBe("M0");
  });
  it("戻り値は GSC の表示の少ない順", () => {
    const rows = classifyRotationCandidates(
      baseInput({
        articles: [
          { id: "b-comparison", publishedAt: addDays(TODAY, -90) },
          { id: "a-comparison", publishedAt: addDays(TODAY, -90) },
        ],
        gscImpressions: new Map([["b-comparison", 1], ["a-comparison", 5]]),
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["b-comparison", "a-comparison"]);
  });
  it("公開日が空文字・undefined なら年齢の条件を飛ばして hold で返し、GSC 10 なら返さない", () => {
    for (const publishedAt of ["", undefined]) {
      const [row] = classifyRotationCandidates(baseInput({ articles: [{ id: "a-comparison", publishedAt }], gscImpressions: new Map([["a-comparison", 9]]) }));
      expect(row.verdict).toBe("hold");
      expect(row.ageDays).toBeNull();
      expect(
        classifyRotationCandidates(baseInput({ articles: [{ id: "a-comparison", publishedAt }], gscImpressions: new Map([["a-comparison", 10]]) })),
      ).toHaveLength(0);
    }
  });
});

describe("resolveLogSlug", () => {
  const ids = new Set(["shampoo-comparison", "reviews/shampoo-pantene-damage-care-review"]);
  it("短縮形を -comparison 付きの ID に寄せる", () => {
    expect(resolveLogSlug("shampoo", ids)).toBe("shampoo-comparison");
  });
  it("reviews/ 配下の ID に末尾一致で寄る", () => {
    expect(resolveLogSlug("shampoo-pantene-damage-care-review", ids)).toBe("reviews/shampoo-pantene-damage-care-review");
  });
  it("どれにも無ければ null", () => {
    expect(resolveLogSlug("nothing", ids)).toBeNull();
  });
});

const LOG = [
  "# 記事改善の実施ログ",
  "",
  "## 1. 実施ログ",
  "",
  "| 日付 | 記事（slug） | 型 | 内容 | コミット | 登録リクエスト |",
  "|---|---|---|---|---|---|",
  "| 2026-11-20 | hair-color | T1 | 加筆 | abc | 済 |",
  "| 2026-11-10 | shampoo | T2 | 加筆 | def | |",
  "",
  "## 2. 提案の記録（見送り・却下）",
  "",
  "| 日付 | 記事 | 型 | 判断 | 理由 |",
  "|---|---|---|---|---|",
  "| 2026-11-20 | natural-cleaning | T10 | 見送り | 理由 |",
  "",
  "## 6. 未登録の復帰の経過",
  "",
  "| デプロイ日 | 記事（slug） | 実施前の状態（最終クロール） | 判定 | 原因の仮説 | +14日 | +28日 |",
  "|---|---|---|---|---|---|---|",
  "| 2026-11-01 | hand-cream | 未登録 | 規則5 | なし | 登録済み | |",
  "| 2026-11-01 | toothpaste | noindex | 例外 | なし | 登録済み | 登録済み |",
  "",
  "## 7. 次の節",
  "",
  "| デプロイ日 | 記事（slug） | a | b | c | d | +28日 |",
  "|---|---|---|---|---|---|---|",
  "| 2026-11-02 | diaper-pants | x | x | x | x | |",
];
const LOG_TEXT = LOG.join("\n");
const LOG_IDS = new Set([
  "hair-color-comparison",
  "shampoo-comparison",
  "natural-cleaning-comparison",
  "hand-cream-comparison",
  "toothpaste-comparison",
  "diaper-pants-comparison",
]);

describe("parseImprovementLog", () => {
  it("8セル以上かつ2セル目が日付の行を拾い、5列の §2 は拾わない", () => {
    const rows = parseImprovementLog(LOG_TEXT, LOG_IDS);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("hair-color-comparison");
    expect(ids).toContain("shampoo-comparison");
    expect(ids).not.toContain("natural-cleaning-comparison");
    // 7列の §6 の行も拾う（旧 loadImprovementLog と同じ挙動）
    expect(ids).toContain("hand-cream-comparison");
    expect(rows[0]).toEqual({ date: "2026-11-20", id: "hair-color-comparison", type: "T1", text: "加筆", request: "済" });
  });
});

describe("parseRecoverPending", () => {
  it("§6 の +28日 が空の行だけを返し、§6 の後の節の表は拾わない", () => {
    expect([...parseRecoverPending(LOG_TEXT, LOG_IDS)]).toEqual(["hand-cream-comparison"]);
  });
  it("§6 の見出しが無ければ空の Set", () => {
    expect(parseRecoverPending("# 何もない\n", LOG_IDS).size).toBe(0);
  });
});

describe("sumByArticleId", () => {
  it("URL・パス・末尾スラッシュ・# と ? の違いを同じ ID に合計する", () => {
    const map = sumByArticleId([
      { key: "https://www.kura-select.com/articles/a-comparison/", value: 1 },
      { key: "/articles/a-comparison", value: 2 },
      { key: "http://kura-select.com/articles/a-comparison/#x", value: 3 },
      { key: "/articles/a-comparison/?utm=1", value: 4 },
    ]);
    expect(map.get("a-comparison")).toBe(10);
  });
  it("reviews/ 配下の ID を残し、記事でない URL を捨てる", () => {
    const map = sumByArticleId([
      { key: "/articles/reviews/b-review/", value: 1 },
      { key: "https://www.kura-select.com/category/x/", value: 5 },
      { key: "https://www.kura-select.com/", value: 5 },
    ]);
    expect([...map.entries()]).toEqual([["reviews/b-review", 1]]);
  });
});

describe("articleIdFromUrl", () => {
  it("絶対 URL・パス・末尾スラッシュなし・# と ? つき・reviews/ 配下を記事 ID に寄せる", () => {
    expect(articleIdFromUrl("https://www.kura-select.com/articles/a-comparison/")).toBe("a-comparison");
    expect(articleIdFromUrl("/articles/a-comparison")).toBe("a-comparison");
    expect(articleIdFromUrl("/articles/a-comparison/#x")).toBe("a-comparison");
    expect(articleIdFromUrl("/articles/a-comparison/?utm=1")).toBe("a-comparison");
    expect(articleIdFromUrl("/articles/reviews/b-review/")).toBe("reviews/b-review");
  });
  it("記事でない URL は null", () => {
    expect(articleIdFromUrl("https://www.kura-select.com/")).toBeNull();
    expect(articleIdFromUrl("/category/x/")).toBeNull();
    expect(articleIdFromUrl("/articles/")).toBeNull();
    expect(articleIdFromUrl(undefined)).toBeNull();
  });
});

describe("assessBingFetchHealth", () => {
  const WEEKS = ["2026-10-23", "2026-10-30", "2026-11-06", "2026-11-13"];
  const IDS = Array.from({ length: 20 }, (_, i) => `a${i}-comparison`);
  const SITE = "https://www.kura-select.com";
  type Row = { date: string; page: string; impressions: number };
  /** 正常な入力: 4週・各週20本の実在記事（表示5）・a0 は表示1・トップとカテゴリの行が1行ずつ */
  function healthyPicked(): { rows: Row[]; weeks: string[] } {
    const rows: Row[] = [];
    for (const date of WEEKS) {
      for (const id of IDS) rows.push({ date, page: `${SITE}/articles/${id}/`, impressions: id === "a0-comparison" ? 1 : 5 });
    }
    rows.push({ date: WEEKS[0], page: `${SITE}/`, impressions: 30 });
    rows.push({ date: WEEKS[0], page: `${SITE}/category/laundry-detergent/`, impressions: 3 });
    return { rows, weeks: [...WEEKS] };
  }
  const known = new Set(IDS);
  const withRow = (row: Row) => {
    const p = healthyPicked();
    p.rows.push(row);
    return assessBingFetchHealth(p, known);
  };

  it("既定の入力は正常（トップ・カテゴリの行があっても）", () => {
    expect(assessBingFetchHealth(healthyPicked(), known)).toEqual({ healthy: true, reasons: [] });
  });
  it("3週しかなければ異常", () => {
    const p = healthyPicked();
    p.weeks = WEEKS.slice(1);
    p.rows = p.rows.filter((r) => r.date !== WEEKS[0]);
    const out = assessBingFetchHealth(p, known);
    expect(out.healthy).toBe(false);
    expect(out.reasons.join()).toContain("週が 3 週");
  });
  it("ある週の記事が19本なら異常で、その週の日付が理由に出る", () => {
    const p = healthyPicked();
    p.rows = p.rows.filter((r) => !(r.date === WEEKS[2] && r.page.includes("a19-comparison")));
    const out = assessBingFetchHealth(p, known);
    expect(out.healthy).toBe(false);
    expect(out.reasons.join()).toContain(WEEKS[2]);
  });
  it("同じ週の同じ記事が2行あっても1本と数える（20行でも19本なら異常）", () => {
    const p = healthyPicked();
    p.rows = p.rows.filter((r) => !(r.date === WEEKS[2] && r.page.includes("a19-comparison")));
    p.rows.push({ date: WEEKS[2], page: "/articles/a0-comparison", impressions: 1 });
    expect(assessBingFetchHealth(p, known).healthy).toBe(false);
  });
  it("記事でない URL は数えない（記事19本＋カテゴリ1行の週は異常）", () => {
    const p = healthyPicked();
    p.rows = p.rows.filter((r) => !(r.date === WEEKS[1] && r.page.includes("a19-comparison")));
    p.rows.push({ date: WEEKS[1], page: `${SITE}/category/x/`, impressions: 2 });
    expect(assessBingFetchHealth(p, known).healthy).toBe(false);
  });
  it("記事の行の表示が全部3以上なら異常（トップ・カテゴリだけが表示1でも異常）", () => {
    const p = healthyPicked();
    p.rows = p.rows.map((r) => (r.page.includes("/articles/") ? { ...r, impressions: 3 } : { ...r, impressions: 1 }));
    const out = assessBingFetchHealth(p, known);
    expect(out.healthy).toBe(false);
    expect(out.reasons.join()).toContain("表示 2 以下");
  });
  it("picked が空でも例外を投げず異常", () => {
    expect(assessBingFetchHealth({ rows: [], weeks: [] }, known).healthy).toBe(false);
  });
  it("記事に寄せられない記事らしい URL（大文字・%2F・壊れたエンコード）は異常", () => {
    for (const page of ["/Articles/foo/", "/articles%2Ffoo", "/Articles/%E3"]) {
      const out = withRow({ date: WEEKS[0], page, impressions: 1 });
      expect(out.healthy, page).toBe(false);
      expect(out.reasons.join(), page).toContain("記事に寄せられない");
    }
  });
  it("記事一覧ページの行は数えない", () => {
    for (const page of [`${SITE}/articles/`, "/articles", "/articles/?ref=x"]) {
      expect(withRow({ date: WEEKS[0], page, impressions: 1 }).healthy, page).toBe(true);
    }
  });
  it("/articles/%E3 は id %E3 になり「実在しない記事 ID」で異常", () => {
    const out = withRow({ date: WEEKS[0], page: "/articles/%E3", impressions: 1 });
    expect(out.healthy).toBe(false);
    expect(out.reasons.join()).toContain("実在しない記事 ID");
  });
  it("articleIds に無い記事 ID の行があれば異常・articleIds 未指定でも異常", () => {
    const out = withRow({ date: WEEKS[0], page: "/articles/foo-comparison-old/", impressions: 1 });
    expect(out.healthy).toBe(false);
    expect(out.reasons.join()).toContain("実在しない記事 ID");
    expect(assessBingFetchHealth(healthyPicked(), undefined).healthy).toBe(false);
  });
});

describe("selectLatestBingWeeks", () => {
  const week = (date: string) => ({ date, page: "/articles/a-comparison/", impressions: 1 });
  it("確定日以前で最新の4週を残す（確定日より後の週は外す）", () => {
    const rows = ["2026-10-16", "2026-10-23", "2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"].map(week);
    const out = selectLatestBingWeeks(rows, "2026-11-19");
    expect(out.weeks).toEqual(["2026-10-23", "2026-10-30", "2026-11-06", "2026-11-13"]);
    expect(out.rows).toHaveLength(4);
    expect(out.scale).toBe(1);
  });
  it("週が3つだけなら3週を残して scale は 4/3", () => {
    const out = selectLatestBingWeeks(["2026-10-30", "2026-11-06", "2026-11-13"].map(week), "2026-11-19");
    expect(out.weeks).toHaveLength(3);
    expect(out.scale).toBeCloseTo(4 / 3);
  });
  it("行が0なら weeks は空・scale は 0", () => {
    const out = selectLatestBingWeeks([], "2026-11-19");
    expect(out.weeks).toEqual([]);
    expect(out.scale).toBe(0);
  });
});
