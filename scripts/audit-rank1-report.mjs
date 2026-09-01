// audit-rank1 の JSON から Markdown 表を作る
// 使い方: node scripts/audit-rank1-report.mjs [reports/rank1-audit/rank1-audit-<日付>.json]
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'reports/rank1-audit');

const arg = process.argv[2];
const jsonPath = arg
  ? path.resolve(ROOT, arg)
  : path.join(DIR, readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().pop());
const { today, results } = JSON.parse(readFileSync(jsonPath, 'utf-8'));

/** 比較用に同系単位へ寄せる（kg→g / L→mL、大文字小文字の揺れも吸収） */
function norm(total) {
  if (!total || !Number.isFinite(total.total) || total.total <= 0) return null;
  const u = String(total.unit).trim().toLowerCase();
  if (u === 'kg') return { total: total.total * 1000, unit: 'g' };
  if (u === 'g') return { total: total.total, unit: 'g' };
  if (u === 'l') return { total: total.total * 1000, unit: 'ml' };
  if (u === 'ml') return { total: total.total, unit: 'ml' };
  return { total: total.total, unit: u };
}
// 単位の大文字小文字違いだけの誤検知を潰すため、verdict をここで計算し直す
for (const r of results) {
  if (r.status !== 'found') continue;
  const a = norm(r.capacityTotals?.article);
  const b = norm(r.capacityTotals?.api);
  r.capacityVerdict = !a || !b
    ? 'unknown'
    : a.unit !== b.unit
      ? 'unit-diff'
      : Math.abs(a.total - b.total) < Math.max(0.01, a.total * 0.005)
        ? 'match'
        : 'mismatch';
}

const mark = (v) => (v ? '○' : '×');
const linkVerdict = (r) =>
  r.status === 'found' ? (r.nameMatch ? '○' : '× 別商品') : r.status === 'not-found' ? '× 取得不可' : '× ' + r.status;
const priceVerdict = (r) => {
  if (r.status !== 'found') return '-';
  if (r.priceDiff === null) return '?';
  if (r.priceDiff === 0) return '○';
  const pct = r.price ? Math.round((r.priceDiff / r.price) * 1000) / 10 : null;
  return (r.priceDiff > 0 ? '+' : '') + r.priceDiff + '円' + (pct === null ? '' : ' (' + (pct > 0 ? '+' : '') + pct + '%)');
};
const capVerdict = (r) => {
  if (r.status !== 'found') return '-';
  return { match: '○', mismatch: '× 数量不一致', 'unit-diff': '△ 単位違い', unknown: '判定不能' }[r.capacityVerdict] ?? r.capacityVerdict;
};
const fitVerdict = (r) => {
  if (r.status !== 'found') return '-';
  return { ok: '○', warn: '△ ' + (r.fitCode ?? ''), error: '× ' + (r.fitCode ?? ''), unknown: '判定不能' }[r.fitSeverity] ?? String(r.fitSeverity);
};

const problem = (r) =>
  r.status !== 'found' ||
  !r.nameMatch ||
  (r.priceDiff !== null && r.priceDiff !== 0) ||
  ['mismatch', 'unit-diff'].includes(r.capacityVerdict) ||
  r.fitSeverity === 'error' ||
  r.fitSeverity === 'warn';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');

const lines = [];
lines.push('# 1位商品の実地照合レポート（' + today + '）');
lines.push('');
lines.push('- データ元: 楽天市場 Search API（記事の rakutenUrl から shopCode/itemCode を取り出し、その実商品と照合）');
lines.push('- 対象: comparison 記事 ' + results.length + ' 本の rank 1 商品');
lines.push('');

const found = results.filter((r) => r.status === 'found');
const counts = {
  取得不可: results.filter((r) => r.status !== 'found').length,
  商品名不一致: found.filter((r) => !r.nameMatch).length,
  価格ズレ: found.filter((r) => r.priceDiff !== null && r.priceDiff !== 0).length,
  数量不一致: found.filter((r) => r.capacityVerdict === 'mismatch').length,
  単位違い: found.filter((r) => r.capacityVerdict === 'unit-diff').length,
  容量判定不能: found.filter((r) => r.capacityVerdict === 'unknown').length,
  カテゴリerror: found.filter((r) => r.fitSeverity === 'error').length,
  カテゴリwarn: found.filter((r) => r.fitSeverity === 'warn').length,
};
lines.push('## サマリー');
lines.push('');
lines.push('| 項目 | 件数 |');
lines.push('|---|---|');
for (const [k, v] of Object.entries(counts)) lines.push('| ' + k + ' | ' + v + ' |');
lines.push('| 全項目クリア | ' + results.filter((r) => !problem(r)).length + ' |');
lines.push('');

const header = '| 記事 | 1位商品（記事） | リンク先商品名（楽天実データ） | リンク一致 | 金額 | 数量 | カテゴリ適合 |';
const sep = '|---|---|---|---|---|---|---|';

lines.push('## 要確認（いずれかに不一致あり）');
lines.push('');
lines.push(header);
lines.push(sep);
for (const r of results.filter(problem)) {
  lines.push('| ' + [
    esc(r.slug),
    esc(r.rank1Name),
    esc(r.apiName ?? '-'),
    linkVerdict(r),
    priceVerdict(r),
    capVerdict(r) + (r.capacityVerdict === 'mismatch' || r.capacityVerdict === 'unit-diff' ? '<br>記事:' + esc(r.capacity) + ' / 実:' + esc(r.apiCapacity) : ''),
    fitVerdict(r) + (r.fitReason ? '<br>' + esc(r.fitReason) : ''),
  ].join(' | ') + ' |');
}
lines.push('');
lines.push('## 全件');
lines.push('');
lines.push(header);
lines.push(sep);
for (const r of results) {
  lines.push('| ' + [
    esc(r.slug),
    esc(r.rank1Name),
    esc(r.apiName ?? '-'),
    linkVerdict(r),
    priceVerdict(r),
    capVerdict(r),
    fitVerdict(r),
  ].join(' | ') + ' |');
}

const outPath = jsonPath.replace(/\.json$/, '.md');
writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
console.log(path.relative(ROOT, outPath));
console.log(JSON.stringify(counts, null, 2));
