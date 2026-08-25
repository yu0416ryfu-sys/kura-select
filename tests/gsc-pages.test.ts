import { describe, it, expect } from "vitest";
import { excludeFragmentPages, isFragmentPage } from "../scripts/lib/gsc-pages.ts";

describe("isFragmentPage", () => {
  it("アンカー付き URL を true と判定する", () => {
    expect(isFragmentPage("https://x.test/articles/a/#見出し")).toBe(true);
  });

  it("アンカーなし URL を false と判定する", () => {
    expect(isFragmentPage("https://x.test/articles/a/")).toBe(false);
  });

  it("空文字は false", () => {
    expect(isFragmentPage("")).toBe(false);
  });
});

describe("excludeFragmentPages", () => {
  it("アンカー付き行を落とし、落とした行数と表示数を返す", () => {
    const rows = [
      { page: "https://x.test/a/", clicks: 3, impressions: 100 },
      { page: "https://x.test/a/#比較表", clicks: 0, impressions: 40 },
      { page: "https://x.test/b/", clicks: 1, impressions: 20 },
      { page: "https://x.test/b/#faq", clicks: 0, impressions: 5 },
    ];
    const result = excludeFragmentPages(rows);
    expect(result.rows.map((row) => row.page)).toEqual([
      "https://x.test/a/",
      "https://x.test/b/",
    ]);
    expect(result.excludedCount).toBe(2);
    expect(result.excludedImpressions).toBe(45);
  });

  it("ctr / position など追加フィールドを保持する", () => {
    const rows = [
      { page: "https://x.test/a/", clicks: 3, impressions: 100, ctr: 0.03, position: 10.4 },
    ];
    const result = excludeFragmentPages(rows);
    expect(result.rows[0]).toEqual({
      page: "https://x.test/a/",
      clicks: 3,
      impressions: 100,
      ctr: 0.03,
      position: 10.4,
    });
  });

  it("impressions が欠けていても NaN にならない", () => {
    const rows = [{ page: "https://x.test/a/#見出し" }];
    const result = excludeFragmentPages(rows);
    expect(result.excludedCount).toBe(1);
    expect(result.excludedImpressions).toBe(0);
  });

  it("page が空の行は落とさない", () => {
    const rows = [{ page: "", clicks: 0, impressions: 0 }];
    expect(excludeFragmentPages(rows).rows).toHaveLength(1);
  });

  it("空配列を渡しても壊れない", () => {
    const result = excludeFragmentPages([]);
    expect(result).toEqual({ rows: [], excludedCount: 0, excludedImpressions: 0 });
  });
});
