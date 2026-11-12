import { describe, expect, it } from "vitest";
import {
  classifyIncident,
  findOverlaps,
  formatSearchStatusSection,
  holdWindows,
  impactPeriod,
  mergeIncidents,
  normalizeIncident,
  normalizeIncidents,
  windowVerdict,
  type RawIncident,
} from "../scripts/lib/google-search-status.ts";

// status.search.google.com/incidents.json の実データ（2026-11-13 取得）から必要な項目だけ抜いたもの
const RAW: RawIncident[] = [
  {
    id: "nov-core",
    begin: "2026-11-10T18:06:00+00:00",
    external_desc: "November 2026 core update",
    service_name: "Ranking",
    status_impact: "SERVICE_INFORMATION",
    severity: "low",
    uri: "incidents/nov-core",
    updates: [
      {
        when: "2026-11-10T18:07:10+00:00",
        status: "SERVICE_INFORMATION",
        text: "Released the November 2026 core update, which applies globally and to all languages. The rollout may take up to 2 weeks to complete.",
      },
    ],
  },
  {
    id: "sep-spam",
    begin: "2026-09-24T16:15:00+00:00",
    end: "2026-10-08T08:00:00+00:00",
    external_desc: "September 2026 spam update",
    service_name: "Ranking",
    status_impact: "SERVICE_INFORMATION",
    updates: [
      { when: "2026-10-08T08:37:09+00:00", status: "AVAILABLE", text: "The rollout was complete as of October 8, 2026." },
      { when: "2026-09-24T16:15:47+00:00", status: "SERVICE_INFORMATION", text: "Released the September 2026 spam update, which applies globally and to all languages." },
    ],
  },
  {
    id: "may-core",
    begin: "2026-05-21T15:40:00+00:00",
    end: "2026-06-02T12:40:00+00:00",
    external_desc: "May 2026 core update",
    service_name: "Ranking",
    status_impact: "SERVICE_INFORMATION",
    updates: [{ when: "2026-05-21T15:43:28+00:00", text: "Released the May 2026 core update." }],
  },
  {
    id: "feb-serving",
    begin: "2026-02-25T03:55:00+00:00",
    end: "2026-02-25T04:10:00+00:00",
    external_desc: "Serving was experiencing an issue",
    service_name: "Serving",
    status_impact: "SERVICE_DISRUPTION",
    severity: "medium",
    updates: [{ when: "2026-02-25T06:33:39+00:00", text: "Serving was experiencing an issue." }],
  },
  {
    id: "feb-discover",
    begin: "2026-02-05T17:00:00+00:00",
    end: "2026-02-27T10:00:00+00:00",
    external_desc: "February 2026 Discover update",
    service_name: "Ranking",
    status_impact: "SERVICE_INFORMATION",
    updates: [
      {
        when: "2026-02-05T17:03:04+00:00",
        text: "Released the February 2026 Discover core update for English language users in the US (will look to expand it to all countries and languages in the coming months).",
      },
    ],
  },
];

const incidents = normalizeIncidents(RAW);
const byId = (id: string) => incidents.find((i) => i.id === id)!;

describe("classifyIncident", () => {
  it("core / spam / 障害 / 対象外の Discover を分ける", () => {
    expect(classifyIncident(RAW[0])).toBe("core-update");
    expect(classifyIncident(RAW[1])).toBe("spam-update");
    expect(classifyIncident(RAW[2])).toBe("core-update");
    expect(classifyIncident(RAW[3])).toBe("disruption");
    // 「Discover core update」でも米国英語限定なら core 扱いにしない
    expect(classifyIncident(RAW[4])).toBe("limited");
  });
});

describe("normalizeIncident", () => {
  it("開始は太平洋時間・終了は JST の日付に倒す（保守側に広げる）", () => {
    const nov = byId("nov-core");
    expect(nov.beginDate).toBe("2026-11-10"); // JST では 11-11 03:06
    expect(nov.endDate).toBeNull();
    const sep = byId("sep-spam");
    expect(sep.beginDate).toBe("2026-09-24"); // JST では 09-25 01:15
    expect(sep.endDate).toBe("2026-10-08"); // JST 17:00
    expect(sep.firstText).toMatch(/^Released/); // いちばん古い update を拾う
    expect(nov.url).toBe("https://status.search.google.com/incidents/nov-core");
  });

  it("id / begin が無ければ例外", () => {
    expect(() => normalizeIncident({ id: "", begin: "" })).toThrow();
    expect(() => normalizeIncidents({})).toThrow();
  });
});

describe("impactPeriod", () => {
  it("完了した core は完了後14日の揺れ戻しを含む", () => {
    expect(impactPeriod(byId("may-core"), "2026-11-13")).toEqual({
      start: "2026-05-21",
      end: "2026-06-16",
      ongoing: false,
    });
  });

  it("継続中の core は最長ロールアウト2週より早く終わらないとみなし、さらに14日足す", () => {
    expect(impactPeriod(byId("nov-core"), "2026-11-13").end).toBe("2026-12-08");
    // asOf がロールアウト2週を過ぎていれば asOf + 14日
    expect(impactPeriod(byId("nov-core"), "2026-12-01").end).toBe("2026-12-15");
  });

  it("spam は揺れ戻し期間を足さない", () => {
    expect(impactPeriod(byId("sep-spam"), "2026-11-13").end).toBe("2026-10-08");
  });
});

describe("findOverlaps", () => {
  const asOf = "2026-11-13";

  it("core が窓に重なれば暫定、重ならなければ影響なし", () => {
    const after = findOverlaps(incidents, { start: "2026-11-02", end: "2026-11-15" }, asOf);
    expect(after.map((o) => o.id)).toEqual(["nov-core"]);
    expect(after[0]).toMatchObject({ level: "provisional", overlapStart: "2026-11-10", overlapDays: 6, ongoing: true });
    expect(windowVerdict(after)).toBe("暫定");

    const before = findOverlaps(incidents, { start: "2026-10-13", end: "2026-11-09" }, asOf);
    expect(before).toEqual([]);
    expect(windowVerdict(before)).toBe("影響なし");
  });

  it("spam の重なりは注記、日数は両端を含めて数える", () => {
    const o = findOverlaps(incidents, { start: "2026-09-10", end: "2026-10-07" }, asOf);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ id: "sep-spam", level: "note", overlapStart: "2026-09-24", overlapEnd: "2026-10-07", overlapDays: 14 });
    expect(windowVerdict(o)).toBe("注記");
  });

  it("core の揺れ戻し期間だけが重なる窓も暫定", () => {
    const o = findOverlaps(incidents, { start: "2026-06-10", end: "2026-06-20" }, asOf);
    expect(o[0]).toMatchObject({ id: "may-core", overlapStart: "2026-06-10", overlapEnd: "2026-06-16", overlapDays: 7 });
  });

  it("対象外の地域・言語の告知は参考（info）", () => {
    const o = findOverlaps(incidents, { start: "2026-02-10", end: "2026-02-20" }, asOf);
    expect(o.map((x) => x.level)).toEqual(["info"]);
    expect(windowVerdict(o)).toBe("影響なし");
  });

  it("日付の形式が不正なら例外", () => {
    expect(() => findOverlaps(incidents, { start: "2026/11/01", end: "2026-11-02" }, asOf)).toThrow();
  });
});

describe("mergeIncidents", () => {
  it("同じ id は取得分で上書きし、ダッシュボードから消えた古い告知は残す", () => {
    const old = { ...byId("nov-core") };
    const ancient = { ...byId("may-core"), id: "2024-core", beginUtc: "2024-03-05T00:00:00+00:00" };
    const fetched = [{ ...old, endUtc: "2026-11-24T00:00:00+00:00", endDate: "2026-11-24" }];
    const merged = mergeIncidents([old, ancient], fetched);
    expect(merged.map((i) => i.id)).toEqual(["nov-core", "2024-core"]);
    expect(merged[0].endDate).toBe("2026-11-24");
  });
});

describe("holdWindows", () => {
  it("既存記事は前窓28日と後窓、新規記事は後窓だけ。releaseDate は解除日の翌日", () => {
    const w = holdWindows([
      { slug: "a", startedAt: "2026-10-13", releaseDate: "2026-11-11", targetType: "article" },
      { slug: "b", startedAt: "2026-11-02", releaseDate: "2026-11-17", targetType: "new-article" },
      { slug: "c", startedAt: "", releaseDate: "2026-11-17" },
    ]);
    expect(w).toEqual([
      { slug: "a", label: "前窓", window: { start: "2026-09-15", end: "2026-10-12" } },
      { slug: "a", label: "後窓", window: { start: "2026-10-13", end: "2026-11-10" } },
      { slug: "b", label: "後窓", window: { start: "2026-11-02", end: "2026-11-16" } },
    ]);
  });
});

describe("formatSearchStatusSection", () => {
  it("継続中の告知と窓ごとの扱いを並べる", () => {
    const md = formatSearchStatusSection({
      available: true,
      source: "live",
      asOf: "2026-11-13",
      incidents,
      windows: [{ label: "今週窓", start: "2026-11-07", end: "2026-11-13" }],
      holds: [{ slug: "copy-paper-comparison", label: "後窓", window: { start: "2026-10-31", end: "2026-11-14" } }],
    }).join("\n");
    expect(md).toContain("## 0-1. Google 検索の公式ステータス");
    expect(md).toContain("継続中: November 2026 core update");
    expect(md).toMatch(/\| 今週窓 \| 2026-11-07〜2026-11-13 \| 暫定 \|/);
    expect(md).toMatch(/\| copy-paper-comparison \| 後窓 \|.*\| 暫定 \|/);
  });

  it("取得できなければ目視確認を促す", () => {
    const md = formatSearchStatusSection({ available: false, error: "timeout", asOf: "2026-11-13", incidents: [], windows: [] }).join("\n");
    expect(md).toContain("取得できなかった: timeout");
  });

  it("保存分で判定したときはその旨を書く", () => {
    const md = formatSearchStatusSection({ available: true, source: "cache", asOf: "2026-11-13", incidents, windows: [] }).join("\n");
    expect(md).toContain("保存分で判定した");
  });
});
