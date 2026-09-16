// 楽天商品URLの解析。ランタイム依存を持たない純粋関数のみを置き、
// scripts/lib/rakuten-url.ts（再エクスポート）と src/lib/price-history.ts の双方から使う。
// 依存方向は scripts → src に統一する（src/lib/capacity.ts と同じ方針）。

export interface RakutenItemRef {
  shopCode: string;
  itemCode: string;
}

/**
 * affiliateUrl（hb.afl.rakuten.co.jp）と item.rakuten.co.jp URL から
 * shopCode / itemCode を取り出す。大文字小文字は元の表記のまま返す
 * （楽天APIへ再問い合わせする際のコードとして使うため）。
 */
export function parseRakutenItemUrl(url: unknown): RakutenItemRef | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'hb.afl.rakuten.co.jp') {
      const pc = parsed.searchParams.get('pc');
      if (!pc) return null;
      const inner = new URL(decodeURIComponent(pc));
      if (inner.hostname !== 'item.rakuten.co.jp') return null;
      const m = inner.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
      return m ? { shopCode: m[1], itemCode: m[2] } : null;
    }
    if (parsed.hostname === 'item.rakuten.co.jp') {
      const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
      return m ? { shopCode: m[1], itemCode: m[2] } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 同一商品かどうかを判定するための比較キー。
 * shopCode / itemCode は楽天側で大文字小文字が揺れるため小文字に揃える。
 */
export function toRakutenUrlKey(url: unknown): string | null {
  const parsed = parseRakutenItemUrl(url);
  if (!parsed) return null;
  return `${parsed.shopCode.toLowerCase()}/${parsed.itemCode.toLowerCase()}`;
}
