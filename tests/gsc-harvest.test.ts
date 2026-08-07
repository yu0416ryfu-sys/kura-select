import { describe, it, expect } from "vitest";
import {
  classifyPosition,
  classifyRow,
  classifyRows,
  summarizeByPage,
  detectCannibalization,
  buildHarvestReport,
  toPagePath,
  DEFAULT_MIN_IMPRESSIONS,
  type GscQueryRow,
} from "../scripts/lib/gsc-harvest.ts";

const BASE = "https://www.kura-select.com";

function row(partial: Partial<GscQueryRow> = {}): GscQueryRow {
  return {
    query: "クエリ",
    page: `${BASE}/articles/hand-soap/`,
    clicks: 1,
    impressions: 50,
    ctr: 0.02,
    position: 9.5,
    ...partial,
  };
}

describe("classifyPosition", () => {
  it("8位未満は対象外", () => {
    expect(classifyPosition(7.9)).toBeNull();
  });

  it("境界 8 は A", () => {
    expect(classifyPosition(8)).toBe("A");
  });

  it("境界 12 は B（A の上端は含まない）", () => {
    expect(classifyPosition(11.9)).toBe("A");
    expect(classifyPosition(12)).toBe("B");
  });

  it("境界 20 は C（B の上端は含まない）", () => {
    expect(classifyPosition(19.9)).toBe("B");
    expect(classifyPosition(20)).toBe("C");
  });

  it("境界 30 は C に含み、超えたら対象外", () => {
    expect(classifyPosition(30)).toBe("C");
    expect(classifyPosition(30.1)).toBeNull();
  });

  it("数値でなければ対象外", () => {
    expect(classifyPosition(Number.NaN)).toBeNull();
  });
});

describe("classifyRow", () => {
  it("表示 14 は既定閾値（15）未満で除外", () => {
    expect(classifyRow(row({ impressions: 14 }))).toBeNull();
  });

  it("表示 15 は候補になる", () => {
    const result = classifyRow(row({ impressions: 15 }));
    expect(result?.band).toBe("A");
    expect(result?.impressions).toBe(15);
  });

  it("既定の最小表示回数は 15", () => {
    expect(DEFAULT_MIN_IMPRESSIONS).toBe(15);
  });

  it("minImpressions を上書きできる", () => {
    expect(classifyRow(row({ impressions: 14 }), { minImpressions: 10 })).not.toBeNull();
  });

  it("順位が帯外なら表示が多くても除外", () => {
    expect(classifyRow(row({ impressions: 500, position: 3.2 }))).toBeNull();
    expect(classifyRow(row({ impressions: 500, position: 45 }))).toBeNull();
  });

  it("pagePath にパスだけを入れる", () => {
    expect(classifyRow(row())?.pagePath).toBe("/articles/hand-soap/");
  });
});

describe("classifyRows", () => {
  it("表示回数の多い順に並べる", () => {
    const rows = [
      row({ query: "少", impressions: 20 }),
      row({ query: "多", impressions: 100 }),
      row({ query: "圏外", impressions: 100, position: 60 }),
    ];
    expect(classifyRows(rows).map((r) => r.query)).toEqual(["多", "少"]);
  });
});

describe("summarizeByPage", () => {
  it("ページ単位に集約し、最上位の帯を採用する", () => {
    const rows = classifyRows([
      row({ query: "a", impressions: 60, clicks: 2, position: 15 }),
      row({ query: "b", impressions: 40, clicks: 1, position: 9 }),
      row({
        query: "c",
        page: `${BASE}/articles/body-soap/`,
        impressions: 30,
        clicks: 0,
        position: 25,
      }),
    ]);

    const pages = summarizeByPage(rows);
    expect(pages).toHaveLength(2);
    expect(pages[0].pagePath).toBe("/articles/hand-soap/");
    expect(pages[0].band).toBe("A"); // B と A が混在 → A を採る
    expect(pages[0].impressions).toBe(100);
    expect(pages[0].clicks).toBe(3);
    expect(pages[0].queryCount).toBe(2);
    expect(pages[1].band).toBe("C");
  });
});

describe("detectCannibalization", () => {
  const cannibalRows = [
    row({
      query: "フロッシュ ヤシノミ 比較",
      page: `${BASE}/articles/frosch-vs-yashinomi/`,
      impressions: 30,
      clicks: 3,
      position: 3.6,
    }),
    row({
      query: "フロッシュ ヤシノミ 比較",
      page: `${BASE}/category/dish-detergent/`,
      impressions: 20,
      clicks: 0,
      position: 9.0,
    }),
    row({
      query: "単独クエリ",
      page: `${BASE}/articles/hand-soap/`,
      impressions: 100,
      clicks: 5,
      position: 9,
    }),
  ];

  it("同一クエリで2URL以上のものだけ返す", () => {
    const groups = detectCannibalization(cannibalRows);
    expect(groups).toHaveLength(1);
    expect(groups[0].query).toBe("フロッシュ ヤシノミ 比較");
    expect(groups[0].impressions).toBe(50);
    expect(groups[0].clicks).toBe(3);
  });

  it("順位の良い順にページを並べる", () => {
    const [group] = detectCannibalization(cannibalRows);
    expect(group.pages.map((p) => p.pagePath)).toEqual([
      "/articles/frosch-vs-yashinomi/",
      "/category/dish-detergent/",
    ]);
  });

  it("合計表示が閾値未満なら除外する", () => {
    const groups = detectCannibalization(cannibalRows, { minTotalImpressions: 100 });
    expect(groups).toHaveLength(0);
  });

  it("A〜C の順位帯外でもカニバリとして検出する", () => {
    const rows = [
      row({ query: "q", page: `${BASE}/a/`, position: 2, impressions: 20 }),
      row({ query: "q", page: `${BASE}/b/`, position: 55, impressions: 20 }),
    ];
    expect(detectCannibalization(rows)).toHaveLength(1);
  });
});

describe("toPagePath", () => {
  it("URL でなければそのまま返す", () => {
    expect(toPagePath("not-a-url")).toBe("not-a-url");
  });
});

describe("buildHarvestReport", () => {
  const meta = {
    startDate: "2026-07-08",
    endDate: "2026-08-04",
    fetchedAt: "2026-08-07T00:00:00.000Z",
    runDate: "2026-08-07",
    minImpressions: 15,
    totalRows: 828,
  };

  it("期間・実行日・候補・カニバリを含む Markdown を返す", () => {
    const rows = classifyRows([row({ query: "ハンドソープ 殺菌力 比較", impressions: 59, position: 10.5 })]);
    const report = buildHarvestReport(meta, summarizeByPage(rows), []);

    expect(report).toContain("# GSC 刈り取り候補レポート");
    expect(report).toContain("実行日: 2026-08-07");
    expect(report).toContain("データ期間: 2026-07-08 〜 2026-08-04");
    expect(report).toContain("/articles/hand-soap/");
    expect(report).toContain("ハンドソープ 殺菌力 比較");
    expect(report).toContain("10.5");
  });

  it("候補もカニバリも無ければ「該当なし」を出す", () => {
    const report = buildHarvestReport(meta, [], []);
    expect(report.match(/該当なし/g)).toHaveLength(2);
  });
});
