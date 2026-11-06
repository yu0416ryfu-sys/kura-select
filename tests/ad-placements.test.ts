import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  END_REASONS,
  AD_PLATFORMS,
  isActivePlacement,
  getActivePlacement,
} from "../scripts/lib/ad-placements.mjs";

// インプレッション広告の台帳（計画書 docs/PLAN_IMPRESSION_ADS_2026-11-03_V3.md §5）の整合性を検査する。
// 検査ロジックは純関数にして、実データ（[] を期待）と壊れた fixture（該当エラーを期待）の両方で確かめる。

const ARTICLES_DIR = path.resolve("./src/content/articles");
const LEDGER_PATH = path.resolve("./data/ad-placements.json");
const REVENUE_PATH = path.resolve("./data/ad-revenue.json");
const HOLDS_PATH = path.resolve("./data/measurement-holds.json");
const ADS_TXT_PATH = path.resolve("./public/ads.txt");

type Placement = Record<string, unknown>;
type Ledger = { network?: unknown; placements?: unknown };
type Revenue = { network?: unknown; rows?: unknown };
type Hold = {
  slug?: string;
  slugs?: string[];
  startedAt?: string;
  releaseDate?: string;
};

/** 記事 id（base からの相対パス・拡張子なし・区切りは /）を再帰で集める */
function listArticleSlugs(dir: string, base = dir): string[] {
  const slugs: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      slugs.push(...listArticleSlugs(full, base));
    } else if (entry.name.endsWith(".md")) {
      slugs.push(path.relative(base, full).replace(/\\/g, "/").replace(/\.md$/, ""));
    }
  }
  return slugs;
}

/** YYYY-MM-DD の形で、かつ実在する日付か */
function isRealDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** 凍結行を slug 単位に展開する（slug / slugs[] の両形式） */
function expandHolds(holds: Hold[]): { slug: string; startedAt?: string; releaseDate?: string }[] {
  const out: { slug: string; startedAt?: string; releaseDate?: string }[] = [];
  for (const h of holds) {
    const slugs = [...(h.slug ? [h.slug] : []), ...(Array.isArray(h.slugs) ? h.slugs : [])];
    for (const slug of slugs) out.push({ slug, startedAt: h.startedAt, releaseDate: h.releaseDate });
  }
  return out;
}

/** タグ文字列から i-mobile の pid / asid を取り出す（無ければ undefined） */
function tagParam(tag: string, key: "pid" | "asid"): string | undefined {
  return new RegExp(String.raw`[{,]\s*${key}\s*:\s*(\d+)`).exec(tag)?.[1];
}

/** placements[].slots の検査。spotId は台帳全体で一意 */
function validateSlots(slots: unknown, label: string, seenSpotIds: Set<string>): string[] {
  const errors: string[] = [];
  if (!Array.isArray(slots) || slots.length === 0) return [`${label}: slots が空でない配列でない`];
  const seenPlatforms = new Set<string>();
  (slots as Record<string, unknown>[]).forEach((slot, j) => {
    const sl = `${label}.slots[${j}]`;
    if (!(AD_PLATFORMS as string[]).includes(slot.platform as string)) {
      errors.push(`${sl}: platform が sp / pc でない`);
    } else if (seenPlatforms.has(slot.platform as string)) {
      errors.push(`${sl}: platform が重複 (${String(slot.platform)})`);
    } else {
      seenPlatforms.add(slot.platform as string);
    }
    if (!isNonEmptyString(slot.spotId)) {
      errors.push(`${sl}: spotId が空`);
    } else if (seenSpotIds.has(slot.spotId)) {
      errors.push(`${sl}: spotId が重複 (${slot.spotId})`);
    } else {
      seenSpotIds.add(slot.spotId);
    }
    if (!isNonEmptyString(slot.tag)) {
      errors.push(`${sl}: tag が空`);
      return;
    }
    const tag = slot.tag;
    if (isNonEmptyString(slot.spotId) && tagParam(tag, "asid") !== slot.spotId) {
      errors.push(`${sl}: tag の asid が spotId と一致しない`);
    }
    if (!tagParam(tag, "pid")) errors.push(`${sl}: tag に pid が無い`);
    if (/document\.write/.test(tag)) errors.push(`${sl}: tag が document.write を使っている（差し込み方式では壊れる）`);
    if (!/<script[^>]*\basync\b[^>]*src="https:\/\//.test(tag)) errors.push(`${sl}: tag が https の async スクリプトでない`);
    const divId = /^<div id="([^"]+)">/.exec(tag.trim())?.[1];
    if (!divId || !tag.includes(`elementid:"${divId}"`)) errors.push(`${sl}: tag の div id と elementid が一致しない`);
  });
  return errors;
}

/** data/ad-placements.json の検査。エラー文字列の配列を返す（空なら正常） */
function validatePlacements(ledger: Ledger, holds: Hold[], articleSlugs: Set<string>): string[] {
  const errors: string[] = [];
  if (typeof ledger.network !== "string") errors.push("network が文字列でない");
  if (!Array.isArray(ledger.placements)) {
    errors.push("placements が配列でない");
    return errors;
  }
  const placements = ledger.placements as Placement[];
  const frozen = expandHolds(holds);
  const seenSpotIds = new Set<string>();
  const openBySlug = new Map<string, number>();

  placements.forEach((p, i) => {
    const label = `placements[${i}](${String(p.slug)})`;
    if (!isNonEmptyString(p.slug)) {
      errors.push(`${label}: slug が空`);
    } else if (!articleSlugs.has(p.slug)) {
      errors.push(`${label}: 記事が存在しない`);
    }
    if (p.kind !== "display") errors.push(`${label}: kind が display でない`);
    errors.push(...validateSlots(p.slots, label, seenSpotIds));

    const startOk = isRealDate(p.start);
    if (!startOk) errors.push(`${label}: start が実在する YYYY-MM-DD でない`);
    if (p.end !== null && p.end !== undefined) {
      if (!isRealDate(p.end)) {
        errors.push(`${label}: end が null か実在する YYYY-MM-DD でない`);
      } else if (startOk && (p.end as string) < (p.start as string)) {
        errors.push(`${label}: end が start より前`);
      }
    }
    if (p.end == null) {
      if (p.endReason != null) errors.push(`${label}: end が null なのに endReason がある`);
      if (isNonEmptyString(p.slug)) openBySlug.set(p.slug, (openBySlug.get(p.slug) ?? 0) + 1);
    } else if (!(END_REASONS as string[]).includes(p.endReason as string)) {
      errors.push(`${label}: endReason が END_REASONS のいずれでもない`);
    }
    if (typeof p.reason !== "object" || p.reason === null || Array.isArray(p.reason)) {
      errors.push(`${label}: reason がオブジェクトでない`);
    }

    // 凍結との照合: startedAt <= start < releaseDate は衝突。startedAt なしは常に凍結、releaseDate なしは期限なし
    if (startOk && isNonEmptyString(p.slug)) {
      for (const h of frozen) {
        if (h.slug !== p.slug) continue;
        const startsInside = h.startedAt == null || h.startedAt <= (p.start as string);
        const beforeRelease = h.releaseDate == null || (p.start as string) < h.releaseDate;
        if (startsInside && beforeRelease) {
          errors.push(`${label}: 凍結中（${h.startedAt ?? "起点不明"}〜${h.releaseDate ?? "期限なし"}）に掲載を開始している`);
        }
      }
    }
  });

  for (const [slug, count] of openBySlug) {
    if (count > 1) errors.push(`${slug}: 掲載中（end == null）の行が ${count} 行ある`);
  }
  return errors;
}

/** data/ad-revenue.json の検査。エラー文字列の配列を返す（空なら正常） */
function validateRevenue(revenue: Revenue, ledger: Ledger): string[] {
  const errors: string[] = [];
  if (typeof revenue.network !== "string") errors.push("network が文字列でない");
  if (!Array.isArray(revenue.rows)) {
    errors.push("rows が配列でない");
    return errors;
  }
  const placements = (Array.isArray(ledger.placements) ? ledger.placements : []) as Placement[];
  const bySpot = new Map<string, Placement>();
  for (const p of placements) {
    if (!Array.isArray(p.slots)) continue;
    for (const slot of p.slots as Record<string, unknown>[]) if (isNonEmptyString(slot.spotId)) bySpot.set(slot.spotId, p);
  }

  const seen = new Set<string>();
  (revenue.rows as Record<string, unknown>[]).forEach((r, i) => {
    const label = `rows[${i}](${String(r.date)}/${String(r.spotId)})`;
    const dateOk = isRealDate(r.date);
    if (!dateOk) errors.push(`${label}: date が実在する YYYY-MM-DD でない`);
    const placement = isNonEmptyString(r.spotId) ? bySpot.get(r.spotId) : undefined;
    if (!placement) errors.push(`${label}: spotId が ad-placements.json に無い`);
    if (!Number.isInteger(r.impressions) || (r.impressions as number) < 0) {
      errors.push(`${label}: impressions が 0 以上の整数でない`);
    }
    if (typeof r.revenue !== "number" || !Number.isFinite(r.revenue) || r.revenue < 0) {
      errors.push(`${label}: revenue が 0 以上の有限数でない`);
    }
    const key = `${String(r.date)}|${String(r.spotId)}`;
    if (seen.has(key)) errors.push(`${label}: (date, spotId) が重複`);
    seen.add(key);

    if (dateOk && placement && isRealDate(placement.start)) {
      if ((r.date as string) < (placement.start as string)) errors.push(`${label}: 掲載開始日より前の実績`);
      if (placement.end != null && isRealDate(placement.end) && (r.date as string) > (placement.end as string)) {
        errors.push(`${label}: 掲載終了日より後の実績`);
      }
    }
  });
  return errors;
}

// ---- 実データ ----

const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) as Ledger;
const revenue = JSON.parse(fs.readFileSync(REVENUE_PATH, "utf8")) as Revenue;
const holds = (JSON.parse(fs.readFileSync(HOLDS_PATH, "utf8")) as { holds: Hold[] }).holds;
const articleSlugs = new Set(listArticleSlugs(ARTICLES_DIR));

describe("実データ: data/ad-placements.json", () => {
  it("検査にエラーがない（記事の実在・slots・日付・end/endReason・凍結との衝突）", () => {
    expect(validatePlacements(ledger, holds, articleSlugs)).toEqual([]);
  });

  it("public/ads.txt に台帳のタグの pid がすべて i-mobile の DIRECT 行として載っている", () => {
    const adsTxt = fs.readFileSync(ADS_TXT_PATH, "utf8");
    const pids = new Set<string>();
    for (const p of (ledger.placements ?? []) as Placement[]) {
      for (const slot of (Array.isArray(p.slots) ? p.slots : []) as Record<string, unknown>[]) {
        const pid = isNonEmptyString(slot.tag) ? tagParam(slot.tag, "pid") : undefined;
        if (pid) pids.add(pid);
      }
    }
    for (const pid of pids) {
      expect(adsTxt.split(/\r?\n/)).toContain(`i-mobile.co.jp, ${pid}, DIRECT`);
    }
  });
});

describe("実データ: data/ad-revenue.json", () => {
  it("検査にエラーがない（spotId・日付・数値・重複・掲載期間内）", () => {
    expect(validateRevenue(revenue, ledger)).toEqual([]);
  });
});

// ---- validatePlacements の単体テスト ----

/** テスト用の i-mobile タグ（実タグと同じ形） */
const tagOf = (asid: string) =>
  `<div id="im-${asid}">\n  <script async src="https://imp-adedge.i-mobile.co.jp/script/v1/spot.js?20220104"></script>\n  <script>(window.adsbyimobile=window.adsbyimobile||[]).push({pid:85693,mid:1,asid:${asid},type:"banner",display:"inline",elementid:"im-${asid}"})</script>\n</div>`;
const spSlot = (spotId: string) => ({ platform: "sp", spotId, tag: tagOf(spotId) });
const pcSlot = (spotId: string) => ({ platform: "pc", spotId, tag: tagOf(spotId) });

describe("validatePlacements", () => {
  const slugs = new Set(["razor-comparison", "reviews/foo-review"]);
  const base = {
    slug: "razor-comparison",
    kind: "display",
    slots: [spSlot("101"), pcSlot("102")],
    start: "2026-11-10",
    end: null,
    endReason: null,
    reason: { note: "テスト" },
  };
  const make = (...rows: Placement[]): Ledger => ({ network: "i-mobile", placements: rows });

  it("正しい台帳（空・掲載中・終了済み）はエラーなし", () => {
    expect(validatePlacements(make(), [], slugs)).toEqual([]);
    expect(validatePlacements(make(base), [], slugs)).toEqual([]);
    const ended = { ...base, slug: "reviews/foo-review", slots: [spSlot("201")], end: "2026-11-20", endReason: "manual" };
    expect(validatePlacements(make(base, ended), [], slugs)).toEqual([]);
  });

  it("network が文字列でない / placements が配列でない", () => {
    expect(validatePlacements({ network: 1, placements: [] }, [], slugs).join()).toContain("network");
    expect(validatePlacements({ network: "x", placements: {} }, [], slugs).join()).toContain("placements が配列でない");
  });

  it("存在しない記事・空の slug", () => {
    expect(validatePlacements(make({ ...base, slug: "nothing-comparison" }), [], slugs).join()).toContain("記事が存在しない");
    expect(validatePlacements(make({ ...base, slug: "" }), [], slugs).join()).toContain("slug が空");
  });

  it("kind が display 以外", () => {
    expect(validatePlacements(make({ ...base, kind: "native" }), [], slugs).join()).toContain("kind");
  });

  it("slots が空 / 配列でない", () => {
    expect(validatePlacements(make({ ...base, slots: [] }), [], slugs).join()).toContain("slots が空でない配列でない");
    expect(validatePlacements(make({ ...base, slots: "x" }), [], slugs).join()).toContain("slots が空でない配列でない");
  });

  it("spotId が空 / 台帳内で重複", () => {
    expect(validatePlacements(make({ ...base, slots: [{ ...spSlot("101"), spotId: "" }] }), [], slugs).join()).toContain("spotId が空");
    const dup = { ...base, slug: "reviews/foo-review", end: "2026-11-20", endReason: "manual" };
    expect(validatePlacements(make(base, dup), [], slugs).join()).toContain("spotId が重複");
  });

  it("platform が不正 / 重複", () => {
    expect(
      validatePlacements(make({ ...base, slots: [{ ...spSlot("101"), platform: "tablet" }] }), [], slugs).join(),
    ).toContain("platform が sp / pc でない");
    expect(validatePlacements(make({ ...base, slots: [spSlot("101"), spSlot("103")] }), [], slugs).join()).toContain("platform が重複");
  });

  it("tag の asid・pid・document.write・async・elementid の検査", () => {
    const withTag = (tag: string) => make({ ...base, slots: [{ ...spSlot("101"), tag }] });
    expect(validatePlacements(withTag(""), [], slugs).join()).toContain("tag が空");
    expect(validatePlacements(withTag(tagOf("999")), [], slugs).join()).toContain("asid が spotId と一致しない");
    expect(validatePlacements(withTag(tagOf("101").replace("pid:85693,", "")), [], slugs).join()).toContain("pid が無い");
    expect(
      validatePlacements(withTag(tagOf("101") + "<script>document.write('x')</script>"), [], slugs).join(),
    ).toContain("document.write");
    expect(validatePlacements(withTag(tagOf("101").replace(" async", "")), [], slugs).join()).toContain("async スクリプトでない");
    expect(
      validatePlacements(withTag(tagOf("101").replace('elementid:"im-101"', 'elementid:"im-x"')), [], slugs).join(),
    ).toContain("elementid が一致しない");
  });

  it("start が不正 / 実在しない日付", () => {
    expect(validatePlacements(make({ ...base, start: "2026/11/10" }), [], slugs).join()).toContain("start");
    expect(validatePlacements(make({ ...base, start: "2026-02-30" }), [], slugs).join()).toContain("start");
  });

  it("end が不正 / start より前", () => {
    expect(validatePlacements(make({ ...base, end: "bad", endReason: "manual" }), [], slugs).join()).toContain("end が");
    expect(
      validatePlacements(make({ ...base, end: "2026-11-09", endReason: "manual" }), [], slugs).join(),
    ).toContain("end が start より前");
    // 同日は許容
    expect(validatePlacements(make({ ...base, end: "2026-11-10", endReason: "manual" }), [], slugs)).toEqual([]);
  });

  it("end が null なのに endReason がある", () => {
    expect(validatePlacements(make({ ...base, endReason: "manual" }), [], slugs).join()).toContain("endReason がある");
  });

  it("end があるのに endReason が不正 / 無い", () => {
    expect(
      validatePlacements(make({ ...base, end: "2026-11-20", endReason: "other" }), [], slugs).join(),
    ).toContain("endReason が END_REASONS");
    expect(
      validatePlacements(make({ ...base, end: "2026-11-20", endReason: null }), [], slugs).join(),
    ).toContain("endReason が END_REASONS");
  });

  it("reason がオブジェクトでない", () => {
    expect(validatePlacements(make({ ...base, reason: "text" }), [], slugs).join()).toContain("reason");
    expect(validatePlacements(make({ ...base, reason: null }), [], slugs).join()).toContain("reason");
  });

  it("同じ slug で掲載中の行が2行", () => {
    const second = { ...base, slots: [spSlot("201")] };
    expect(validatePlacements(make(base, second), [], slugs).join()).toContain("掲載中（end == null）の行が 2 行");
    // 片方が終了済みなら可
    const ended = { ...base, slots: [spSlot("201")], end: "2026-11-20", endReason: "manual" };
    expect(validatePlacements(make(base, ended), [], slugs)).toEqual([]);
  });

  describe("凍結との照合", () => {
    const hold = (h: Hold): Hold[] => [h];

    it("凍結期間内（startedAt <= start < releaseDate）の開始は衝突", () => {
      const holds = hold({ slug: "razor-comparison", startedAt: "2026-10-13", releaseDate: "2026-11-11" });
      expect(validatePlacements(make(base), holds, slugs).join()).toContain("凍結中");
    });

    it("start == startedAt は衝突、start == releaseDate は衝突しない", () => {
      const startedHold = hold({ slug: "razor-comparison", startedAt: "2026-11-10", releaseDate: "2026-11-20" });
      expect(validatePlacements(make(base), startedHold, slugs).join()).toContain("凍結中");
      const releasedHold = hold({ slug: "razor-comparison", startedAt: "2026-10-01", releaseDate: "2026-11-10" });
      expect(validatePlacements(make(base), releasedHold, slugs)).toEqual([]);
    });

    it("凍結の前に始まる / 凍結解除後に始まる / 別 slug の凍結は衝突しない", () => {
      expect(
        validatePlacements(make(base), hold({ slug: "razor-comparison", startedAt: "2026-11-11", releaseDate: "2026-12-01" }), slugs),
      ).toEqual([]);
      expect(
        validatePlacements(make(base), hold({ slug: "razor-comparison", startedAt: "2026-10-01", releaseDate: "2026-11-01" }), slugs),
      ).toEqual([]);
      expect(
        validatePlacements(make(base), hold({ slug: "other-comparison", startedAt: "2026-10-01", releaseDate: "2026-12-01" }), slugs),
      ).toEqual([]);
    });

    it("releaseDate なしは期限なし凍結（startedAt <= start なら衝突）", () => {
      expect(
        validatePlacements(make(base), hold({ slug: "razor-comparison", startedAt: "2026-10-01" }), slugs).join(),
      ).toContain("凍結中");
      expect(validatePlacements(make(base), hold({ slug: "razor-comparison", startedAt: "2026-12-01" }), slugs)).toEqual([]);
    });

    it("startedAt なしは起点不明なので常に凍結扱い", () => {
      expect(
        validatePlacements(make(base), hold({ slug: "razor-comparison", releaseDate: "2026-12-01" }), slugs).join(),
      ).toContain("凍結中");
    });

    it("slugs[] 形式の行は各 slug に展開される", () => {
      const holds = hold({ slugs: ["other-comparison", "razor-comparison"], startedAt: "2026-10-01", releaseDate: "2026-12-01" });
      expect(validatePlacements(make(base), holds, slugs).join()).toContain("凍結中");
    });
  });
});

// ---- validateRevenue の単体テスト ----

describe("validateRevenue", () => {
  const slugs = new Set(["razor-comparison"]);
  const ledgerOf = (end: string | null = null): Ledger => ({
    network: "i-mobile",
    placements: [
      {
        slug: "razor-comparison",
        kind: "display",
        slots: [spSlot("101"), pcSlot("102")],
        start: "2026-11-10",
        end,
        endReason: end ? "manual" : null,
        reason: {},
      },
    ],
  });
  const row = { date: "2026-11-12", spotId: "101", impressions: 100, revenue: 12.5 };
  const make = (...rows: Record<string, unknown>[]): Revenue => ({ network: "i-mobile", rows });

  it("前提: テスト用の台帳自体は正しい", () => {
    expect(validatePlacements(ledgerOf(), [], slugs)).toEqual([]);
  });

  it("正しい実績（空・0 の値・掲載期間の端）はエラーなし", () => {
    expect(validateRevenue(make(), ledgerOf())).toEqual([]);
    expect(validateRevenue(make(row), ledgerOf())).toEqual([]);
    expect(validateRevenue(make({ ...row, impressions: 0, revenue: 0 }), ledgerOf())).toEqual([]);
    expect(validateRevenue(make({ ...row, date: "2026-11-10" }), ledgerOf())).toEqual([]);
    expect(validateRevenue(make({ ...row, date: "2026-11-20" }), ledgerOf("2026-11-20"))).toEqual([]);
  });

  it("network が文字列でない / rows が配列でない", () => {
    expect(validateRevenue({ network: null, rows: [] }, ledgerOf()).join()).toContain("network");
    expect(validateRevenue({ network: "x", rows: {} }, ledgerOf()).join()).toContain("rows が配列でない");
  });

  it("date が不正 / 実在しない", () => {
    expect(validateRevenue(make({ ...row, date: "11/12" }), ledgerOf()).join()).toContain("date");
    expect(validateRevenue(make({ ...row, date: "2026-13-01" }), ledgerOf()).join()).toContain("date");
  });

  it("spotId が台帳に無い / pc 側の spotId は可", () => {
    expect(validateRevenue(make({ ...row, spotId: "unknown" }), ledgerOf()).join()).toContain("spotId が ad-placements.json に無い");
    expect(validateRevenue(make({ ...row, spotId: "102" }), ledgerOf())).toEqual([]);
  });

  it("impressions が負数・小数・文字列", () => {
    for (const impressions of [-1, 1.5, "10"]) {
      expect(validateRevenue(make({ ...row, impressions }), ledgerOf()).join()).toContain("impressions");
    }
  });

  it("revenue が負数・NaN・Infinity・文字列", () => {
    for (const rev of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
      expect(validateRevenue(make({ ...row, revenue: rev }), ledgerOf()).join()).toContain("revenue");
    }
  });

  it("(date, spotId) の重複", () => {
    expect(validateRevenue(make(row, { ...row }), ledgerOf()).join()).toContain("重複");
    // 日付が違えば可
    expect(validateRevenue(make(row, { ...row, date: "2026-11-13" }), ledgerOf())).toEqual([]);
  });

  it("掲載開始日より前 / 掲載終了日より後の実績", () => {
    expect(validateRevenue(make({ ...row, date: "2026-11-09" }), ledgerOf()).join()).toContain("掲載開始日より前");
    expect(validateRevenue(make({ ...row, date: "2026-11-21" }), ledgerOf("2026-11-20")).join()).toContain("掲載終了日より後");
  });
});

// ---- 掲載中の判定（mjs） ----

describe("isActivePlacement / getActivePlacement", () => {
  const open = { slug: "razor-comparison", start: "2026-11-10", end: null };
  const ended = { slug: "ended-comparison", start: "2026-11-01", end: "2026-11-05" };
  const placements = [open, ended] as never[];

  it("start == today は掲載中、start > today は掲載前", () => {
    expect(isActivePlacement(open, "2026-11-10")).toBe(true);
    expect(isActivePlacement(open, "2026-12-01")).toBe(true);
    expect(isActivePlacement(open, "2026-11-09")).toBe(false);
  });

  it("end がある行は掲載終了（end 当日以降も含めて掲載中ではない）", () => {
    expect(isActivePlacement(ended, "2026-11-03")).toBe(false);
    expect(isActivePlacement(ended, "2026-11-05")).toBe(false);
    expect(isActivePlacement(ended, "2026-11-30")).toBe(false);
  });

  it("getActivePlacement は掲載中の行を返し、別 slug・掲載前・終了済みは undefined", () => {
    expect(getActivePlacement("razor-comparison", "2026-11-10", placements)).toBe(open);
    expect(getActivePlacement("razor-comparison", "2026-11-09", placements)).toBeUndefined();
    expect(getActivePlacement("ended-comparison", "2026-11-03", placements)).toBeUndefined();
    expect(getActivePlacement("other-comparison", "2026-11-10", placements)).toBeUndefined();
  });

  it("AD_PLATFORMS は sp / pc", () => {
    expect([...AD_PLATFORMS].sort()).toEqual(["pc", "sp"]);
  });

  it("END_REASONS は計画書の5種", () => {
    expect([...END_REASONS].sort()).toEqual(["manual", "stop-cwv", "stop-search", "stop-send-rate", "stop-zero-send"].sort());
  });
});
