/**
 * noindex にする記事（入れ替えで外した記事）の判定を1か所にまとめる。計画書5 §4.4。
 *
 * 判定の正は data/noindex-articles.json（slug・理由・日付）。記事 frontmatter とスキーマは変えない。
 * ArticleLayout.astro（noindex,follow を出す）と astro.config.mjs の sitemap filter の両方がここを使う。
 * ずれると「noindex なのに sitemap に載っている」状態になり GSC がエラー扱いにするので、
 * ビルド後に scripts/check-noindex-dist.mjs で突き合わせる。
 *
 * slug は article.id と同じ形（`-comparison` 付き・サブディレクトリなら `reviews/` 接頭辞あり）。
 * RSS・人気記事欄・関連記事・内部リンクからは外さない（follow でクロール経路を残す）。
 */
// JSON は import で読む。fs + import.meta.url だと、Astro のビルドで ArticleLayout に
// バンドルされたときに基準パスが dist 側へずれて読めなくなる（cwd 依存も避けられる）
import noindexArticles from "../../data/noindex-articles.json" with { type: "json" };

/** @returns {{ slug: string, reason: string, date: string }[]} */
export function readNoindexArticles() {
  return noindexArticles;
}

/** noindex にする記事の slug（article.id と同じ形）を Set で返す */
export function getNoindexArticleSlugs(entries = noindexArticles) {
  return new Set(entries.map((entry) => entry.slug));
}

/** 記事 URL から slug（article.id の形）を取り出す。記事 URL でなければ undefined */
export function articleSlugFromUrl(pageUrl) {
  return pageUrl.match(/\/articles\/(.+?)\/?$/)?.[1];
}

/** sitemap の filter 用。/articles/<slug>/ が noindex の記事なら true */
export function isNoindexArticleUrl(pageUrl, slugs = getNoindexArticleSlugs()) {
  const slug = articleSlugFromUrl(pageUrl);
  return slug !== undefined && slugs.has(slug);
}
