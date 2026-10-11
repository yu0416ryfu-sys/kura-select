// 価格レポートのページ表示用の変換（集計済み JSON → グラフ・表の形）。純粋関数のみ。

export interface IndexMonth {
  month: string;
  index: number | null;
  pairs: number;
}

export interface IndexPartial {
  month: string;
  through: string;
  index: number | null;
  pairs: number;
}

export interface ViewPoint {
  x: string;
  y: number | null;
}

/** "2026-07" → "7月" */
export function monthLabel(month: string): string {
  return `${Number(month.slice(5, 7))}月`;
}

/** 途中経過の月のラベル: "10月（11日まで）" */
export function partialLabel(p: { month: string; through: string }): string {
  return `${monthLabel(p.month)}（${Number(p.through.slice(8, 10))}日まで）`;
}

export function toPoints(months: readonly IndexMonth[]): ViewPoint[] {
  return months.map((m) => ({ x: monthLabel(m.month), y: m.index }));
}

export function toPartialPoint(p: IndexPartial | null | undefined): ViewPoint | null {
  if (!p || p.index == null) return null;
  return { x: partialLabel(p), y: p.index };
}

/** x 軸の並び（本線の月＋途中経過があればその月） */
export function xLabelsOf(months: readonly IndexMonth[], partial: IndexPartial | null | undefined): string[] {
  const labels = months.map((m) => monthLabel(m.month));
  if (partial && partial.index != null) labels.push(partialLabel(partial));
  return labels;
}

/** CPI の値を基準月＝100 に置き直す（当サイトの指数と同じ基準にそろえて並べるため） */
export function rebase(values: Readonly<Record<string, number>>, baseMonth: string): Record<string, number> {
  const base = values[baseMonth];
  if (!(base > 0)) throw new Error(`CPI に基準月 ${baseMonth} の値がありません`);
  const out: Record<string, number> = {};
  for (const [m, v] of Object.entries(values)) {
    if (m < baseMonth) continue;
    out[m] = Math.round((v / base) * 1000) / 10;
  }
  return out;
}

/** 基準月からの変化率（%）。小数1桁 */
export function changePct(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !(from > 0)) return null;
  return Math.round((to / from - 1) * 1000) / 10;
}
