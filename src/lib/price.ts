import { calcPricePerUnit } from "./capacity";

type SortDirection = "asc" | "desc";

// offers.ts の OfferProvider と同値。price.ts → offers.ts の依存を作らないため再定義する
type OfferProviderLike = "rakuten" | "yahoo" | "amazon";

interface PricePerUnitComparable {
  price: number | null | undefined;
  // 最安サイトの価格 × capacity から算出した単価文字列（サイト非依存）
  pricePerUnit?: string | null;
}

export function isKnownPrice(price: number | null | undefined): price is number {
  return typeof price === "number" && Number.isFinite(price) && price > 0;
}

export function formatPriceOrConfirmation(price: number | null | undefined): string {
  return isKnownPrice(price) ? `¥${price.toLocaleString()}` : "価格確認";
}

export function compareKnownPrice(
  a: number | null | undefined,
  b: number | null | undefined,
  direction: SortDirection
): number {
  const aKnown = isKnownPrice(a);
  const bKnown = isKnownPrice(b);
  if (!aKnown && !bKnown) return 0;
  if (!aKnown) return 1;
  if (!bKnown) return -1;
  return direction === "asc" ? a - b : b - a;
}

export function shouldShowPricePerUnit(
  price: number | null | undefined,
  pricePerUnit: string | null | undefined
): boolean {
  if (!isKnownPrice(price) || !pricePerUnit || pricePerUnit === "-") return false;
  return !/^約?0(?:\.0+)?円\//.test(pricePerUnit);
}

export function pricePerUnitSortValue(
  price: number | null | undefined,
  pricePerUnit: string | null | undefined
): number {
  if (!shouldShowPricePerUnit(price, pricePerUnit)) return Infinity;
  const value = parseFloat((pricePerUnit ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? value : Infinity;
}

export function comparePricePerUnit(
  a: PricePerUnitComparable,
  b: PricePerUnitComparable,
  direction: SortDirection
): number {
  // 最安サイトの算出単価で比較する（provider は問わない）
  const av = pricePerUnitSortValue(a.price, a.pricePerUnit);
  const bv = pricePerUnitSortValue(b.price, b.pricePerUnit);
  if (av === Infinity && bv === Infinity) return 0;
  if (av === Infinity) return 1;
  if (bv === Infinity) return -1;
  return direction === "asc" ? av - bv : bv - av;
}

// ── 選択式（項目選択肢で価格が変わる）出品の扱い ─────────────────────────────
// 楽天の価格帯商品は price が最安構成、priceMax が上限を指す。
// どの選択肢の容量かを特定できないため単価（円/mL 等）は表示せず、
// 価格は帯（¥min〜¥max）で出す。単価が無い商品は
// pricePerUnitSortValue が Infinity を返すためコスパ順の末尾に落ちる。

export interface VariantPriceLike {
  price?: number | null;
  priceMax?: number | null;
}

/** 選択式出品か。priceMax が price より大きいときだけ true */
export function isVariantPricedProduct(product: VariantPriceLike): boolean {
  const { price, priceMax } = product;
  if (!isKnownPrice(price) || !isKnownPrice(priceMax)) return false;
  return priceMax > price;
}

/** 帯表示のラベル。価格帯商品でなければ null */
export function formatPriceRange(product: VariantPriceLike): string | null {
  if (!isVariantPricedProduct(product)) return null;
  return `¥${product.price!.toLocaleString()}〜¥${product.priceMax!.toLocaleString()}`;
}

/** 表示用の単価。楽天の価格帯商品のときだけ null（＝単価を出さない） */
export function resolveDisplayPricePerUnit(
  product: VariantPriceLike & { capacity: string },
  price: number | null | undefined,
  targetUnit?: string,
  provider: OfferProviderLike = "rakuten"
): string | null {
  if (!isKnownPrice(price)) return null;
  if (provider === "rakuten" && isVariantPricedProduct(product)) return null;
  return calcPricePerUnit(price, product.capacity, targetUnit);
}

/**
 * 「安い順」の比較値。
 * 比較値が楽天由来の価格帯商品なら上限（priceMax）で並べる。
 * Yahoo / Amazon が最安のときはその実価格が正しいので触らない。
 */
export function resolveComparablePrice(
  product: VariantPriceLike,
  price: number | null | undefined,
  provider: OfferProviderLike = "rakuten"
): number | null | undefined {
  if (provider === "rakuten" && isVariantPricedProduct(product)) return product.priceMax;
  return price;
}
