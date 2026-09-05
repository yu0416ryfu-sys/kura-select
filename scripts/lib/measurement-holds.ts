// 測定凍結台帳（data/measurement-holds.json）の読み取り。
//
// 元は scripts/check-internal-links.mjs にインラインで書かれていたものを、
// check-genre-fit.mjs からも使うために切り出した。
// frozenSlugs / available は切り出し前と同一の挙動。releaseDateBySlug は新規。
//
// ⚠️ 機械が読むのは holds[].slug / holds[].slugs / holds[].releaseDate の3つだけ。
// prohibitions は読まない（範囲が限定的な商品追加禁止であり記事編集の凍結ではない）。
// 台帳の唯一の正はメモリ project_measurement_holds なので、実施前に必ずそちらを確認すること。
import { readFileSync, existsSync } from 'fs';

export interface HoldsLookup {
  /** 凍結中の slug */
  frozenSlugs: Set<string>;
  /** slug → releaseDate（この日から編集してよい日）。期限なし凍結の slug は含まない */
  releaseDateBySlug: Map<string, string>;
  /** 台帳ファイルを読めたか。false ならレポートに「凍結判定なし」と明記する */
  available: boolean;
}

function emptyLookup(available: boolean): HoldsLookup {
  return { frozenSlugs: new Set<string>(), releaseDateBySlug: new Map<string, string>(), available };
}

/** レポート名・判定は JST の日付で行う（UTC だと日本時間の午前中に前日付になる） */
export function todayJst(): string {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

/**
 * 凍結台帳を読む。未整備・壊れた JSON なら available:false で動かす（例外は投げない）。
 *
 * releaseDate の扱い（計画書 §3.6 の決定表）:
 * - 同じ slug が複数行 → 最も遅い releaseDate を採る（早いほうだと凍結中を「着手可」と誤表示する）
 * - releaseDate を持たない行（期限なし凍結） → frozenSlugs には入れるが releaseDateBySlug には入れない
 * - 期限なし行と期限あり行が併存 → 期限なしを優先し releaseDateBySlug から除外する
 */
export function loadHolds(holdsPath: string, today: string = todayJst()): HoldsLookup {
  if (!existsSync(holdsPath)) return emptyLookup(false);
  try {
    const parsed = JSON.parse(readFileSync(holdsPath, 'utf-8')) as unknown;
    const rows: Array<Record<string, unknown>> = Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : (((parsed as { holds?: unknown })?.holds ?? []) as Array<Record<string, unknown>>);

    const frozenSlugs = new Set<string>();
    const releaseDateBySlug = new Map<string, string>();
    const openEnded = new Set<string>();

    for (const row of rows) {
      const releaseDate = row.releaseDate == null ? null : String(row.releaseDate);
      if (releaseDate && !(releaseDate > today)) continue;   // 解除済み

      const slugs = (Array.isArray(row.slugs) ? row.slugs : [row.slug])
        .filter(Boolean)
        .map(String);

      for (const slug of slugs) {
        frozenSlugs.add(slug);
        if (!releaseDate) {
          openEnded.add(slug);
          releaseDateBySlug.delete(slug);
          continue;
        }
        if (openEnded.has(slug)) continue;
        const current = releaseDateBySlug.get(slug);
        if (!current || releaseDate > current) releaseDateBySlug.set(slug, releaseDate);
      }
    }

    return { frozenSlugs, releaseDateBySlug, available: true };
  } catch (error) {
    console.error(`${holdsPath} の読み込みに失敗: ${error instanceof Error ? error.message : error}`);
    return emptyLookup(false);
  }
}
