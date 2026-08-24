import { describe, it, expect } from "vitest";
import {
  JUDGEABLE_MIN_CLICKS,
  addDays,
  buildDigest,
  buildWindows,
  changePct,
  comparePages,
  countDays,
  enumerateDates,
  excludeFragmentPages,
  findMissingDates,
  fmtPct,
  isFragmentPage,
  normalizedChangePct,
  resolveConfirmedDate,
  toMetrics,
  toPagePath,
  toPerDay,
  type PageMetricRow,
  type SnapshotForDigest,
} from "../scripts/lib/weekly-snapshot.ts";

describe("addDays / countDays", () => {
  it("月をまたいで加減算できる", () => {
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDays("2026-08-20", 1)).toBe("2026-08-21");
    expect(addDays("2026-08-20", -6)).toBe("2026-08-14");
  });

  it("うるう日をまたげる", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("両端を含む日数を返す", () => {
    expect(countDays("2026-08-14", "2026-08-20")).toBe(7);
    expect(countDays("2026-08-20", "2026-08-20")).toBe(1);
  });

  it("形式が不正なら例外", () => {
    expect(() => addDays("2026/08/20", 1)).toThrow();
  });
});

describe("resolveConfirmedDate", () => {
  it("返却行の最終日を確定日にする", () => {
    const rows = [
      { date: "2026-08-18" },
      { date: "2026-08-20" },
      { date: "2026-08-19" },
    ];
    expect(resolveConfirmedDate(rows)).toBe("2026-08-20");
  });

  it("未反映日は行ごと欠落するので、欠落分は確定日にならない", () => {
    // 08-21 / 08-22 は GSC が行を返していない＝確定日は 08-20
    const rows = [{ date: "2026-08-19" }, { date: "2026-08-20" }];
    expect(resolveConfirmedDate(rows)).toBe("2026-08-20");
  });

  it("行が無ければ null", () => {
    expect(resolveConfirmedDate([])).toBeNull();
  });

  it("日付形式でない行は無視する", () => {
    expect(resolveConfirmedDate([{ date: "" }, { date: "2026-08-10" }])).toBe("2026-08-10");
  });
});

describe("buildWindows", () => {
  it("確定日を終端に今週・前週・28日窓を作る", () => {
    const windows = buildWindows("2026-08-20");
    expect(windows.current).toEqual({ start: "2026-08-14", end: "2026-08-20", days: 7 });
    expect(windows.previous).toEqual({ start: "2026-08-07", end: "2026-08-13", days: 7 });
    expect(windows.month).toEqual({ start: "2026-07-24", end: "2026-08-20", days: 28 });
  });

  it("今週と前週は重ならない", () => {
    const { current, previous } = buildWindows("2026-08-20");
    expect(addDays(previous.end, 1)).toBe(current.start);
  });

  it("窓幅を変えられる", () => {
    const windows = buildWindows("2026-08-20", 14, 28);
    expect(windows.current.start).toBe("2026-08-07");
    expect(windows.previous).toEqual({ start: "2026-07-24", end: "2026-08-06", days: 14 });
  });

  it("month が week より短ければ例外", () => {
    expect(() => buildWindows("2026-08-20", 14, 7)).toThrow();
  });
});

describe("enumerateDates / findMissingDates", () => {
  const window = { start: "2026-08-18", end: "2026-08-20", days: 3 };

  it("窓の日付を列挙する", () => {
    expect(enumerateDates(window)).toEqual(["2026-08-18", "2026-08-19", "2026-08-20"]);
  });

  it("行が無い日を未反映日として返す", () => {
    const rows = [{ date: "2026-08-18" }, { date: "2026-08-20" }];
    expect(findMissingDates(rows, window)).toEqual(["2026-08-19"]);
  });

  it("全て揃っていれば空配列", () => {
    const rows = enumerateDates(window).map((date) => ({ date }));
    expect(findMissingDates(rows, window)).toEqual([]);
  });
});

describe("toMetrics / toPerDay", () => {
  it("欠損は 0 埋めする", () => {
    expect(toMetrics(undefined)).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
  });

  it("窓の日数で割った日次値を足す", () => {
    const perDay = toPerDay({ clicks: 14, impressions: 70, ctr: 0.2, position: 9 }, 7);
    expect(perDay.clicksPerDay).toBe(2);
    expect(perDay.impressionsPerDay).toBe(10);
    expect(perDay.clicks).toBe(14);
  });

  it("days が 0 なら例外（未反映日を分母に入れる事故を防ぐ）", () => {
    expect(() => toPerDay({ clicks: 1, impressions: 1, ctr: 0, position: 1 }, 0)).toThrow();
  });
});

describe("changePct / normalizedChangePct", () => {
  it("変化率を % で返す", () => {
    expect(changePct(15, 10)).toBeCloseTo(50);
    expect(changePct(5, 10)).toBeCloseTo(-50);
  });

  it("前期がゼロなら判定不能（null）", () => {
    expect(changePct(10, 0)).toBeNull();
  });

  it("サイト全体が同率で伸びていれば正規化後はゼロ", () => {
    // 記事 2倍・サイト全体 2倍 → 実質横ばい
    expect(normalizedChangePct(20, 10, 200, 100)).toBeCloseTo(0);
  });

  it("サイト全体が伸びた中で記事が横ばいならマイナス評価になる", () => {
    // 記事 1.0倍・サイト 1.2倍 → 約 -16.7%
    const value = normalizedChangePct(10, 10, 120, 100);
    expect(value).toBeCloseTo(-16.6667, 3);
  });

  it("分母がゼロなら null", () => {
    expect(normalizedChangePct(10, 0, 100, 100)).toBeNull();
    expect(normalizedChangePct(10, 10, 100, 0)).toBeNull();
    expect(normalizedChangePct(10, 10, 0, 100)).toBeNull();
  });
});

describe("toPagePath", () => {
  it("パス部分だけ取り出す", () => {
    expect(toPagePath("https://www.kura-select.com/articles/hand-soap-comparison/")).toBe(
      "/articles/hand-soap-comparison/",
    );
  });

  it("URL でなければそのまま返す", () => {
    expect(toPagePath("not-a-url")).toBe("not-a-url");
  });
});

describe("comparePages", () => {
  const windows = {
    current: { start: "2026-08-14", end: "2026-08-20", days: 7 },
    previous: { start: "2026-08-07", end: "2026-08-13", days: 7 },
  };
  const siteCurrent = toPerDay(
    { clicks: 140, impressions: 1400, ctr: 0.1, position: 10 },
    7,
  );
  const sitePrevious = toPerDay(
    { clicks: 140, impressions: 1400, ctr: 0.1, position: 10 },
    7,
  );

  const current: PageMetricRow[] = [
    { page: "https://x.test/a/", clicks: 30, impressions: 300, ctr: 0.1, position: 8 },
    { page: "https://x.test/b/", clicks: 4, impressions: 500, ctr: 0.008, position: 12 },
  ];
  const previous: PageMetricRow[] = [
    { page: "https://x.test/a/", clicks: 15, impressions: 200, ctr: 0.075, position: 10 },
    { page: "https://x.test/b/", clicks: 3, impressions: 400, ctr: 0.0075, position: 15 },
    { page: "https://x.test/c/", clicks: 20, impressions: 100, ctr: 0.2, position: 5 },
  ];

  it("今週の表示が多い順に並ぶ（前週にしか無いページも含む）", () => {
    const rows = comparePages(current, previous, siteCurrent, sitePrevious, windows);
    expect(rows.map((r) => r.pagePath)).toEqual(["/b/", "/a/", "/c/"]);
  });

  it("サイト全体が横ばいなら正規化値は素の変化率と一致する", () => {
    const rows = comparePages(current, previous, siteCurrent, sitePrevious, windows);
    const a = rows.find((r) => r.pagePath === "/a/")!;
    expect(a.rawClicksPct).toBeCloseTo(100);
    expect(a.normalizedClicksPct).toBeCloseTo(100);
  });

  it("クリック実数が一桁のページは judgeable=false", () => {
    const rows = comparePages(current, previous, siteCurrent, sitePrevious, windows);
    const b = rows.find((r) => r.pagePath === "/b/")!;
    expect(b.current.clicks).toBeLessThan(JUDGEABLE_MIN_CLICKS);
    expect(b.judgeable).toBe(false);
    const a = rows.find((r) => r.pagePath === "/a/")!;
    expect(a.judgeable).toBe(true);
  });

  it("今週データが無いページは前週値だけを持ち、変化率は算出される", () => {
    const rows = comparePages(current, previous, siteCurrent, sitePrevious, windows);
    const c = rows.find((r) => r.pagePath === "/c/")!;
    expect(c.current.clicks).toBe(0);
    expect(c.previous.clicks).toBe(20);
    expect(c.rawClicksPct).toBeCloseTo(-100);
    expect(c.positionDelta).toBeNull();
  });

  it("順位の変化は「今週 − 前週」（負が改善）", () => {
    const rows = comparePages(current, previous, siteCurrent, sitePrevious, windows);
    const a = rows.find((r) => r.pagePath === "/a/")!;
    expect(a.positionDelta).toBeCloseTo(-2);
  });

  it("サイト全体が伸びた窓では、同じ素の伸びでも正規化値は下がる", () => {
    const grownSite = toPerDay({ clicks: 280, impressions: 2800, ctr: 0.1, position: 10 }, 7);
    const rows = comparePages(current, previous, grownSite, sitePrevious, windows);
    const a = rows.find((r) => r.pagePath === "/a/")!;
    expect(a.rawClicksPct).toBeCloseTo(100);
    expect(a.normalizedClicksPct).toBeCloseTo(0);
  });
});

describe("excludeFragmentPages", () => {
  const rows: PageMetricRow[] = [
    { page: "https://x.test/a/", clicks: 5, impressions: 100 },
    { page: "https://x.test/a/#%E8%A6%8B%E5%87%BA%E3%81%97", clicks: 0, impressions: 77 },
    { page: "https://x.test/b/", clicks: 1, impressions: 40 },
  ];

  it("アンカー付き URL を判別する", () => {
    expect(isFragmentPage("https://x.test/a/#見出し")).toBe(true);
    expect(isFragmentPage("https://x.test/a/")).toBe(false);
  });

  it("アンカー行を落とし、落とした行数と表示回数を返す", () => {
    const result = excludeFragmentPages(rows);
    expect(result.rows.map((r) => r.page)).toEqual([
      "https://x.test/a/",
      "https://x.test/b/",
    ]);
    expect(result.excludedCount).toBe(1);
    expect(result.excludedImpressions).toBe(77);
  });
});

describe("comparePages のアンカー除外", () => {
  const windows = {
    current: { start: "2026-08-15", end: "2026-08-21", days: 7 },
    previous: { start: "2026-08-08", end: "2026-08-14", days: 7 },
  };
  const site = toPerDay({ clicks: 100, impressions: 1000, ctr: 0.1, position: 10 }, 7);

  it("アンカー行は比較対象に含めない（親ページの二重計上を防ぐ）", () => {
    const current: PageMetricRow[] = [
      { page: "https://x.test/a/", clicks: 20, impressions: 238, ctr: 0.08, position: 5 },
      { page: "https://x.test/a/#h2", clicks: 0, impressions: 77, ctr: 0, position: 4 },
    ];
    const previous: PageMetricRow[] = [
      { page: "https://x.test/a/", clicks: 23, impressions: 230, ctr: 0.1, position: 5.8 },
    ];
    const compared = comparePages(current, previous, site, site, windows);
    expect(compared).toHaveLength(1);
    expect(compared[0].current.impressions).toBe(238);
  });
});

describe("fmtPct", () => {
  it("null は判定不能と表示する", () => {
    expect(fmtPct(null)).toBe("判定不能");
  });

  it("プラスには符号を付ける", () => {
    expect(fmtPct(12.345)).toBe("+12.3%");
    expect(fmtPct(-12.345)).toBe("-12.3%");
  });
});

describe("buildDigest", () => {
  const windows = buildWindows("2026-08-20");
  const snapshot: SnapshotForDigest = {
    generatedAt: "2026-08-24T00:00:00.000Z",
    confirmedDate: "2026-08-20",
    lagDays: 4,
    windows,
    gsc: {
      siteTotals: {
        current: toPerDay({ clicks: 140, impressions: 1400, ctr: 0.1, position: 10 }, 7),
        previous: toPerDay({ clicks: 70, impressions: 1400, ctr: 0.05, position: 11 }, 7),
        month: toPerDay({ clicks: 400, impressions: 5600, ctr: 0.07, position: 10.5 }, 28),
      },
      missingDates: [],
      pages: comparePages(
        [{ page: "https://x.test/a/", clicks: 30, impressions: 300, ctr: 0.1, position: 8 }],
        [{ page: "https://x.test/a/", clicks: 15, impressions: 200, ctr: 0.075, position: 10 }],
        toPerDay({ clicks: 140, impressions: 1400, ctr: 0.1, position: 10 }, 7),
        toPerDay({ clicks: 70, impressions: 1400, ctr: 0.05, position: 11 }, 7),
        windows,
      ),
      topQueries: [
        { query: "ハンドソープ 比較", clicks: 5, impressions: 100, ctr: 0.05, position: 8.2 },
      ],
    },
    ga4: { available: false, error: "鍵が無い" },
    bing: { available: false, error: "APIキーが無い" },
  };

  it("確定日を冒頭に明記する（CLAUDE.md §5.0.2 ルール3）", () => {
    const digest = buildDigest(snapshot);
    const head = digest.split("\n").slice(0, 5).join("\n");
    expect(head).toContain("GSC の最新確定日: 2026-08-20");
  });

  it("サイト全体と次元別の取得法を混ぜない注意書きを含む", () => {
    expect(buildDigest(snapshot)).toContain("次元の行を足し上げて");
  });

  it("正規化子を明示する", () => {
    expect(buildDigest(snapshot)).toContain("正規化子");
  });

  it("GA4 / Bing が取れなかった場合は理由を出す", () => {
    const digest = buildDigest(snapshot);
    expect(digest).toContain("鍵が無い");
    expect(digest).toContain("APIキーが無い");
  });

  it("上位ページ件数を制限できる", () => {
    const digest = buildDigest(snapshot, { topPages: 0 });
    expect(digest).not.toContain("/a/ |");
  });
});
