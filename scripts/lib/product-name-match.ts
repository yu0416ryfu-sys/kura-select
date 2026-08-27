/**
 * 記事 frontmatter の商品名と、楽天APIが返す実出品名の同一性判定。
 *
 * `update-products.mjs` から切り出した（低順位記事の底上げ Phase 1）。
 * `check-category-fit` が name-mismatch（商品名ドリフト）を本番と同じ定義で
 * 判定するために共有する。ここを複製して別実装を作らないこと。
 *
 * 切り出し時点で振る舞いは一切変えていない。
 */
import { buildSearchKeyword } from './frontmatter.ts';

/** 商品を特定しない一般語。トークンから落とさないと何にでも一致してしまう */
export const GENERIC_PRODUCT_NAME_TOKENS = new Set([
  'ゴミ袋',
  'ポリ袋',
  '袋',
  '送料無料',
  'セット',
  'パック',
  'まとめ買い',
  '大容量',
]);

/**
 * 商品名から「その商品を特定する語」だけを取り出す。
 * 2文字未満・一般語・数量表現（500ml / 3個 など）は落とす。
 */
export function getDistinctiveProductNameTokens(name: string): string[] {
  return buildSearchKeyword(name)
    .replace(/[【】［］\[\]（）()]/g, ' ')
    .split(/[\s　・、。／/｜|]+/)
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length >= 2)
    .filter(token => !GENERIC_PRODUCT_NAME_TOKENS.has(token))
    .filter(token => !/^[\d.,]+(?:ml|mL|l|L|g|kg|枚|本|袋|個|パック|セット|mm)?$/i.test(token));
}

/**
 * 記事の商品名と実出品名が同じ商品を指していそうかを判定する。
 *
 * strict=false（既定）は1語でも一致すれば true。strict=true は特徴語が
 * 2語以上あるとき2語一致を要求する。
 */
export function isLikelySameProductName(
  currentName: string,
  apiName: string,
  { strict = false }: { strict?: boolean } = {}
): boolean {
  const tokens = getDistinctiveProductNameTokens(currentName);
  if (tokens.length === 0) return true;
  const normalizedApiName = apiName.toLowerCase();
  if (strict) {
    const matched = tokens.filter(token => normalizedApiName.includes(token)).length;
    // 2語以上あるなら2語要求、1語しかない商品名は従来通り1語一致で許容
    const required = tokens.length >= 2 ? 2 : 1;
    return matched >= required;
  }
  return tokens.some(token => normalizedApiName.includes(token));
}
