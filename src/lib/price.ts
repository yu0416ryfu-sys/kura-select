type SortDirection = "asc" | "desc";

interface PricePerUnitComparable {
  price: number | null | undefined;
  pricePerUnit?: string | null;
  lowestProvider?: string | null;
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
  const value = parseFloat(pricePerUnit.replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? value : Infinity;
}

export function comparePricePerUnit(
  a: PricePerUnitComparable,
  b: PricePerUnitComparable,
  direction: SortDirection
): number {
  const av = a.lowestProvider === "rakuten" ? pricePerUnitSortValue(a.price, a.pricePerUnit) : Infinity;
  const bv = b.lowestProvider === "rakuten" ? pricePerUnitSortValue(b.price, b.pricePerUnit) : Infinity;
  if (av === Infinity && bv === Infinity) return 0;
  if (av === Infinity) return 1;
  if (bv === Infinity) return -1;
  return direction === "asc" ? av - bv : bv - av;
}
