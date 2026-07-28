/**
 * 商品照合候補レポート（reports/toAI/kura-product-match-ai/）用の検索キーワード生成。
 *
 * update-products.mjs から切り出したのは、一般名商品（ブランド名を含まない
 * 「不織布プリーツマスク 300枚」のような商品名）で候補がカテゴリ一般語に
 * 埋まる問題をテストで押さえるため。
 */

/** 入数・容量として扱う単位（NFKC 正規化後に照合する） */
const QUANTITY_UNIT_PATTERN = "mL|ml|ML|L|l|g|G|kg|KG|枚|個|本|袋|箱|パック|セット|ロール|巻|包|錠|m|M";

/** 一般名（＝ブランド名を含まない）とみなすトークン数の上限 */
const GENERIC_NAME_MAX_TOKENS = 1;

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map(value => String(value ?? "").trim()).filter(Boolean))];
}

/** 商品名から容量・入数以降を落とす（例: 「ジップロック ストックバッグ L 32枚入×3箱」→「ジップロック ストックバッグ L」） */
export function stripCapacityForKeyword(name: string): string {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/[【\[].+?[】\]]/g, " ")
    .replace(/[（(].+?[）)]/g, " ")
    .replace(new RegExp(`\\d[\\d,.]*\\s*(?:${QUANTITY_UNIT_PATTERN}).*`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 容量に加えてサイズ訴求語も落とす（例: 「ジップロック ストックバッグ L」→「ジップロック ストックバッグ」） */
export function stripSizeAndCapacityForKeyword(name: string): string {
  return stripCapacityForKeyword(name)
    .split(/\s+/)
    .filter(token => !/^(?:SS|S|M|L|LL|XL|2L|3L|大|小|大容量|小容量)$/i.test(token))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 商品名から先頭の入数・容量トークンを取り出す（例: 「不織布プリーツマスク 300枚」→「300枚」）。
 * 見つからない場合は null。
 */
export function extractQuantityToken(name: string): string | null {
  const matched = String(name ?? "")
    .normalize("NFKC")
    .match(new RegExp(`(\\d[\\d,.]*)\\s*(${QUANTITY_UNIT_PATTERN})`));
  if (!matched) return null;
  return `${matched[1]}${matched[2]}`;
}

/**
 * 商品名がブランド名を持たない一般名かを判定する。
 * 一般名は容量を落とすとカテゴリ一般語そのものになり、レビュー数上位の
 * 無関係商品（子供用・キャラクター物など）しか候補に出てこない。
 *
 * 「ラックス … コンディショナー」のようにブランド名＋カテゴリ語の商品まで
 * 一般名扱いすると段階短縮キーワードの枠を潰すため、カテゴリ語の判定は
 * 部分一致ではなく完全一致に限定する。
 */
export function isGenericProductName(strippedName: string, categoryKeywords: string[] = []): boolean {
  const normalizedName = strippedName.trim();
  if (!normalizedName) return false;
  const tokens = normalizedName.split(/\s+/).filter(Boolean);
  if (tokens.length <= GENERIC_NAME_MAX_TOKENS) return true;
  return categoryKeywords.some(keyword => String(keyword ?? "").trim() === normalizedName);
}

export interface ProductMatchKeywordInput {
  productName: string;
  /** buildSearchKeyword(productName) の結果 */
  baseKeyword?: string;
  /** buildArticleSearchKeyword(articleTitle) の結果 */
  articleKeyword?: string;
  /** CATEGORY_SEARCH_RULES[category].keywords */
  categoryKeywords?: string[];
  /** 生成するキーワードの最大数 */
  limit?: number;
}

export function buildProductMatchSearchKeywords({
  productName,
  baseKeyword = "",
  articleKeyword = "",
  categoryKeywords = [],
  limit = 6,
}: ProductMatchKeywordInput): string[] {
  const normalizedName = String(productName ?? "").normalize("NFKC").trim();
  const strippedName = stripCapacityForKeyword(normalizedName);
  const fallbackName = stripSizeAndCapacityForKeyword(normalizedName);
  const tokens = strippedName.split(/\s+/).filter(Boolean);

  // 一般名商品は入数・大容量訴求を足したキーワードを優先し、
  // 同等サイズのバルク品を候補に入れる。
  const quantityToken = extractQuantityToken(normalizedName);
  const genericBoostKeywords = strippedName && isGenericProductName(strippedName, categoryKeywords)
    ? [
        quantityToken ? `${strippedName} ${quantityToken}` : "",
        `${strippedName} 大容量`,
        `${strippedName} まとめ買い`,
      ]
    : [];

  return uniqueStrings([
    baseKeyword,
    strippedName,
    ...genericBoostKeywords,
    tokens.slice(0, 4).join(" "),
    tokens.slice(0, 3).join(" "),
    fallbackName,
    ...categoryKeywords.slice(0, 2),
    articleKeyword,
  ])
    .filter(keyword => keyword.length >= 2)
    .slice(0, limit);
}

/** 先頭キーワードに割り当てる候補数の上限（残りを後続キーワード用に確保する） */
export const RESERVED_CANDIDATE_SLOTS = 3;

/**
 * 先頭キーワードが候補枠を独占しないよう、キーワードごとの取得上限を返す。
 * 先頭キーワードだけ上限を下げ、後続キーワード用に枠を確保する。
 */
export function getCandidateSlotLimit(
  keywordIndex: number,
  keywordCount: number,
  maxCandidates: number,
): number {
  if (keywordIndex > 0 || keywordCount <= 1) return maxCandidates;
  const reserved = Math.min(RESERVED_CANDIDATE_SLOTS, Math.max(0, maxCandidates - 1));
  return maxCandidates - reserved;
}

export interface CandidateSelector<T> {
  /** 候補を1件差し出す。枠が埋まっていれば見送り扱いにする */
  offer(candidate: T, keywordIndex: number): void;
  /** これ以上受け付けられない（＝検索を打ち切ってよい）か */
  isFull(): boolean;
  /** 確保枠が余っていれば見送り分で補充して確定する */
  finish(): T[];
}

/**
 * 候補の採否を管理する。楽天APIを都度呼ぶ都合上、全件を集めてから選ぶのではなく
 * 1件ずつ差し出す形にしている。
 *
 * 先頭キーワード用の枠を絞って後続キーワードの枠を確保しつつ、後続が枠を
 * 埋められなかった場合は見送った先頭キーワードの候補で補充するため、
 * 最終件数は枠確保をしない場合より減らない。
 */
export function createCandidateSelector<T>(keywordCount: number, maxCandidates: number): CandidateSelector<T> {
  const selected: T[] = [];
  const deferred: T[] = [];

  return {
    offer(candidate, keywordIndex) {
      if (selected.length >= maxCandidates) return;
      const slotLimit = getCandidateSlotLimit(keywordIndex, keywordCount, maxCandidates);
      if (selected.length >= slotLimit) {
        deferred.push(candidate);
        return;
      }
      selected.push(candidate);
    },
    isFull() {
      return selected.length >= maxCandidates;
    },
    finish() {
      for (const candidate of deferred) {
        if (selected.length >= maxCandidates) break;
        selected.push(candidate);
      }
      return selected;
    },
  };
}
