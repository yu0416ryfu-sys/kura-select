import type { CollectionEntry } from "astro:content";

type ArticleData = CollectionEntry<"articles">["data"];

/**
 * 記事の products[] を安全に取得する。
 * サービス記事（articleType: service）は products を持たず、
 * レビュー記事でも任意のため、参照側は必ずこの関数を経由する。
 */
export function getArticleProducts(data: ArticleData) {
  return "products" in data && Array.isArray(data.products) ? data.products : [];
}

/**
 * 記事の services[] を安全に取得する（サービス記事以外は空配列）。
 */
export function getArticleServices(data: ArticleData) {
  return "services" in data && Array.isArray(data.services) ? data.services : [];
}

/**
 * 記事カードに出す比較件数ラベル。
 * サービス記事は「◯サービスを比較」、それ以外は「◯商品を比較」。
 */
export function getCompareCountLabel(data: ArticleData): string {
  const services = getArticleServices(data);
  if (services.length > 0) return `${services.length}サービスを比較`;
  return `${getArticleProducts(data).length}商品を比較`;
}
