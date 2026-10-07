// GSC の searchAppearance（検索結果での見え方）別の集計・整形（純関数）
//
// scripts/search-appearance-check.mjs から呼ぶ。API 呼び出しは CLI 側だけが持ち、
// ここでは行の変換・商品スニペットのキー解決・page 別の突き合わせ・Markdown 整形を行う。
import { excludeFragmentPages } from "./gsc-pages.ts";
import { toPagePath } from "./weekly-snapshot.ts";

/** Search Analytics の生の行（keys は dimensions の順） */
export interface GscApiRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface AppearanceMetrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface KeyedRow extends AppearanceMetrics {
  key: string;
}

export interface PageRow extends AppearanceMetrics {
  page: string;
}

export interface SnippetPageRow {
  page: string;
  path: string;
  snippet: AppearanceMetrics;
  /** 同じ窓の page 次元の全体値。全体側に行が無いページは null */
  total: AppearanceMetrics | null;
  /** スニペット経由クリック / 全体クリック。全体が無い・0 なら null */
  clickShare: number | null;
}

function toMetrics(row: GscApiRow | undefined | null): AppearanceMetrics {
  return {
    clicks: Number(row?.clicks ?? 0),
    impressions: Number(row?.impressions ?? 0),
    ctr: Number(row?.ctr ?? 0),
    position: Number(row?.position ?? 0),
  };
}

/** dimensions:["date"] の行を resolveConfirmedDate が受ける { date }[] に変換する */
export function toDateRows(rows: readonly GscApiRow[]): Array<{ date: string }> {
  return (rows ?? []).map((row) => ({ date: row.keys?.[0] ?? "" }));
}

/** 1次元の行を { key, ...metrics } に変換する */
export function toKeyedRows(rows: readonly GscApiRow[]): KeyedRow[] {
  return (rows ?? []).map((row) => ({ key: row.keys?.[0] ?? "", ...toMetrics(row) }));
}

/** dimensions:["page"] の行を { page, ...metrics } に変換する */
export function toPageRows(rows: readonly GscApiRow[]): PageRow[] {
  return (rows ?? []).map((row) => ({ page: row.keys?.[0] ?? "", ...toMetrics(row) }));
}

/**
 * 見え方別の行から商品スニペットのキーを解決する。
 * キー名を決め打ちせず、返ってきたキーから PRODUCT_SNIPPET を含むものを選ぶ（複数なら表示の多い方）。
 * 見つからなければ null（呼び出し側で「商品スニペットの行なし」と明示する）。
 */
export function resolveProductSnippetKey(rows: readonly KeyedRow[]): string | null {
  const candidates = (rows ?? []).filter((row) => /PRODUCT_SNIPPET/i.test(row.key));
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.impressions > a.impressions ? b : a)).key;
}

/**
 * 商品スニペットの page 別行と、同じ窓の page 次元の全体行を突き合わせる。
 * 両方ともアンカー付き URL を除外し、スニペット側のクリック降順（同数は表示降順）で返す。
 */
export function joinSnippetPages(
  snippetRows: readonly PageRow[],
  totalRows: readonly PageRow[],
): { rows: SnippetPageRow[]; excludedSnippetRows: number; excludedTotalRows: number } {
  const snippet = excludeFragmentPages(snippetRows);
  const total = excludeFragmentPages(totalRows);
  const totalByPage = new Map(total.rows.map((row) => [row.page, row]));

  const rows = snippet.rows.map((row): SnippetPageRow => {
    const t = totalByPage.get(row.page);
    const totalMetrics = t ? toMetrics(t) : null;
    return {
      page: row.page,
      path: toPagePath(row.page),
      snippet: toMetrics(row),
      total: totalMetrics,
      clickShare: totalMetrics && totalMetrics.clicks > 0 ? row.clicks / totalMetrics.clicks : null,
    };
  });
  rows.sort((a, b) => b.snippet.clicks - a.snippet.clicks || b.snippet.impressions - a.snippet.impressions);

  return {
    rows,
    excludedSnippetRows: snippet.excludedCount,
    excludedTotalRows: total.excludedCount,
  };
}

export interface AppearanceReport {
  confirmedDate: string | null;
  window: { start: string; end: string; days: number };
  siteTotal: AppearanceMetrics;
  appearances: KeyedRow[];
  snippetKey: string | null;
  snippetPages: SnippetPageRow[];
  excludedSnippetRows: number;
  excludedTotalRows: number;
}

const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
const int = (v: number) => Math.round(v).toLocaleString("en-US");

/** レポートの Markdown。冒頭に確定日を書く（CLAUDE.md §5.0.2 データ取得ルール4） */
export function buildAppearanceMarkdown(report: AppearanceReport): string {
  const { window, siteTotal, snippetKey } = report;
  const lines: string[] = [];
  lines.push("# 検索での見え方別の実績（searchAppearance）");
  lines.push("");
  lines.push(`GSC の最新確定日は ${report.confirmedDate ?? "不明"}`);
  lines.push(`窓: ${window.start} 〜 ${window.end}（${window.days}日）`);
  lines.push("");
  lines.push("## サイト合計（dimensions: []）");
  lines.push("");
  lines.push("| クリック | 表示 | CTR | 平均順位 |");
  lines.push("|---:|---:|---:|---:|");
  lines.push(`| ${int(siteTotal.clicks)} | ${int(siteTotal.impressions)} | ${pct(siteTotal.ctr)} | ${siteTotal.position.toFixed(1)} |`);
  lines.push("");
  lines.push("## 見え方別");
  lines.push("");
  if (report.appearances.length === 0) {
    lines.push("見え方別の行なし");
  } else {
    lines.push("| 見え方 | クリック | 表示 | CTR | 平均順位 | クリック比（対サイト合計） |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const row of report.appearances) {
      const share = siteTotal.clicks > 0 ? row.clicks / siteTotal.clicks : null;
      lines.push(`| ${row.key} | ${int(row.clicks)} | ${int(row.impressions)} | ${pct(row.ctr)} | ${row.position.toFixed(1)} | ${pct(share)} |`);
    }
  }
  lines.push("");
  lines.push("## 商品スニペットが出たページ");
  lines.push("");
  if (snippetKey === null) {
    lines.push("商品スニペットの行なし（見え方別の結果に PRODUCT_SNIPPET を含むキーが無い）");
    return lines.join("\n") + "\n";
  }
  lines.push(`キー: \`${snippetKey}\` / ページ数: ${report.snippetPages.length}`);
  lines.push(`アンカー付き URL の除外: スニペット側 ${report.excludedSnippetRows} 行 / 全体側 ${report.excludedTotalRows} 行`);
  lines.push("");
  lines.push("| ページ | スニペット クリック | スニペット 表示 | スニペット CTR | 平均順位 | 全体クリック | 全体表示 | クリックのスニペット比 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of report.snippetPages) {
    const t = row.total;
    lines.push(
      `| ${row.path} | ${int(row.snippet.clicks)} | ${int(row.snippet.impressions)} | ${pct(row.snippet.ctr)} | ${row.snippet.position.toFixed(1)} | ${t ? int(t.clicks) : "-"} | ${t ? int(t.impressions) : "-"} | ${pct(row.clickShare)} |`,
    );
  }
  return lines.join("\n") + "\n";
}
