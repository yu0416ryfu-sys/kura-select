/**
 * 所属記事が1本以下の「薄いカテゴリ」の slug を返す。
 *
 * カテゴリページは記事カードを並べるだけなので、記事1本のカテゴリは
 * 実質「見出し + カード1枚」になり、検索エンジンにインデックスさせる価値がない。
 * それらを noindex にするのに合わせて、sitemap からも外す必要がある
 * （noindex なのに sitemap に載っていると GSC がエラー扱いにする）。
 *
 * astro.config.mjs は astro:content（仮想モジュール）を import できないため、
 * frontmatter を fs + 正規表現で直接読む。同ファイルの articleLastmod と同じ方式。
 *
 * 判定は src/pages/category/[slug].astro の getStaticPaths と一致していなければならない。
 * ずれると sitemap と noindex が食い違うので、tests/thin-categories.test.ts で検証する。
 */
import fs from "node:fs";
import path from "node:path";

export const ARTICLES_DIR = path.resolve("./src/content/articles");
export const CATEGORIES_DIR = path.resolve("./src/content/categories");

/** ファイル先頭の frontmatter ブロックだけを取り出す */
function readFrontmatter(filePath) {
  return fs.readFileSync(filePath, "utf-8").split(/^---\s*$/m)[1] ?? "";
}

/**
 * ディレクトリ配下の .md / .mdx を再帰的に列挙する。
 * src/content.config.ts の glob パターンが `**\/*.{md,mdx}` なので、
 * サブディレクトリ（src/content/articles/reviews/ など）も対象に含める。
 * ここを再帰しないと、サブディレクトリの記事が数えられず
 * カテゴリを誤って「薄い」と判定してしまう。
 */
function listContentFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listContentFiles(full));
    } else if (/\.mdx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * カテゴリのファイル ID → URL slug の対応表。
 * 記事の `category:` はファイル ID を指すが、カテゴリページの URL は `slug:` frontmatter を使う。
 * 現状は全件一致しているが、将来ずれたときに黙って壊れないよう slug を読む。
 */
export function getCategorySlugById(categoriesDir = CATEGORIES_DIR) {
  const slugById = new Map();
  for (const file of listContentFiles(categoriesDir)) {
    // Astro の content collection の ID は base からの相対パス（拡張子なし・区切りは /）
    const id = path
      .relative(categoriesDir, file)
      .replace(/\\/g, "/")
      .replace(/\.mdx?$/, "");
    const slug = readFrontmatter(file).match(/^slug:\s*"?([^"\r\n]+)"?/m)?.[1];
    slugById.set(id, (slug ?? id).trim());
  }
  return slugById;
}

/**
 * カテゴリのファイル ID → 公開記事数。
 * draft: true は [slug].astro の getStaticPaths と同様に数えない。
 */
export function getPublishedArticleCountByCategory(articlesDir = ARTICLES_DIR) {
  const countById = new Map();
  for (const file of listContentFiles(articlesDir)) {
    const frontmatter = readFrontmatter(file);
    if (/^draft:\s*true\s*$/m.test(frontmatter)) continue;
    const category = frontmatter.match(/^category:\s*"?([^"\r\n]+)"?/m)?.[1];
    if (!category) continue;
    const id = category.trim();
    countById.set(id, (countById.get(id) ?? 0) + 1);
  }
  return countById;
}

/**
 * 記事1本以下のカテゴリの slug を Set で返す。
 * 記事が0本のカテゴリ（md はあるが記事が紐づいていない）も含む。
 */
export function getThinCategorySlugs(
  articlesDir = ARTICLES_DIR,
  categoriesDir = CATEGORIES_DIR
) {
  const slugById = getCategorySlugById(categoriesDir);
  const countById = getPublishedArticleCountByCategory(articlesDir);

  const thin = new Set();
  for (const [id, slug] of slugById) {
    if ((countById.get(id) ?? 0) <= 1) thin.add(slug);
  }
  return thin;
}

/** sitemap の filter 用。/category/<slug>/ が薄いカテゴリなら true */
export function isThinCategoryUrl(pageUrl, thinSlugs = getThinCategorySlugs()) {
  const slug = pageUrl.match(/\/category\/([^/]+)\/?$/)?.[1];
  return slug !== undefined && thinSlugs.has(slug);
}
