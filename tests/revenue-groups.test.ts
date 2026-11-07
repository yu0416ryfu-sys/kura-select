import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  GROUPS,
  preWindow,
  datesBetween,
  buildRevenueGroupStatus,
  earliestNeededDate,
} from "../scripts/lib/revenue-groups.mjs";

// 広告群・改善群の台帳（data/revenue-groups.json）の整合と、ダッシュボードの集計ロジックを検査する。

const ARTICLES_DIR = path.resolve("./src/content/articles");
const ledger = JSON.parse(fs.readFileSync(path.resolve("./data/revenue-groups.json"), "utf8"));
const placements = JSON.parse(fs.readFileSync(path.resolve("./data/ad-placements.json"), "utf8")).placements;

const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

describe("data/revenue-groups.json", () => {
  it("members の slug が実在し、group と日付の形が正しい", () => {
    const seen = new Set<string>();
    for (const m of ledger.members) {
      expect(fs.existsSync(path.join(ARTICLES_DIR, `${m.slug}.md`)), m.slug).toBe(true);
      expect(GROUPS).toContain(m.group);
      expect(isDate(m.assignedAt), m.slug).toBe(true);
      if (m.notBefore != null) expect(isDate(m.notBefore)).toBe(true);
      if (m.returnedAt != null) expect(isDate(m.returnedAt)).toBe(true);
      expect(seen.has(m.slug), `重複: ${m.slug}`).toBe(false);
      seen.add(m.slug);
    }
  });

  it("掲載台帳の記事はすべて広告群に入っている", () => {
    const ad = new Set(ledger.members.filter((m: { group: string }) => m.group === "ad").map((m: { slug: string }) => m.slug));
    for (const p of placements) expect(ad.has(p.slug), p.slug).toBe(true);
  });

  it("excludedDates は日付・eps は null か正の数", () => {
    for (const d of ledger.excludedDates) expect(isDate(d)).toBe(true);
    expect(ledger.eps === null || (typeof ledger.eps === "number" && ledger.eps > 0)).toBe(true);
  });
});

describe("preWindow", () => {
  it("除外日を飛ばして28日を遡る（joy の 10-08〜11-05 と一致）", () => {
    const w = preWindow("2026-11-06", ["2026-10-31"]);
    expect(w.from).toBe("2026-10-08");
    expect(w.to).toBe("2026-11-05");
    expect(w.dates).toHaveLength(28);
    expect(w.dates).not.toContain("2026-10-31");
  });
});

describe("buildRevenueGroupStatus", () => {
  // 記事 A（広告群）・B（改善群）・C（対照）。毎日 PV 10、送客は A が前1/後0.5 相当、C が一定
  const days = datesBetween("2026-09-01", "2026-12-31");
  const series = (fn: (d: string) => { pv: number; outbound: number }) => new Map(days.map((d) => [d, fn(d)]));
  const ga4 = new Map([
    ["/a/", series((d) => ({ pv: 10, outbound: d >= "2026-11-06" ? (d.endsWith("0") ? 1 : 0) : 1 }))],
    ["/b/", series(() => ({ pv: 10, outbound: 0 }))],
    ["/c/", series(() => ({ pv: 100, outbound: 10 }))],
  ]);
  const paths = new Map([["a", "/a/"], ["b", "/b/"], ["c", "/c/"]]);
  const groups = {
    excludedDates: ["2026-10-31"],
    eps: null,
    members: [
      { slug: "a", group: "ad", assignedAt: "2026-11-03" },
      { slug: "b", group: "improve", assignedAt: "2026-11-03" },
    ],
  };
  const pl = [{ slug: "a", start: "2026-11-06", end: null, slots: [{ platform: "sp", spotId: "1" }] }];
  const rev = [{ date: "2026-11-06", spotId: "1", impressions: 100, revenue: 5 }];
  const log = [{ date: "2026-11-04", id: "b", type: "T1" }, { date: "2026-10-01", id: "b", type: "古い" }];

  const status = buildRevenueGroupStatus({
    groups, placements: pl, revenueRows: rev, improveLog: log, ga4, paths, ga4End: "2026-12-10", today: "2026-12-11",
  });

  it("広告群: 掲載前28日・掲載後・広告実績・安全装置ブロックを出す", () => {
    const a = status.ad[0];
    expect(a.state).toBe("live");
    expect(a.pre.from).toBe("2026-10-08");
    expect(a.pre.outbound).toBe(28);
    expect(a.post.from).toBe("2026-11-06");
    expect(a.ads.revenue).toBe(5);
    expect(a.ads.rpm).toBeCloseTo(500); // ¥5 ÷ 10PV × 1000
    expect(a.blocks[0]).toMatchObject({ n: 1, from: "2026-11-06", to: "2026-12-03", complete: true });
    expect(a.blocks[1].complete).toBe(false);
    expect(a.sitePre.rate).toBeCloseTo(0.1); // 対照 C だけ（A・B は群なので除く）
  });

  it("合算: 判定日は +8週か送客20到達の早いほう", () => {
    expect(status.combined.firstStart).toBe("2026-11-06");
    expect(status.combined.judgeByDate).toBe("2027-01-01");
    expect(status.combined.reviewDate).toBe("2027-01-29");
    expect(status.combined.ratioBasis).toBe("send-rate");
    expect(status.combined.ratio).toBeLessThan(1);
  });

  it("改善群: 起点は assignedAt 以降で最初の改善ログ行", () => {
    const b = status.improve[0];
    expect(b.startedAt).toBe("2026-11-04");
    expect(b.judgeDate).toBe("2026-12-02");
    expect(b.state).toBe("due");
    expect(b.post.to).toBe("2026-12-01");
  });

  it("改善ログが無ければ未着手・GA4 が無くても落ちない", () => {
    const s = buildRevenueGroupStatus({ groups, placements: [], improveLog: [], ga4: null, paths, ga4End: null, today: "2026-11-07" });
    expect(s.improve[0].state).toBe("not-started");
    expect(s.ad[0].state).toBe("not-started");
    expect(s.combined).toBeNull();
  });

  it("earliestNeededDate は最も早い開始の掲載前期間の初日", () => {
    expect(earliestNeededDate(groups, pl, log)).toBe(preWindow("2026-11-04", ["2026-10-31"]).from);
  });
});
