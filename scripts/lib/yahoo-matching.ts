import {
  buildSearchKeyword,
  extractCapacityFromItemName,
  extractCapacityTotal,
  normalizeCapacityTotal,
} from "./frontmatter.ts";
import type { YahooOfferCandidate } from "./yahoo-shopping.ts";

export interface ProductForMatching {
  name: string;
  capacity: string | null;
  brand: string | null; // "" は parseProducts() 側で null に正規化済みの前提
}

export interface EvaluateResult {
  ok: boolean;
  reason: string;
  candidateCapacity?: string | null;
  strictMatch?: boolean;
}

export function normalizeTokens(value: string): string[] {
  return buildSearchKeyword(value)
    .toLowerCase()
    .split(/[\s　・、。／/｜|]+/)
    .filter((token) => token.length >= 2)
    .filter((token) => !/^[\d.,]+/.test(token));
}

export function isLikelySameProduct(currentName: string, candidateName: string): boolean {
  const tokens = normalizeTokens(currentName);
  if (tokens.length === 0) return false;
  const normalizedCandidate = candidateName.toLowerCase();
  // 最初のトークン（ブランド名相当）が候補に含まれない場合は別商品と判定
  if (!normalizedCandidate.includes(tokens[0])) return false;
  const matched = tokens.filter((token) => normalizedCandidate.includes(token)).length;
  return matched >= Math.min(2, tokens.length);
}

export function toComparableCapacity(capacity: string | null | undefined) {
  return normalizeCapacityTotal(extractCapacityTotal(capacity ?? ""));
}

export function isSameComparableCapacity(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const aTotal = toComparableCapacity(a);
  const bTotal = toComparableCapacity(b);
  return Boolean(
    aTotal &&
      bTotal &&
      aTotal.total === bTotal.total &&
      aTotal.unit.toLowerCase() === bTotal.unit.toLowerCase()
  );
}

export function evaluateYahooCandidate(
  product: ProductForMatching,
  candidate: YahooOfferCandidate
): EvaluateResult {
  // 基本チェック: isLikelySameProduct は変更しない（ok 判定に brand は使わない）
  if (!isLikelySameProduct(product.name, candidate.name)) {
    return { ok: false, reason: "商品名トークン不一致" };
  }

  const currentCapacity = product.capacity;
  const candidateCapacity = extractCapacityFromItemName(candidate.name);

  if (!currentCapacity) {
    return { ok: false, reason: "既存capacityなし" };
  }
  if (!candidateCapacity) {
    return { ok: false, reason: "Yahoo候補からcapacity抽出不可", candidateCapacity: null };
  }
  if (!isSameComparableCapacity(currentCapacity, candidateCapacity)) {
    return { ok: false, reason: "capacity不一致", candidateCapacity };
  }

  // strictMatch: matched 昇格可否の判定（案A + 案B）
  // 案B: candidate 側も buildSearchKeyword で正規化して表記ゆれを吸収
  const tokens = normalizeTokens(product.name);
  const normCandidate = buildSearchKeyword(candidate.name).toLowerCase();
  const allTokensMatch = tokens.length > 0 && tokens.every((t) => normCandidate.includes(t));
  // 案A: brand フィールドがある場合は matched 昇格の追加条件として照合する
  // ok 判定には影響させない（品種・パッケージ違いをブロックするための追加ゲート）
  // brand 側も buildSearchKeyword で正規化して記号・全角半角差分を統一する（案B と一貫性を保つ）
  // parseProducts() で "" → null 正規化済みの前提だが、明示的ガードで堅牢性を確保する
  const normalizedBrand = product.brand ? buildSearchKeyword(product.brand).toLowerCase() : "";
  const brandMatch = normalizedBrand ? normCandidate.includes(normalizedBrand) : true;
  const strictMatch = allTokensMatch && brandMatch;

  return { ok: true, reason: "capacity一致", candidateCapacity, strictMatch };
}
