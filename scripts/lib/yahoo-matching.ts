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
  urlMultiplier?: number;
}

/**
 * ValueCommerce 経由の Yahoo URL から販売数量倍率を抽出する。
 * 例: ...vc_url=https%3A%2F%2Fstore.shopping.yahoo.co.jp%2Fsundrugec%2F4902011743081x6.html → 6
 * 倍率なし・解析不能の場合は 1 を返す。
 */
export function extractUrlQuantityMultiplier(url: string): number {
  let targetUrl = url;
  const vcMatch = url.match(/vc_url=([^&]+)/);
  if (vcMatch) {
    try { targetUrl = decodeURIComponent(vcMatch[1]); } catch {}
  }
  // JAN コード系（8桁以上の数字）+ x{N} パターン
  const match = targetUrl.match(/\/\d{8,}x(\d+)\.html/);
  if (!match) return 1;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n >= 2 ? n : 1;
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

/** 送り仮名ゆれの既知マッピング。直接 includes が失敗したトークンのフォールバック候補を返す */
const OKURIGANA_TOKEN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "詰め替え": ["詰替"],
  "つめかえ": ["詰替", "詰め替え"],
  "取り替え": ["取替"],
  "取替え":   ["取替"],
};

function getOkuriganaAliases(token: string): readonly string[] {
  return OKURIGANA_TOKEN_ALIASES[token] ?? [];
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
  // URL 由来の数量倍率を取得し、capacity に反映する
  const urlMultiplier = extractUrlQuantityMultiplier(candidate.url);
  let effectiveCandidateCapacity = candidateCapacity;
  if (urlMultiplier > 1) {
    const alreadyIncluded = new RegExp(
      `[×xX*＊]\\s*${urlMultiplier}(?:[^\\d]|$)`
    ).test(candidateCapacity);
    if (!alreadyIncluded) {
      const extracted = extractCapacityTotal(candidateCapacity);
      if (extracted) {
        effectiveCandidateCapacity = `${extracted.total * urlMultiplier}${extracted.unit}`;
      }
    }
  }
  if (!isSameComparableCapacity(currentCapacity, effectiveCandidateCapacity)) {
    return {
      ok: false,
      reason: urlMultiplier > 1
        ? `capacity不一致（URL倍率×${urlMultiplier}考慮: ${effectiveCandidateCapacity} vs ${currentCapacity}）`
        : "capacity不一致",
      candidateCapacity: effectiveCandidateCapacity,
      urlMultiplier,
    };
  }

  // strictMatch: matched 昇格可否の判定（案A + 案B）
  // normCandidate は全文照合用のため buildSearchKeyword（40文字制限あり）を使わず
  // 候補名をそのまま小文字化する。後半にブランド名が出る商品名で切り捨てが起きるのを防ぐ。
  const tokens = normalizeTokens(product.name);
  const normCandidate = candidate.name.toLowerCase();
  // 送り仮名ゆれ対応: 直接一致しない場合のみ既知 alias でフォールバック照合する
  const allTokensMatch = tokens.length > 0 && tokens.every((t) => {
    if (normCandidate.includes(t)) return true;
    return getOkuriganaAliases(t).some((alias) => normCandidate.includes(alias));
  });
  // 案A: brand フィールドがある場合は matched 昇格の追加条件として照合する
  // ok 判定には影響させない（品種・パッケージ違いをブロックするための追加ゲート）
  // "王子ネピア（ネピア）" のように括弧内にブランド略称がある場合、
  // buildSearchKeyword は括弧を除去するため "王子ネピア" のみになる。
  // Yahoo 候補名に略称 "ネピア" しか出ない場合でも一致できるよう、
  // 括弧内エイリアスも候補トークンとして追加する。
  const primaryBrand = product.brand ? buildSearchKeyword(product.brand).toLowerCase() : "";
  const brandAliases: string[] = product.brand
    ? [...product.brand.matchAll(/[（(]([^）)]+)[）)]/g)]
        .map(m => m[1].trim().toLowerCase())
        .filter(a => a.length >= 2 && a !== primaryBrand)
    : [];
  const brandTokens = primaryBrand ? [primaryBrand, ...brandAliases] : brandAliases;
  const brandMatch = brandTokens.length === 0 || brandTokens.some(t => normCandidate.includes(t));
  const strictMatch = allTokensMatch && brandMatch;

  return { ok: true, reason: "capacity一致", candidateCapacity, strictMatch, urlMultiplier };
}
