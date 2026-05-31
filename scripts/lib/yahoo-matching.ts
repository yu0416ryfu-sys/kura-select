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
  brandVariants?: string[];
  rakutenUrl?: string | null;
}

export interface EvaluateResult {
  ok: boolean;
  reason: string;
  candidateCapacity?: string | null;
  strictMatch?: boolean;
  urlMultiplier?: number;
  urlIdentityMatch?: boolean;
  brandMatch?: boolean;
  brandFailureReason?: string;
  suggestedBrandAliases?: string[];
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

function unwrapAffiliateUrl(url: string, param: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get(param) ?? url;
  } catch {
    return null;
  }
}

function extractItemCode(
  url: string,
  affiliateParam: string,
  suffix: string | RegExp = ""
): string | null {
  const targetUrl = unwrapAffiliateUrl(url, affiliateParam);
  if (!targetUrl) return null;
  try {
    const pathname = new URL(targetUrl).pathname;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const itemCode = segments.at(-1)?.replace(suffix, "") ?? "";
    return itemCode || null;
  } catch {
    return null;
  }
}

export function extractRakutenItemCode(url: string | null | undefined): string | null {
  if (!url) return null;
  return extractItemCode(url, "pc");
}

export function extractYahooItemCode(url: string): string | null {
  return extractItemCode(url, "vc_url", /\.html$/i);
}

export function hasStrongUrlIdentity(
  rakutenUrl: string | null | undefined,
  yahooUrl: string
): boolean {
  const rakutenCode = extractRakutenItemCode(rakutenUrl)?.toLowerCase();
  const yahooCode = extractYahooItemCode(yahooUrl)?.toLowerCase();
  return Boolean(
    rakutenCode &&
      yahooCode &&
      !/^\d+$/.test(rakutenCode) &&
      rakutenCode === yahooCode
  );
}

export function normalizeYahooMatchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function containsCapacityExpression(token: string): boolean {
  return /\d+(?:\.\d+)?\s*(?:ml|l|kg|g|枚|本|袋|個|入|パック|巻|ロール|リットル)/i
    .test(token);
}

export function normalizeTokens(value: string): string[] {
  return normalizeYahooMatchText(buildSearchKeyword(value))
    .split(/[\s　・、。／/｜|]+/)
    .filter((token) => token.length >= 2)
    .filter((token) => !/^[\d.,]+/.test(token))
    .filter((token) => !containsCapacityExpression(token));
}

export function isLikelySameProduct(currentName: string, candidateName: string): boolean {
  const tokens = normalizeTokens(currentName);
  if (tokens.length === 0) return false;
  const normalizedCandidate = normalizeYahooMatchText(candidateName);
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

// ─── brand 照合ヘルパー ──────────────────────────────────────────────────────

/**
 * brand 値を buildSearchKeyword で正規化して小文字化する。
 * primary brand や brandVariants に使う。
 */
function normalizeBrandToken(value: string): string {
  return normalizeYahooMatchText(buildSearchKeyword(value));
}

function normalizeSupplementalCapacity(value: string | null): string {
  return value
    ? value.normalize("NFKC").replace(/[×xX*＊]/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

export function buildYahooSupplementalSearchQuery(
  product: ProductForMatching
): string | null {
  const capacity = normalizeSupplementalCapacity(product.capacity);
  if (!capacity || capacity.length >= 40) return null;

  const brand = product.brand
    ? normalizeYahooMatchText(product.brand).replace(/\s*\(.+?\)/g, "").trim()
    : "";
  const prefixTokens = [...new Set([
    ...brand.split(/\s+/),
    ...normalizeTokens(product.name),
  ].filter(Boolean))];
  const maxPrefixLength = 40 - capacity.length - 1;
  while (prefixTokens.length > 0 && prefixTokens.join(" ").length > maxPrefixLength) {
    prefixTokens.pop();
  }

  const query = [...prefixTokens, capacity].filter(Boolean).join(" ");
  const primaryQuery = normalizeYahooMatchText(buildSearchKeyword(product.name));
  return query && normalizeYahooMatchText(query) !== primaryQuery ? query : null;
}

/**
 * brand 値をスペース・区切り文字で分割したサブトークン配列を返す。
 * 「花王 ビオレ」→ ["花王", "ビオレ"] のようなスペース表記ゆれの吸収に使う。
 * 2文字未満のトークンは除外する。
 */
function splitBrandSubTokens(value: string): string[] {
  return normalizeBrandToken(value)
    .split(/[\s　・_\-]+/)
    .filter((token) => token.length >= 2);
}

/**
 * 文字列からカタカナ連続語（2文字以上）を重複なく抽出する。
 * brand 照合失敗時のエイリアス提案に使う。
 */
function extractKatakanaRuns(value: string): string[] {
  return [...value.matchAll(/[ァ-ヴー]{2,}/g)]
    .map((m) => m[0])
    .filter((token, index, all) => all.indexOf(token) === index);
}

/**
 * strictMatch 失敗時にエイリアス候補を提案する。
 * frontmatter へ自動反映せず、レポート提案にのみ使う。
 *
 * 条件:
 * 1. candidateName に product.name の主要トークンが含まれる（allTokensMatch が呼び元で確認済み）
 * 2. product.name と candidateName の共通カタカナ連続語を候補にする
 * 3. 英字ブランド（THE, VT, P&G 等）が含まれる場合は英字接頭辞 + カタカナ連続語も追加する
 */
function suggestBrandAliases(product: ProductForMatching, candidateName: string): string[] {
  const productRuns = new Set(extractKatakanaRuns(product.name));
  const candidateRuns = extractKatakanaRuns(candidateName).filter((token) =>
    productRuns.has(token)
  );
  const prefixedRuns: string[] = [];
  if (product.brand && /\b[A-Za-z][A-Za-z&.]*\b/.test(product.brand)) {
    const prefix = candidateName.match(/\b[A-Za-z][A-Za-z&.]*\b/)?.[0];
    if (prefix) {
      for (const token of candidateRuns) {
        prefixedRuns.push(`${prefix}${token}`);
      }
    }
  }
  return [...new Set([...prefixedRuns, ...candidateRuns])];
}

// ─── Step 3: 固有語フォールバック ───────────────────────────────────────────

/**
 * 汎用商品語セット。hasDistinctiveProductToken の除外対象。
 * カテゴリ名・機能訴求語・製品タイプ・汎用成分語を含む。
 * 6文字未満のトークンは length チェックで自動除外されるが、可読性のために含める。
 * 追加ルール: Step 2 レポートで誤昇格リスクが確認された語のみ追加する。
 * ブランド名・シリーズ名として使われる語は単独で追加しない。
 */
const GENERIC_PRODUCT_TOKENS = new Set([
  // ─── カテゴリ名（6文字以上のみ実際に適用される）───
  "ペーパータオル",     // 7文字
  "キッチンタオル",     // 7文字
  "トイレットペーパー", // 9文字
  "ウェットティッシュ", // 9文字
  "おしりふき",         // 5文字（length < 6 で自動除外）
  "ボディソープ",       // 6文字
  "ボディーソープ",     // 7文字
  "シャンプー",         // 5文字（自動除外）
  "トリートメント",     // 7文字
  // ─── 機能訴求語 ───────────────────────────────────
  "肌にやさしい",       // 6文字
  "やわらか素材",       // 6文字
  "やわらかタイプ",     // 7文字
  // ─── 製品タイプ・販売形態 ────────────────────────
  "スポットパッチ",     // 7文字
  "詰め替え",           // 4文字（自動除外）
  "つめかえ",           // 4文字（自動除外）
  "まとめ買い",         // 5文字（自動除外）
  "大容量",             // 3文字（自動除外）
  "薬用",               // 2文字（自動除外）
  "セット",             // 3文字（自動除外）
  "パッチ",             // 3文字（自動除外）
  // ─── 成分・機能（汎用） ──────────────────────────
  "cica",               // 4文字（自動除外）
]);

/**
 * brand 照合に失敗した場合の最終フォールバック。
 * 商品名トークンのうち「6文字以上かつ汎用語でない固有語」が候補名に含まれるかを判定する。
 * allTokensMatch && !brandMatch のときのみ呼び出す。
 */
function hasDistinctiveProductToken(tokens: string[], normCandidate: string): boolean {
  return tokens.some((token) => {
    if (token.length < 6) return false;
    if (GENERIC_PRODUCT_TOKENS.has(token)) return false;
    return normCandidate.includes(token);
  });
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
  const normCandidate = normalizeYahooMatchText(candidate.name);
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
  // 括弧内エイリアスは人間が確認した照合語のため、buildSearchKeyword を通さず
  // trim + toLowerCase のみにして現行挙動を維持する。
  const primaryBrand = product.brand ? normalizeBrandToken(product.brand) : "";
  const brandAliases: string[] = product.brand
    ? [...product.brand.matchAll(/[（(]([^）)]+)[）)]/g)]
        .map((m) => normalizeYahooMatchText(m[1].trim()))
        .filter((a) => a.length >= 2 && a !== primaryBrand)
    : [];
  // Step 4: brandVariants（省略可能フィールド）も照合トークンに追加する
  const explicitBrandVariants = (product.brandVariants ?? [])
    .map((v) => normalizeBrandToken(v))
    .filter((v) => v.length >= 2);
  const brandTokens = primaryBrand
    ? [primaryBrand, ...brandAliases, ...explicitBrandVariants]
    : [...brandAliases, ...explicitBrandVariants];
  // Step 1: 案B サブトークン照合 — "花王 ビオレ" / "花王ビオレ" などスペース表記ゆれを吸収する
  // サブトークンが1つの場合は directBrandMatch と等価なので subTokenBrandMatch は適用しない。
  const brandSubTokens = product.brand ? splitBrandSubTokens(product.brand) : [];
  const directBrandMatch = brandTokens.some((t) => normCandidate.includes(t));
  const subTokenBrandMatch =
    brandSubTokens.length > 1 && brandSubTokens.every((t) => normCandidate.includes(t));
  const brandMatch = brandTokens.length === 0 || directBrandMatch || subTokenBrandMatch;
  // Step 3: brand 照合に失敗した場合、固有語フォールバックで strictMatch を補完する。
  // allTokensMatch が前提条件。brand が一致しなくても商品固有語が一致すれば matched 昇格を許可する。
  const distinctiveProductTokenMatch =
    !brandMatch && hasDistinctiveProductToken(tokens, normCandidate);
  const urlIdentityMatch = hasStrongUrlIdentity(product.rakutenUrl, candidate.url);
  const strictMatch =
    allTokensMatch && (brandMatch || distinctiveProductTokenMatch || urlIdentityMatch);

  // Step 2: strictMatch が brand 失敗かつ固有語フォールバックでも補完できない場合のみ報告する
  let brandFailureReason: string | undefined;
  let suggestedBrandAliases: string[] | undefined;
  if (allTokensMatch && !brandMatch && !distinctiveProductTokenMatch && !urlIdentityMatch) {
    brandFailureReason = "brand token not found in Yahoo candidate";
    suggestedBrandAliases = suggestBrandAliases(product, candidate.name);
  }

  return {
    ok: true,
    reason: "capacity一致",
    candidateCapacity,
    strictMatch,
    urlMultiplier,
    urlIdentityMatch,
    brandMatch,
    brandFailureReason,
    suggestedBrandAliases,
  };
}
