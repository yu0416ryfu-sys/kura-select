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

/**
 * 薄いカテゴリの noindex が本番に出た時刻（5a9b1ef のデプロイ成功 05:52Z に余裕を持たせた値）。
 * これより後のクロールなら noindex を読んでいるはず、と判定する境界。
 * 余裕を見て遅めに置く（早めに置くと、noindex を読んでいないクロールを「読んだ」と誤判定する）。
 */
export const NOINDEX_DEPLOYED_AT = "2026-08-14T06:00:00Z"; // = 15:00 JST

/** カテゴリのファイル ID → 公開記事の最古の publishedAt（YYYY-MM-DD）。draft と日付なしは除く */
function getEarliestPublishedAtByCategory(articlesDir) {
  const earliestById = new Map();
  for (const file of listContentFiles(articlesDir)) {
    const frontmatter = readFrontmatter(file);
    if (/^draft:\s*true\s*$/m.test(frontmatter)) continue;
    const category = frontmatter.match(/^category:\s*"?([^"\r\n]+)"?/m)?.[1];
    const published = frontmatter.match(/^publishedAt:\s*"?([\d-]+)"?/m)?.[1];
    if (!category || !published) continue;
    const id = category.trim();
    const current = earliestById.get(id);
    if (current === undefined || published < current) earliestById.set(id, published);
  }
  return earliestById;
}

/**
 * 一時サイトマップ（src/pages/sitemap-recrawl.xml.ts）用の行を返す。
 * lastmod は「そのページが最後に意味のある変化をした時点」として、
 * noindex デプロイ時刻とカテゴリ内の最初の公開記事の publishedAt の遅いほうを使う。
 * - 08-14 より後に新設されたカテゴリに 08-14 を付けると、存在しなかった日付を宣言することになる
 * - updatedAt は cron の価格更新で毎週動くが、カテゴリページの見た目は変わらないので使わない
 * - デプロイ時刻は時刻つきで出す（日付だけだと、同日のデプロイ前クロールより古く見える）
 *
 * @returns {{ slug: string, lastmod: string }[]} slug 昇順
 */
export function getThinCategoryRecrawlEntries(
  articlesDir = ARTICLES_DIR,
  categoriesDir = CATEGORIES_DIR
) {
  const thinSlugs = getThinCategorySlugs(articlesDir, categoriesDir);
  const earliestById = getEarliestPublishedAtByCategory(articlesDir);
  const deployedAt = new Date(NOINDEX_DEPLOYED_AT).getTime();

  const entries = [];
  // 最古日はファイル ID ごとに集まり、薄い判定は slug で返るので、ID を回して slug で絞る
  for (const [id, slug] of getCategorySlugById(categoriesDir)) {
    if (!thinSlugs.has(slug)) continue;
    const published = earliestById.get(id);
    const lastmod =
      published !== undefined && new Date(published).getTime() > deployedAt
        ? published
        : NOINDEX_DEPLOYED_AT;
    entries.push({ slug, lastmod });
  }
  return entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}
