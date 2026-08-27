/**
 * 楽天商品URLの正規化と、記事内 products[] の rakutenUrl 重複判定。
 *
 * update-products.mjs の検索フォールバックは商品名でキーワード検索するため、
 * 同一記事内の別商品が同じ楽天商品にヒットし、同じ rakutenUrl が
 * 2件登録される事故が起きる（2026-07-31 の送客導線点検で10記事分を検出）。
 * URL比較は必ずこのモジュールの正規化キーを通して行う。
 */

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
 * affiliateUrl / item.rakuten.co.jp URL を正規化して
 * https://item.rakuten.co.jp/{shopCode}/{itemCode}/ 形式で返す
 */
export function toDirectItemUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  const parsed = parseRakutenItemUrl(url);
  if (parsed) return `https://item.rakuten.co.jp/${parsed.shopCode}/${parsed.itemCode}/`;
  // すでに item.rakuten.co.jp 形式ならそのまま
  try {
    const u = new URL(url);
    if (u.hostname === 'item.rakuten.co.jp') return url;
  } catch { /* ignore */ }
  return null;
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

export function isSameRakutenItem(a: unknown, b: unknown): boolean {
  const keyA = toRakutenUrlKey(a);
  const keyB = toRakutenUrlKey(b);
  return Boolean(keyA && keyB && keyA === keyB);
}

export interface ProductUrlLike {
  rank?: number;
  name?: string;
  rakutenUrl?: string | null;
}

/**
 * 自分以外の商品が使っている楽天商品キーの集合を返す。
 * rank が一致する商品を自分とみなし、rank 未指定時は name で一致判定する。
 */
export function collectOtherProductUrlKeys(
  products: readonly ProductUrlLike[],
  self: { rank?: number | null; name?: string | null } = {}
): Set<string> {
  const keys = new Set<string>();
  for (const product of products) {
    if (isSelfProduct(product, self)) continue;
    const key = toRakutenUrlKey(product.rakutenUrl);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * 指定URLが自分以外の商品と重複していれば、その商品を返す。
 */
export function findDuplicateUrlProduct<T extends ProductUrlLike>(
  products: readonly T[],
  url: unknown,
  self: { rank?: number | null; name?: string | null } = {}
): T | null {
  const key = toRakutenUrlKey(url);
  if (!key) return null;
  for (const product of products) {
    if (isSelfProduct(product, self)) continue;
    if (toRakutenUrlKey(product.rakutenUrl) === key) return product;
  }
  return null;
}

/**
 * 記事内で同一楽天商品を指している products[] のグループを返す（2件以上のみ）。
 * 手作業での商品追加で混入した重複を検知する用途。
 */
export function findDuplicateUrlGroups<T extends ProductUrlLike>(
  products: readonly T[]
): { key: string; products: T[] }[] {
  const byKey = new Map<string, T[]>();
  for (const product of products) {
    const key = toRakutenUrlKey(product.rakutenUrl);
    if (!key) continue;
    const group = byKey.get(key) ?? [];
    group.push(product);
    byKey.set(key, group);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([key, group]) => ({ key, products: group }));
}

export interface SearchItemLike {
  itemUrl?: string | null;
  affiliateUrl?: string | null;
}

export interface SearchItemSelection<T> {
  item: T | null;
  skippedDuplicates: T[];
}

/**
 * 検索結果から、記事内の他商品と重複しない先頭の商品を選ぶ。
 * 全件が重複していれば item は null（呼び出し側で更新をスキップする）。
 */
export function selectNonDuplicateItem<T extends SearchItemLike>(
  items: readonly T[],
  usedUrlKeys: ReadonlySet<string>
): SearchItemSelection<T> {
  const skippedDuplicates: T[] = [];
  for (const item of items) {
    const key = toRakutenUrlKey(item.itemUrl) ?? toRakutenUrlKey(item.affiliateUrl);
    if (key && usedUrlKeys.has(key)) {
      skippedDuplicates.push(item);
      continue;
    }
    return { item, skippedDuplicates };
  }
  return { item: null, skippedDuplicates };
}

function isSelfProduct(
  product: ProductUrlLike,
  self: { rank?: number | null; name?: string | null }
): boolean {
  if (typeof self.rank === 'number' && typeof product.rank === 'number') {
    return product.rank === self.rank;
  }
  if (self.name && product.name) return product.name === self.name;
  return false;
}

/**
 * itemCode（URL 末尾の商品管理番号）そのものを検索キーワードとして使うための候補を作る。
 *
 * update-products の従来フォールバック（試行A〜C）はすべて商品名ベースのため、
 * 記事 frontmatter の name が実出品名からドリフトしていると全戦略が外れる
 * （2026-08-23 に laundry-gel-ball r4 `sundrug/4987176292759` で顕在化）。
 * 管理番号は商品名に依存しないので、ドリフトしていても引ける。
 *
 * 返す候補の順:
 *   1. itemCode 全体（`4987176292759-2` のような枝番付きもそのまま）
 *   2. その中の JAN 相当（8〜14桁）の数字列
 *
 * 数字を含まない管理番号（`set`, `refill` など）は検索ノイズにしかならないので除外する。
 */
export function buildItemCodeKeywords(itemCode: unknown): string[] {
  if (typeof itemCode !== 'string') return [];
  const code = itemCode.trim();
  if (code.length < 6 || code.length > 40) return [];
  if (!/\d/.test(code)) return [];

  const keywords: string[] = [code];
  const digitRuns = code.match(/\d{8,14}/g) ?? [];
  for (const run of digitRuns) {
    if (!keywords.includes(run)) keywords.push(run);
  }
  return keywords;
}
