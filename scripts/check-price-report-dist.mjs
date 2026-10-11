/**
 * 価格レポート（dist/price-report/）のビルド後検査。計画書6 §3.3。
 *
 * アフィリエイトリンク・Product/Offer の JSON-LD があれば exit 1（＝デプロイされない）。
 * dist/price-report/ が無いとき（ページ未実装・未生成）は何もせず exit 0。
 * 判定は src/lib/price-report-guard.ts（import なし）に任せ、ここはファイルを読んで渡すだけ。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { pathToFileURL } from 'url';

const ROOT = resolve(process.cwd());
const TARGET = join(ROOT, 'dist', 'price-report');

function collectHtml(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectHtml(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

if (!existsSync(TARGET)) {
  console.log('[check-price-report-dist] dist/price-report/ なし。スキップ');
  process.exit(0);
}

// dist/price-report/ があるときだけ読み込む（§3.3）
const { findPriceReportViolations } = await import(
  pathToFileURL(join(ROOT, 'src', 'lib', 'price-report-guard.ts')).href
);

const files = collectHtml(TARGET);
let total = 0;
for (const file of files) {
  const violations = findPriceReportViolations(readFileSync(file, 'utf8'));
  for (const v of violations) {
    console.error(`[check-price-report-dist] ${relative(ROOT, file)}: ${v.kind} ${v.detail}`);
  }
  total += violations.length;
}

if (total > 0) {
  console.error(`[check-price-report-dist] 違反 ${total} 件。/price-report/ にアフィリエイトリンク等は置けません`);
  process.exit(1);
}
console.log(`[check-price-report-dist] ${files.length} ページ検査・違反なし`);
