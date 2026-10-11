import { describe, it, expect } from "vitest";
import { monthLabel, partialLabel, toPoints, toPartialPoint, xLabelsOf, rebase, changePct } from "../src/lib/price-report-view";

describe("price-report-view", () => {
  it("月のラベル", () => {
    expect(monthLabel("2026-05")).toBe("5月");
    expect(partialLabel({ month: "2026-10", through: "2026-10-11" })).toBe("10月（11日まで）");
  });

  it("途中経過が null なら x 軸に入れない", () => {
    const months = [{ month: "2026-05", index: 100, pairs: 3 }];
    expect(xLabelsOf(months, { month: "2026-06", through: "2026-06-02", index: null, pairs: 1 })).toEqual(["5月"]);
    expect(toPartialPoint({ month: "2026-06", through: "2026-06-02", index: null, pairs: 1 })).toBeNull();
    expect(toPoints(months)).toEqual([{ x: "5月", y: 100 }]);
  });

  it("CPI を基準月＝100 に置き直す（基準月より前は捨てる）", () => {
    expect(rebase({ "2026-04": 101, "2026-05": 102.4, "2026-08": 111.8 }, "2026-05")).toEqual({
      "2026-05": 100,
      "2026-08": 109.2,
    });
    expect(() => rebase({ "2026-04": 1 }, "2026-05")).toThrow();
  });

  it("変化率", () => {
    expect(changePct(100, 102.28)).toBe(2.3);
    expect(changePct(null, 1)).toBeNull();
  });
});
