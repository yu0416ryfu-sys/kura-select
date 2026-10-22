// 第1号の集計 CSV（月×グループの指数と比較系列数のみ。生の価格は出さない）。計画書6 §3.3
import type { APIRoute } from "astro";
import report from "../../../../data/price-report/2026-10-11.json";

const esc = (v: string | number | null) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const GET: APIRoute = () => {
  const lines: string[] = [
    "provider,group_id,group_label,month,is_partial,through,index_2026_05_eq_100,pairs,capture_days",
  ];
  for (const p of report.providers) {
    const rows = [
      { id: "all", label: "全体", months: p.index.months, partial: p.index.partial },
      ...p.groups.map((g) => ({ id: g.id, label: g.label, months: g.months, partial: g.partial })),
    ];
    for (const r of rows) {
      for (const m of r.months) {
        lines.push([p.provider, r.id, r.label, m.month, "0", "", m.index, m.pairs, m.captureDays].map(esc).join(","));
      }
      if (r.partial) {
        const q = r.partial;
        lines.push([p.provider, r.id, r.label, q.month, "1", q.through, q.index, q.pairs, q.captureDays].map(esc).join(","));
      }
    }
  }
  // Excel で文字化けしないよう BOM を付ける
  return new Response("﻿" + lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8" },
  });
};
