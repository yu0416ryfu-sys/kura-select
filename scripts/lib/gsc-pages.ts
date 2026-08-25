// GSC の `page` 次元の行に共通する前処理（純関数）
//
// scripts/weekly-snapshot.mjs / scripts/gsc-harvest.mjs の双方がここを import する。
// ページ単位の分析は「同じ取得法・同じ除外」で揃える必要があるため、実装をここ1か所に置く。
// 計画書: docs/IMPLEMENTATION_PLAN_GSC_HARVEST_BASELINE_P0_2026-08-25.md

/** GSC page 次元の最小形。clicks / ctr / position は呼び出し側の型に委ねる */
export interface GscPageLike {
  page?: string;
  impressions?: number;
}

/**
 * GSC の `page` 次元には見出しアンカー付き URL（`.../#見出し`）が別行として返る。
 * これは親ページの表示回数を二重計上している（2026-08-24 実測: 除外前の
 * ページ合計は表示 +27.2% / 除外後は +0.9%）。ページ単位の分析からは必ず外す。
 */
export function isFragmentPage(page: string): boolean {
  return page.includes("#");
}

/** アンカー付き URL を落とす。落とした行数・表示数も返す（レポート / meta に明記するため） */
export function excludeFragmentPages<T extends GscPageLike>(
  rows: readonly T[],
): { rows: T[]; excludedCount: number; excludedImpressions: number } {
  const kept: T[] = [];
  let excludedCount = 0;
  let excludedImpressions = 0;
  for (const row of rows ?? []) {
    if (row?.page && isFragmentPage(row.page)) {
      excludedCount += 1;
      // impressions 欠落時に NaN を出さないため明示的に 0 埋めする
      excludedImpressions += Number(row.impressions ?? 0);
      continue;
    }
    kept.push(row);
  }
  return { rows: kept, excludedCount, excludedImpressions };
}
