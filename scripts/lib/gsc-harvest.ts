// GSC「あと一歩クエリ」刈り取り（Harvest）の分類ロジック（純関数）
//
// scripts/gsc-harvest.mjs（CLI）と tests/gsc-harvest.test.ts の双方がここを import する。
// テスト側でロジックを再実装しないこと。
// 計画書: docs/IMPLEMENTATION_PLAN_GSC_HARVEST_2026-08-07.md

export type HarvestBand = "A" | "B" | "C";

export interface GscQueryRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  /** 0〜1 の比率 */
  ctr: number;
  position: number;
}

export interface HarvestOptions {
  /** 候補に載せる最小表示回数（既定 15） */
  minImpressions?: number;
}

export interface ClassifiedRow extends GscQueryRow {
  band: HarvestBand;
  /** ページURLのパス部分（レポート表示用） */
  pagePath: string;
}

export interface PageSummary {
  page: string;
  pagePath: string;
  band: HarvestBand;
  queryCount: number;
  impressions: number;
  clicks: number;
  rows: ClassifiedRow[];
}

export interface CannibalGroup {
  query: string;
  impressions: number;
  clicks: number;
  pages: Array<{
    page: string;
    pagePath: string;
    impressions: number;
    clicks: number;
    position: number;
  }>;
}

export const DEFAULT_MIN_IMPRESSIONS = 15;
export const DEFAULT_CANNIBAL_MIN_IMPRESSIONS = 10;

/** 帯の境界（半開区間 [min, max)。C のみ 30 を含む） */
export const BAND_RANGES: Record<
  HarvestBand,
  { min: number; max: number; label: string; diagnosis: string; action: string }
> = {
  A: {
    min: 8,
    max: 12,
    label: "A: 惜しい",
    diagnosis: "内容は適合。あと1〜3位",
    action: "見出しでクエリを直接受ける／内部リンク集約",
  },
  B: {
    min: 12,
    max: 20,
    label: "B: 中位停滞",
    diagnosis: "情報量・網羅性が不足",
    action: "商品数・比較軸・FAQ の追加",
  },
  C: {
    min: 20,
    max: 30,
    label: "C: 圏外",
    diagnosis: "意図ミスマッチ or カニバリ",
    action: "別記事化 or 統合判断",
  },
};

const BAND_ORDER: HarvestBand[] = ["A", "B", "C"];

/** 順位から帯を判定する。対象外なら null。 */
export function classifyPosition(position: number): HarvestBand | null {
  if (!Number.isFinite(position)) return null;
  for (const band of BAND_ORDER) {
    const { min, max } = BAND_RANGES[band];
    if (position >= min && position < max) return band;
  }
  // C の上端 30 は含める
  if (position === BAND_RANGES.C.max) return "C";
  return null;
}

/** URL からパス部分だけを取り出す（レポートを読みやすくするため） */
export function toPagePath(page: string): string {
  try {
    return new URL(page).pathname;
  } catch {
    return page;
  }
}

/** 1行を分類する。候補外なら null。 */
export function classifyRow(
  row: GscQueryRow,
  options: HarvestOptions = {},
): ClassifiedRow | null {
  const minImpressions = options.minImpressions ?? DEFAULT_MIN_IMPRESSIONS;
  if (row.impressions < minImpressions) return null;
  const band = classifyPosition(row.position);
  if (!band) return null;
  return { ...row, band, pagePath: toPagePath(row.page) };
}

/** 全行を分類する（表示回数の多い順） */
export function classifyRows(
  rows: GscQueryRow[],
  options: HarvestOptions = {},
): ClassifiedRow[] {
  return rows
    .map((row) => classifyRow(row, options))
    .filter((row): row is ClassifiedRow => row !== null)
    .sort((a, b) => b.impressions - a.impressions);
}

/**
 * ページ単位に集約する。ページの帯は「最も表示の多い帯」ではなく
 * 「最も上位の帯（A > B > C）」を採る（打ち手が上位帯に引きずられるのを避けるため
 * ではなく、まず A から手を付けるという運用に合わせる）。
 */
export function summarizeByPage(rows: ClassifiedRow[]): PageSummary[] {
  const map = new Map<string, PageSummary>();

  for (const row of rows) {
    const existing = map.get(row.page);
    if (existing) {
      existing.queryCount += 1;
      existing.impressions += row.impressions;
      existing.clicks += row.clicks;
      existing.rows.push(row);
      if (BAND_ORDER.indexOf(row.band) < BAND_ORDER.indexOf(existing.band)) {
        existing.band = row.band;
      }
      continue;
    }
    map.set(row.page, {
      page: row.page,
      pagePath: row.pagePath,
      band: row.band,
      queryCount: 1,
      impressions: row.impressions,
      clicks: row.clicks,
      rows: [row],
    });
  }

  const summaries = [...map.values()];
  for (const summary of summaries) {
    summary.rows.sort((a, b) => b.impressions - a.impressions);
  }
  return summaries.sort((a, b) => b.impressions - a.impressions);
}

/**
 * D: カニバリ検出。同一クエリで自サイトの2URL以上が出ているものを返す。
 * 分類（A〜C）の閾値とは独立に、生の全行から検出する。
 */
export function detectCannibalization(
  rows: GscQueryRow[],
  options: { minTotalImpressions?: number } = {},
): CannibalGroup[] {
  const minTotal =
    options.minTotalImpressions ?? DEFAULT_CANNIBAL_MIN_IMPRESSIONS;
  const byQuery = new Map<string, GscQueryRow[]>();

  for (const row of rows) {
    const list = byQuery.get(row.query);
    if (list) list.push(row);
    else byQuery.set(row.query, [row]);
  }

  const groups: CannibalGroup[] = [];
  for (const [query, list] of byQuery) {
    const pages = new Map<string, { impressions: number; clicks: number; position: number }>();
    for (const row of list) {
      const existing = pages.get(row.page);
      if (existing) {
        existing.impressions += row.impressions;
        existing.clicks += row.clicks;
        existing.position = Math.min(existing.position, row.position);
      } else {
        pages.set(row.page, {
          impressions: row.impressions,
          clicks: row.clicks,
          position: row.position,
        });
      }
    }
    if (pages.size < 2) continue;

    const impressions = list.reduce((sum, row) => sum + row.impressions, 0);
    if (impressions < minTotal) continue;

    groups.push({
      query,
      impressions,
      clicks: list.reduce((sum, row) => sum + row.clicks, 0),
      pages: [...pages.entries()]
        .map(([page, stats]) => ({ page, pagePath: toPagePath(page), ...stats }))
        .sort((a, b) => a.position - b.position),
    });
  }

  return groups.sort((a, b) => b.impressions - a.impressions);
}

function formatPercent(ctr: number): string {
  return `${(Math.round(ctr * 10000) / 100).toFixed(2)}%`;
}

function formatPosition(position: number): string {
  return (Math.round(position * 10) / 10).toFixed(1);
}

export interface HarvestMeta {
  startDate: string;
  endDate: string;
  fetchedAt: string;
  /** 実行日 YYYY-MM-DD（ファイル名の基準） */
  runDate: string;
  minImpressions: number;
  totalRows: number;
}

/** ページ単位の刈り取りレポート（Markdown）を組み立てる */
export function buildHarvestReport(
  meta: HarvestMeta,
  pages: PageSummary[],
  cannibals: CannibalGroup[],
): string {
  const lines: string[] = [];

  lines.push("# GSC 刈り取り候補レポート");
  lines.push("");
  lines.push(`実行日: ${meta.runDate}`);
  lines.push(`データ期間: ${meta.startDate} 〜 ${meta.endDate}`);
  lines.push(`取得時刻: ${meta.fetchedAt}`);
  lines.push(`取得行数: ${meta.totalRows} 行`);
  lines.push(`最小表示回数: ${meta.minImpressions}`);
  lines.push("");

  const bandCount = (band: HarvestBand) =>
    pages.reduce(
      (sum, page) => sum + page.rows.filter((row) => row.band === band).length,
      0,
    );
  lines.push(
    `候補ページ: ${pages.length} 件 / 候補クエリ: ${pages.reduce((sum, p) => sum + p.queryCount, 0)} 件` +
      `（A: ${bandCount("A")} / B: ${bandCount("B")} / C: ${bandCount("C")}）`,
  );
  lines.push(`カニバリ候補クエリ: ${cannibals.length} 件`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("# 候補ページ（表示回数の多い順）");
  lines.push("");

  if (pages.length === 0) {
    lines.push("該当なし");
    lines.push("");
  }

  for (const page of pages) {
    const range = BAND_RANGES[page.band];
    lines.push(
      `## ${page.pagePath}（${range.label} / 表示 ${page.impressions} / クリック ${page.clicks} / 対象 ${page.queryCount} クエリ）`,
    );
    lines.push("");
    lines.push(`- 診断: ${range.diagnosis}`);
    lines.push(`- 打ち手: ${range.action}`);
    lines.push("");
    lines.push("| 帯 | クエリ | 表示 | クリック | CTR | 順位 |");
    lines.push("|---|---|---|---|---|---|");
    for (const row of page.rows) {
      lines.push(
        `| ${row.band} | ${row.query} | ${row.impressions} | ${row.clicks} | ${formatPercent(row.ctr)} | ${formatPosition(row.position)} |`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("# D: カニバリ候補（同一クエリで自サイト2URL以上）");
  lines.push("");

  if (cannibals.length === 0) {
    lines.push("該当なし");
    lines.push("");
  }

  for (const group of cannibals) {
    lines.push(
      `## ${group.query}（合計表示 ${group.impressions} / クリック ${group.clicks}）`,
    );
    lines.push("");
    lines.push("| ページ | 表示 | クリック | 順位 |");
    lines.push("|---|---|---|---|");
    for (const page of group.pages) {
      lines.push(
        `| ${page.pagePath} | ${page.impressions} | ${page.clicks} | ${formatPosition(page.position)} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
