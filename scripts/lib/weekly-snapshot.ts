// 週次アクセス スナップショットの純関数群
//
// ページ行の前処理（アンカー付き URL の除外）は ./gsc-pages.ts に集約している。
//
// scripts/weekly-snapshot.mjs（CLI）と tests/weekly-snapshot.test.ts の双方がここを import する。
// テスト側でロジックを再実装しないこと。
//
// 目的: 「どの期間を、どの取得法で、どう正規化するか」の判断をコードに固定し、
// 週次分析のばらつき（CLAUDE.md §5.0.2 の3ルール違反）を構造的に防ぐ。

import { excludeFragmentPages, isFragmentPage } from "./gsc-pages.ts";

/** クリック実数がこの値未満の比較は判定に使わない（CLAUDE.md §10「実数一桁は判定しない」） */
export const JUDGEABLE_MIN_CLICKS = 10;

export interface Metrics {
  clicks: number;
  impressions: number;
  /** 0〜1 の比率 */
  ctr: number;
  position: number;
}

export interface PerDayMetrics extends Metrics {
  clicksPerDay: number;
  impressionsPerDay: number;
}

export interface SnapshotWindow {
  start: string;
  end: string;
  days: number;
}

export interface SnapshotWindows {
  current: SnapshotWindow;
  previous: SnapshotWindow;
  month: SnapshotWindow;
}

export interface PageMetricRow {
  page: string;
  clicks: number;
  impressions: number;
  ctr?: number;
  position?: number;
}

export interface PageComparison {
  page: string;
  pagePath: string;
  current: PerDayMetrics;
  previous: PerDayMetrics;
  /** 素の変化率（日次換算・%）。正規化前 */
  rawClicksPct: number | null;
  rawImpressionsPct: number | null;
  /** 同窓のサイト全体で正規化した変化率（%）。判定はこちらを見る */
  normalizedClicksPct: number | null;
  normalizedImpressionsPct: number | null;
  /** 順位の変化（負＝改善） */
  positionDelta: number | null;
  /** false のときはクリック実数が一桁のため判定に使わない */
  judgeable: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, label: string): void {
  if (!DATE_RE.test(value)) {
    throw new Error(`${label} は YYYY-MM-DD 形式で指定してください: ${value}`);
  }
}

/** YYYY-MM-DD に delta 日を足す（UTC 基準で計算するのでローカルTZに依存しない） */
export function addDays(date: string, delta: number): string {
  assertDate(date, "date");
  const ms = Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** start〜end の日数（両端を含む） */
export function countDays(start: string, end: string): number {
  assertDate(start, "start");
  assertDate(end, "end");
  const diff = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.floor(diff / 86_400_000) + 1;
}

/** 窓に含まれる日付を列挙する */
export function enumerateDates(window: SnapshotWindow): string[] {
  const dates: string[] = [];
  for (let i = 0; i < window.days; i += 1) dates.push(addDays(window.start, i));
  return dates;
}

/**
 * GSC の確定日を実測する（CLAUDE.md §5.0.2 ルール1）。
 * 未反映日は 0 ではなく行ごと欠落するため、返却行の最終日をそのまま確定日とする。
 */
export function resolveConfirmedDate(rows: Array<{ date: string }>): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (!row?.date || !DATE_RE.test(row.date)) continue;
    if (latest === null || row.date > latest) latest = row.date;
  }
  return latest;
}

/** 確定日を終端とする「今週 / 前週 / 直近28日」の窓を作る */
export function buildWindows(
  confirmedDate: string,
  weekDays = 7,
  monthDays = 28,
): SnapshotWindows {
  assertDate(confirmedDate, "confirmedDate");
  if (!Number.isInteger(weekDays) || weekDays < 1) {
    throw new Error(`weekDays が不正です: ${weekDays}`);
  }
  if (!Number.isInteger(monthDays) || monthDays < weekDays) {
    throw new Error(`monthDays が不正です: ${monthDays}`);
  }

  const currentStart = addDays(confirmedDate, -(weekDays - 1));
  const previousEnd = addDays(currentStart, -1);
  const previousStart = addDays(previousEnd, -(weekDays - 1));

  return {
    current: { start: currentStart, end: confirmedDate, days: weekDays },
    previous: { start: previousStart, end: previousEnd, days: weekDays },
    month: {
      start: addDays(confirmedDate, -(monthDays - 1)),
      end: confirmedDate,
      days: monthDays,
    },
  };
}

/** 窓のうち GSC が行を返さなかった日（＝未反映日）を返す */
export function findMissingDates(
  rows: Array<{ date: string }>,
  window: SnapshotWindow,
): string[] {
  const present = new Set(rows.map((row) => row.date));
  return enumerateDates(window).filter((date) => !present.has(date));
}

/** GSC の応答行を Metrics に正規化する */
export function toMetrics(row: Partial<Metrics> | undefined | null): Metrics {
  return {
    clicks: Number(row?.clicks ?? 0),
    impressions: Number(row?.impressions ?? 0),
    ctr: Number(row?.ctr ?? 0),
    position: Number(row?.position ?? 0),
  };
}

/** 窓の日数で割った日次値を足す */
export function toPerDay(metrics: Metrics, days: number): PerDayMetrics {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`days が不正です: ${days}`);
  }
  return {
    ...metrics,
    clicksPerDay: metrics.clicks / days,
    impressionsPerDay: metrics.impressions / days,
  };
}

/** 変化率（%）。前期がゼロなら判定不能として null を返す */
export function changePct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * 同窓のサイト全体で正規化した変化率（%）を返す。
 * （記事の前週比 ÷ サイト全体の前週比 − 1）。メモリ feedback_measurement_window_rule。
 */
export function normalizedChangePct(
  currentValue: number,
  previousValue: number,
  siteCurrentValue: number,
  sitePreviousValue: number,
): number | null {
  if (previousValue === 0 || sitePreviousValue === 0 || siteCurrentValue === 0) {
    return null;
  }
  const articleRatio = currentValue / previousValue;
  const siteRatio = siteCurrentValue / sitePreviousValue;
  if (!Number.isFinite(articleRatio) || !Number.isFinite(siteRatio) || siteRatio === 0) {
    return null;
  }
  return (articleRatio / siteRatio - 1) * 100;
}

/** URL のパス部分だけ取り出す（レポート表示用） */
export function toPagePath(page: string): string {
  try {
    return new URL(page).pathname;
  } catch {
    return page;
  }
}

// アンカー付き URL の除外は gsc-harvest 側の baseline 生成とも共有するため
// ./gsc-pages.ts に移した。既存の import 元（scripts/weekly-snapshot.mjs /
// tests/weekly-snapshot.test.ts）を壊さないよう、ここから再 export する。
export { excludeFragmentPages, isFragmentPage };

function indexPages(rows: PageMetricRow[]): Map<string, PageMetricRow> {
  const map = new Map<string, PageMetricRow>();
  for (const row of rows) {
    if (!row?.page) continue;
    map.set(row.page, row);
  }
  return map;
}

/**
 * ページ別の今週 vs 前週を、日次換算＋サイト全体正規化つきで比較する。
 * 並びは「今週の表示回数の多い順」で固定する（毎回同じ順序にするため）。
 */
export function comparePages(
  currentRows: PageMetricRow[],
  previousRows: PageMetricRow[],
  siteCurrent: PerDayMetrics,
  sitePrevious: PerDayMetrics,
  windows: { current: SnapshotWindow; previous: SnapshotWindow },
): PageComparison[] {
  // アンカー付き URL は親ページの二重計上なので比較から外す
  const currentMap = indexPages(excludeFragmentPages(currentRows).rows);
  const previousMap = indexPages(excludeFragmentPages(previousRows).rows);
  const pages = new Set([...currentMap.keys(), ...previousMap.keys()]);

  const comparisons: PageComparison[] = [];
  for (const page of pages) {
    const current = toPerDay(toMetrics(currentMap.get(page)), windows.current.days);
    const previous = toPerDay(toMetrics(previousMap.get(page)), windows.previous.days);

    comparisons.push({
      page,
      pagePath: toPagePath(page),
      current,
      previous,
      rawClicksPct: changePct(current.clicksPerDay, previous.clicksPerDay),
      rawImpressionsPct: changePct(current.impressionsPerDay, previous.impressionsPerDay),
      normalizedClicksPct: normalizedChangePct(
        current.clicksPerDay,
        previous.clicksPerDay,
        siteCurrent.clicksPerDay,
        sitePrevious.clicksPerDay,
      ),
      normalizedImpressionsPct: normalizedChangePct(
        current.impressionsPerDay,
        previous.impressionsPerDay,
        siteCurrent.impressionsPerDay,
        sitePrevious.impressionsPerDay,
      ),
      positionDelta:
        current.position > 0 && previous.position > 0
          ? current.position - previous.position
          : null,
      judgeable: Math.max(current.clicks, previous.clicks) >= JUDGEABLE_MIN_CLICKS,
    });
  }

  return comparisons.sort(
    (a, b) =>
      b.current.impressions - a.current.impressions ||
      b.current.clicks - a.current.clicks ||
      a.page.localeCompare(b.page),
  );
}

/** 表示用の数値整形 */
export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "判定不能";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function windowLabel(window: SnapshotWindow): string {
  return `${window.start} 〜 ${window.end}（${window.days}日）`;
}

export interface SnapshotForDigest {
  generatedAt: string;
  confirmedDate: string;
  lagDays: number;
  windows: SnapshotWindows;
  gsc: {
    siteTotals: {
      current: PerDayMetrics;
      previous: PerDayMetrics;
      month: PerDayMetrics;
    };
    missingDates: string[];
    pages: PageComparison[];
    /** アンカー付き URL として除外した行数（表示の二重計上分） */
    fragmentRowsExcluded?: { current: number; previous: number };
    topQueries: Array<{
      query: string;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>;
  };
  ga4: {
    available: boolean;
    error?: string;
    window?: SnapshotWindow;
    siteTotals?: {
      current: Record<string, number>;
      previous: Record<string, number>;
    };
    channels?: Array<{ channel: string; sessions: number; previousSessions: number }>;
    outbound?: Array<{ eventName: string; current: number; previous: number }>;
    placements?: Array<{ placement: string; current: number; previous: number }>;
    placementDevices?: Array<{
      placement: string;
      device: string;
      current: number;
      previous: number;
    }>;
  };
  bing: {
    available: boolean;
    error?: string;
    current?: { clicks: number; impressions: number };
    previous?: { clicks: number; impressions: number };
    missingDates?: string[];
  };
}

/**
 * AI が読む用のダイジェスト Markdown。
 * 生 JSON は大きいので、判定に必要な行だけをここで固定順に並べる。
 */
export function buildDigest(
  snapshot: SnapshotForDigest,
  options: { topPages?: number; topQueries?: number } = {},
): string {
  const topPages = options.topPages ?? 20;
  const topQueries = options.topQueries ?? 20;
  const { gsc, ga4, bing, windows } = snapshot;
  const lines: string[] = [];

  lines.push("# 週次アクセス スナップショット");
  lines.push("");
  lines.push(
    `**GSC の最新確定日: ${snapshot.confirmedDate}**（実測 / 遅延 ${snapshot.lagDays} 日）`,
  );
  lines.push("");
  lines.push(`- 取得時刻: ${snapshot.generatedAt}`);
  lines.push(`- 今週窓: ${windowLabel(windows.current)}`);
  lines.push(`- 前週窓: ${windowLabel(windows.previous)}`);
  lines.push(`- 直近28日窓: ${windowLabel(windows.month)}`);
  lines.push(
    `- 未反映日（GSC が行を返さなかった日）: ${
      gsc.missingDates.length === 0 ? "なし" : gsc.missingDates.join(", ")
    }`,
  );
  lines.push("");
  lines.push(
    '> サイト全体は `dimensions: []`、ページ別は `dimensions:["page"]` で別々に取得している。' +
      "次元の行を足し上げてサイト合計にしないこと（CLAUDE.md §5.0.2 ルール2）。",
  );
  lines.push("");

  lines.push("## 1. サイト全体（GSC・`dimensions: []`）");
  lines.push("");
  lines.push("| 窓 | クリック | クリック/日 | 表示 | 表示/日 | CTR | 平均順位 |");
  lines.push("|---|---|---|---|---|---|---|");
  const totalRows: Array<[string, PerDayMetrics]> = [
    ["今週", gsc.siteTotals.current],
    ["前週", gsc.siteTotals.previous],
    ["直近28日", gsc.siteTotals.month],
  ];
  for (const [label, m] of totalRows) {
    lines.push(
      `| ${label} | ${m.clicks} | ${fmt(m.clicksPerDay, 2)} | ${m.impressions} | ${fmt(
        m.impressionsPerDay,
        1,
      )} | ${fmt(m.ctr * 100, 2)}% | ${fmt(m.position, 1)} |`,
    );
  }
  lines.push("");
  const clicksNorm = changePct(
    gsc.siteTotals.current.clicksPerDay,
    gsc.siteTotals.previous.clicksPerDay,
  );
  const imprNorm = changePct(
    gsc.siteTotals.current.impressionsPerDay,
    gsc.siteTotals.previous.impressionsPerDay,
  );
  lines.push(
    `**正規化子（前週比・日次）: クリック ${fmtPct(clicksNorm)} / 表示 ${fmtPct(imprNorm)}**` +
      " — ページ別の正規化はこの値で計算済み。",
  );
  lines.push("");

  lines.push(`## 2. ページ別 今週 vs 前週（表示の多い順・上位 ${topPages}）`);
  lines.push("");
  if (gsc.fragmentRowsExcluded) {
    lines.push(
      "> 見出しアンカー付き URL（`#...`）は親ページの二重計上なので除外済み" +
        `（今週 ${gsc.fragmentRowsExcluded.current} 行 / 前週 ${gsc.fragmentRowsExcluded.previous} 行）。`,
    );
    lines.push("");
  }
  lines.push(
    "| ページ | 表示/日(今→前) | クリック(今/前) | 正規化クリック | 正規化表示 | 順位(今→前) | 判定可 |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const page of gsc.pages.slice(0, topPages)) {
    lines.push(
      `| ${page.pagePath} | ${fmt(page.current.impressionsPerDay)} → ${fmt(
        page.previous.impressionsPerDay,
      )} | ${page.current.clicks} / ${page.previous.clicks} | ${fmtPct(
        page.normalizedClicksPct,
      )} | ${fmtPct(page.normalizedImpressionsPct)} | ${fmt(page.current.position)} → ${fmt(
        page.previous.position,
      )} | ${page.judgeable ? "○" : "×(実数一桁)"} |`,
    );
  }
  lines.push("");
  lines.push(
    `判定可（今週または前週のクリックが ${JUDGEABLE_MIN_CLICKS} 以上）: ` +
      `${gsc.pages.filter((p) => p.judgeable).length} / ${gsc.pages.length} ページ`,
  );
  lines.push("");

  lines.push(`## 3. 上位クエリ（直近28日・クリック順・上位 ${topQueries}）`);
  lines.push("");
  lines.push("| クエリ | クリック | 表示 | CTR | 順位 |");
  lines.push("|---|---|---|---|---|");
  for (const row of gsc.topQueries.slice(0, topQueries)) {
    lines.push(
      `| ${row.query} | ${row.clicks} | ${row.impressions} | ${fmt(row.ctr * 100, 2)}% | ${fmt(
        row.position,
      )} |`,
    );
  }
  lines.push("");

  lines.push("## 4. GA4");
  lines.push("");
  if (!ga4.available) {
    lines.push(`⚠️ 取得できなかった: ${ga4.error ?? "理由不明"}`);
    lines.push("");
  } else {
    lines.push(
      `- 窓は GSC と同一（${windowLabel(ga4.window ?? windows.current)} / 前週も同幅）`,
    );
    lines.push("");
    lines.push("| 指標 | 今週 | 前週 | 変化 |");
    lines.push("|---|---|---|---|");
    const current = ga4.siteTotals?.current ?? {};
    const previous = ga4.siteTotals?.previous ?? {};
    for (const key of Object.keys(current)) {
      lines.push(
        `| ${key} | ${fmt(current[key], 2)} | ${fmt(previous[key], 2)} | ${fmtPct(
          changePct(current[key], previous[key] ?? 0),
        )} |`,
      );
    }
    lines.push("");
    if (ga4.outbound && ga4.outbound.length > 0) {
      lines.push("### 送客イベント（今週 / 前週）");
      lines.push("");
      lines.push("| イベント | 今週 | 前週 | 変化 |");
      lines.push("|---|---|---|---|");
      for (const row of ga4.outbound) {
        lines.push(
          `| ${row.eventName} | ${row.current} | ${row.previous} | ${fmtPct(
            changePct(row.current, row.previous),
          )} |`,
        );
      }
      lines.push("");
    }
    if (ga4.placements && ga4.placements.length > 0) {
      lines.push("### placement 別（送客イベント限定）");
      lines.push("");
      lines.push("| placement | 今週 | 前週 |");
      lines.push("|---|---|---|");
      for (const row of ga4.placements) {
        lines.push(`| ${row.placement} | ${row.current} | ${row.previous} |`);
      }
      lines.push("");
    }
    if (ga4.placementDevices && ga4.placementDevices.length > 0) {
      lines.push("### placement × デバイス（StickyCta のデスクトップ判定用）");
      lines.push("");
      lines.push("| placement | デバイス | 今週 | 前週 |");
      lines.push("|---|---|---|---|");
      for (const row of ga4.placementDevices) {
        lines.push(
          `| ${row.placement} | ${row.device} | ${row.current} | ${row.previous} |`,
        );
      }
      lines.push("");
    }
    if (ga4.channels && ga4.channels.length > 0) {
      lines.push("### チャネル別セッション");
      lines.push("");
      lines.push("| チャネル | 今週 | 前週 |");
      lines.push("|---|---|---|");
      for (const row of ga4.channels) {
        lines.push(`| ${row.channel} | ${row.sessions} | ${row.previousSessions} |`);
      }
      lines.push("");
    }
  }

  lines.push("## 5. Bing");
  lines.push("");
  if (!bing.available) {
    lines.push(`⚠️ 取得できなかった: ${bing.error ?? "理由不明"}`);
    lines.push("");
  } else {
    lines.push("| 窓 | クリック | 表示 |");
    lines.push("|---|---|---|");
    lines.push(`| 今週 | ${bing.current?.clicks ?? 0} | ${bing.current?.impressions ?? 0} |`);
    lines.push(`| 前週 | ${bing.previous?.clicks ?? 0} | ${bing.previous?.impressions ?? 0} |`);
    lines.push("");
    if (bing.missingDates && bing.missingDates.length > 0) {
      lines.push(`未反映日: ${bing.missingDates.join(", ")}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("生データ（ページ別・クエリ別の全行）は同じディレクトリの `snapshot-*.json` にある。");
  lines.push("");

  return lines.join("\n");
}
