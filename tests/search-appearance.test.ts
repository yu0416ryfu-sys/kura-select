import { describe, expect, it } from "vitest";
import {
  buildAppearanceMarkdown,
  joinSnippetPages,
  resolveProductSnippetKey,
  toDateRows,
  toKeyedRows,
  toPageRows,
  type AppearanceReport,
  type PageRow,
} from "../scripts/lib/search-appearance";

const SITE = "https://www.kura-select.com";

function page(path: string, clicks: number, impressions: number): PageRow {
  return { page: `${SITE}${path}`, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: 5 };
}

describe("行の変換", () => {
  it("toDateRows は keys[0] を date にする", () => {
    expect(toDateRows([{ keys: ["2026-10-04"], clicks: 1 }, {}])).toEqual([
      { date: "2026-10-04" },
      { date: "" },
    ]);
  });

  it("toKeyedRows / toPageRows は欠落した指標を 0 で埋める", () => {
    expect(toKeyedRows([{ keys: ["PRODUCT_SNIPPETS"], clicks: 3 }])).toEqual([
      { key: "PRODUCT_SNIPPETS", clicks: 3, impressions: 0, ctr: 0, position: 0 },
    ]);
    expect(toPageRows([{ keys: [`${SITE}/a/`], impressions: 10 }])[0]).toMatchObject({
      page: `${SITE}/a/`,
      clicks: 0,
      impressions: 10,
    });
  });
});

describe("resolveProductSnippetKey", () => {
  const row = (key: string, impressions: number) => ({ key, clicks: 0, impressions, ctr: 0, position: 0 });

  it("返ってきたキーから PRODUCT_SNIPPETS を選ぶ", () => {
    expect(resolveProductSnippetKey([row("FAQ_RICH_RESULTS", 100), row("PRODUCT_SNIPPETS", 50)])).toBe(
      "PRODUCT_SNIPPETS",
    );
  });

  it("該当キーが無ければ null（黙って 0 にしない）", () => {
    expect(resolveProductSnippetKey([row("FAQ_RICH_RESULTS", 100)])).toBeNull();
    expect(resolveProductSnippetKey([])).toBeNull();
  });

  it("候補が複数なら表示の多い方", () => {
    expect(resolveProductSnippetKey([row("PRODUCT_SNIPPETS_A", 10), row("PRODUCT_SNIPPETS_B", 20)])).toBe(
      "PRODUCT_SNIPPETS_B",
    );
  });
});

describe("joinSnippetPages", () => {
  it("スニペット行と全体行を page で結合し、クリック比を出す", () => {
    const { rows } = joinSnippetPages([page("/articles/a/", 40, 400)], [page("/articles/a/", 50, 900)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("/articles/a/");
    expect(rows[0].total?.clicks).toBe(50);
    expect(rows[0].clickShare).toBeCloseTo(0.8);
  });

  it("両側からアンカー付き URL を除外し、除外行数を返す", () => {
    const result = joinSnippetPages(
      [page("/articles/a/", 10, 100), page("/articles/a/#見出し", 5, 50)],
      [page("/articles/a/", 20, 200), page("/articles/a/#見出し", 5, 50), page("/articles/b/#x", 1, 1)],
    );
    expect(result.rows.map((r) => r.path)).toEqual(["/articles/a/"]);
    expect(result.excludedSnippetRows).toBe(1);
    expect(result.excludedTotalRows).toBe(2);
  });

  it("全体側に無いページは total / clickShare を null にする", () => {
    const { rows } = joinSnippetPages([page("/articles/only-snippet/", 3, 30)], []);
    expect(rows[0].total).toBeNull();
    expect(rows[0].clickShare).toBeNull();
  });

  it("スニペットのクリック降順、同数は表示降順で並べる", () => {
    const { rows } = joinSnippetPages(
      [page("/a/", 5, 10), page("/b/", 10, 10), page("/c/", 5, 30)],
      [],
    );
    expect(rows.map((r) => r.path)).toEqual(["/b/", "/c/", "/a/"]);
  });
});

describe("buildAppearanceMarkdown", () => {
  const base: AppearanceReport = {
    confirmedDate: "2026-10-04",
    window: { start: "2026-09-07", end: "2026-10-04", days: 28 },
    siteTotal: { clicks: 2290, impressions: 57624, ctr: 0.0397, position: 9.1 },
    appearances: [{ key: "PRODUCT_SNIPPETS", clicks: 464, impressions: 4854, ctr: 0.0956, position: 6.9 }],
    snippetKey: "PRODUCT_SNIPPETS",
    snippetPages: joinSnippetPages([page("/articles/a/", 239, 2000)], [page("/articles/a/", 259, 3000)]).rows,
    excludedSnippetRows: 0,
    excludedTotalRows: 1,
  };

  it("冒頭に確定日と窓を書く", () => {
    const md = buildAppearanceMarkdown(base);
    expect(md).toContain("GSC の最新確定日は 2026-10-04");
    expect(md).toContain("窓: 2026-09-07 〜 2026-10-04（28日）");
  });

  it("サイト合計・見え方別・ページ別の主要行を出す", () => {
    const md = buildAppearanceMarkdown(base);
    expect(md).toContain("| 2,290 | 57,624 | 4.0% | 9.1 |");
    expect(md).toContain("| PRODUCT_SNIPPETS | 464 | 4,854 | 9.6% | 6.9 | 20.3% |");
    expect(md).toContain("| /articles/a/ | 239 | 2,000 |");
    expect(md).toContain("| 259 | 3,000 | 92.3% |");
  });

  it("商品スニペットのキーが無ければ「行なし」と明示する", () => {
    const md = buildAppearanceMarkdown({ ...base, snippetKey: null, snippetPages: [] });
    expect(md).toContain("商品スニペットの行なし");
    expect(md).not.toContain("## 商品スニペットが出たページ\n\nキー:");
  });
});
