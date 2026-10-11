// 価格レポート（/price-report/ 配下）のビルド後検査。
// アフィリエイトリンクと Product / Offer の構造化データが混入していないかを判定する。
// **import を一切持たない**（集計側の import 失敗で毎週の cron デプロイを落とさないため。計画書6 §3.3 S3）。

export interface PriceReportViolation {
  kind: 'affiliate-href' | 'json-ld-type';
  detail: string;
}

/** href に含まれていたら違反とする文字列（小文字で照合） */
const FORBIDDEN_HREF_PARTS = [
  'hb.afl.rakuten',
  'ck.jp.ap.valuecommerce',
  'a8.net',
  'amazon.co.jp',
  'amzn.to',
  'af.moshimo.com',
];

const FORBIDDEN_LD_TYPES = new Set(['Product', 'Offer']);

/** JSON-LD の値を再帰的にたどり、禁止 @type を集める（配列・@graph・入れ子を含む） */
function collectForbiddenTypes(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectForbiddenTypes(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const t = obj['@type'];
  const types = Array.isArray(t) ? t : [t];
  for (const v of types) {
    if (typeof v === 'string' && FORBIDDEN_LD_TYPES.has(v)) out.push(v);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === '@type') continue;
    collectForbiddenTypes(v, out);
  }
}

/** 1ページ分の HTML を受け取り、違反を返す（なければ空配列） */
export function findPriceReportViolations(html: string): PriceReportViolation[] {
  const violations: PriceReportViolation[] = [];

  // rel="sponsored ..." はリンク形式によらずアフィリンクの目印
  if (/rel\s*=\s*["']?[^"'>]*\bsponsored\b/i.test(html)) {
    violations.push({ kind: 'affiliate-href', detail: 'rel="sponsored"' });
  }

  const hrefRe = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(hrefRe)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase();
    const hit = FORBIDDEN_HREF_PARTS.find((p) => href.includes(p));
    if (hit) violations.push({ kind: 'affiliate-href', detail: href });
  }

  const ldRe = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(ldRe)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      // 壊れた JSON-LD は文字列で判定する（見逃さない側に倒す）
      if (/"@type"\s*:\s*(?:\[[^\]]*)?"(?:Product|Offer)"/.test(m[1])) {
        violations.push({ kind: 'json-ld-type', detail: 'unparsable JSON-LD with Product/Offer' });
      }
      continue;
    }
    const found: string[] = [];
    collectForbiddenTypes(data, found);
    for (const t of found) violations.push({ kind: 'json-ld-type', detail: t });
  }

  return violations;
}
