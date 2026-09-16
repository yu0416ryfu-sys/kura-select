// 価格履歴の型と統計。ランタイム依存を持たない純粋関数のみを置く
// （Phase 2 で Astro コンポーネントから直接 import するため）。
// I/O と frontmatter パースは scripts/lib/price-history.ts が担当する。

import { parseRakutenItemUrl, toRakutenUrlKey } from './rakuten-url.ts';
import { normalizeItemName } from './capacity.ts';

export type PriceHistoryProvider = 'rakuten' | 'yahoo' | 'amazon';

/** 1行＝1商品×1時点×1プロバイダ。data/price-history/<articleId>.jsonl の1レコード */
export interface PriceHistoryRecord {
  articleId: string;
  /** コミット日（YYYY-MM-DD・JST） */
  capturedAt: string;
  /** backfill 由来のみコミットハッシュ。追記時は null */
  commit: string | null;
  productKey: string;
  /** `shop/code`。取れない場合 null */
  itemCode: string | null;
  name: string;
  rank: number;
  provider: PriceHistoryProvider;
  price: number;
  /** 単価再計算用。取れない場合 null */
  capacity: string | null;
}

export interface PriceStats {
  productKey: string;
  min: number;
  max: number;
  latest: number;
  latestAt: string;
  /** 集計に使った行数 */
  samples: number;
  /** 実データの最古〜最新の日数（要求窓ではない） */
  spanDays: number;
  position: 'low' | 'mid' | 'high' | 'flat';
}

export interface SummarizeOptions {
  windowDays: number;
  /** 窓の終端（YYYY-MM-DD） */
  asOf: string;
  provider?: PriceHistoryProvider;
}

/** 統計を出すのに必要な最小サンプル数。2点で「底値圏」と言わないための下限 */
export const MIN_SAMPLES = 3;

/**
 * rakutenUrl から `{shop}/{code}` を取り出す。取れなければ null。
 * 大文字小文字は楽天の表記のまま返す（itemCode フィールドに保存する値）。
 */
export function extractRakutenItemCode(rakutenUrl: unknown): string | null {
  const ref = parseRakutenItemUrl(rakutenUrl);
  return ref ? `${ref.shopCode}/${ref.itemCode}` : null;
}

/**
 * 商品の同一性キー。rank / name / rakutenUrl はいずれも更新で変わりうるため、
 * 楽天 itemCode を主キー、正規化商品名をフォールバックにする。
 * 両者が衝突しないよう必ず前置詞（rk: / nm:）を付ける。
 * itemCode 側は楽天の大文字小文字の揺れを吸収するため小文字に揃える。
 */
export function buildProductKey(rakutenUrl: unknown, name: string): string {
  const key = toRakutenUrlKey(rakutenUrl);
  if (key) return `rk:${key}`;
  return `nm:${normalizeItemName(name ?? '').trim()}`;
}

/** YYYY-MM-DD の日数差（a - b）。UTC で計算するため DST の影響を受けない */
function diffDays(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * 指定窓のレコードから統計を出す。窓は [asOf - windowDays + 1, asOf] の閉区間。
 * 該当が MIN_SAMPLES 未満なら null を返す。
 */
export function summarizePriceHistory(
  records: readonly PriceHistoryRecord[],
  options: SummarizeOptions
): PriceStats | null {
  const { windowDays, asOf, provider } = options;
  const from = new Date(Date.parse(`${asOf}T00:00:00Z`) - (windowDays - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const inWindow = records.filter(r => {
    if (provider && r.provider !== provider) return false;
    if (!r.capturedAt || r.capturedAt < from || r.capturedAt > asOf) return false;
    return typeof r.price === 'number' && r.price > 0;
  });
  if (inWindow.length < MIN_SAMPLES) return null;

  const productKey = inWindow[0].productKey;
  let min = Infinity;
  let max = -Infinity;
  let latest = inWindow[0];
  let oldest = inWindow[0];
  for (const r of inWindow) {
    if (r.price < min) min = r.price;
    if (r.price > max) max = r.price;
    if (r.capturedAt > latest.capturedAt) latest = r;
    if (r.capturedAt < oldest.capturedAt) oldest = r;
  }

  let position: PriceStats['position'];
  if (min === max) {
    position = 'flat';
  } else {
    const ratio = (latest.price - min) / (max - min);
    position = ratio <= 0.25 ? 'low' : ratio >= 0.75 ? 'high' : 'mid';
  }

  return {
    productKey,
    min,
    max,
    latest: latest.price,
    latestAt: latest.capturedAt,
    samples: inWindow.length,
    // 要求窓ではなく実データの範囲で語る（欠測日を分母に入れない）
    spanDays: diffDays(latest.capturedAt, oldest.capturedAt) + 1,
    position,
  };
}

/** productKey ごとに summarize した Map を返す。統計が出ない商品はキーごと含めない */
export function summarizeByProduct(
  records: readonly PriceHistoryRecord[],
  options: SummarizeOptions
): Map<string, PriceStats> {
  const byKey = new Map<string, PriceHistoryRecord[]>();
  for (const r of records) {
    const group = byKey.get(r.productKey);
    if (group) group.push(r);
    else byKey.set(r.productKey, [r]);
  }

  const result = new Map<string, PriceStats>();
  for (const [key, group] of byKey) {
    const stats = summarizePriceHistory(group, options);
    if (stats) result.set(key, stats);
  }
  return result;
}
