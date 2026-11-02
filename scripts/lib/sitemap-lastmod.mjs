/**
 * sitemap の記事 lastmod を作る。計画書5 §3.3-5。
 *
 * lastmod は「読者に見える内容が変わった日」= 台帳 data/content-dates.json の contentUpdatedAt。
 * 台帳に無い記事は publishedAt。frontmatter の updatedAt は価格同期のたびに進むので使わない
 * （ほぼ全記事が毎週「更新」を宣言すると、Google が lastmod 自体を信用しなくなるため）。
 *
 * astro.config.mjs は astro:content を import できないので、thin-categories.mjs と同じく
 * frontmatter を fs + 正規表現で読む。reviews/ 配下も含める（キーは article.id の形）。
 */
import fs from "node:fs";
import path from "node:path";
import { ARTICLES_DIR, listContentFiles } from "./thin-categories.mjs";

export const CONTENT_DATES_PATH = path.resolve("./data/content-dates.json");

/** 台帳を読む。ファイルが無ければ空 */
export function readContentDatesLedger(filePath = CONTENT_DATES_PATH) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * slug（article.id の形）→ lastmod（ISO 文字列）の Map を返す
 * @param {{ articlesDir?: string, ledger?: Record<string, { contentUpdatedAt: string }> }} [options]
 */
export function buildArticleLastmod({ articlesDir = ARTICLES_DIR, ledger = readContentDatesLedger() } = {}) {
  const lastmod = new Map();
  for (const file of listContentFiles(articlesDir)) {
    const slug = path.relative(articlesDir, file).replace(/\\/g, "/").replace(/\.mdx?$/, "");
    const frontmatter = fs.readFileSync(file, "utf-8").split(/^---\s*$/m)[1] ?? "";
    const published = frontmatter.match(/^publishedAt:\s*"?([\d-]+)"?/m)?.[1];
    const date = ledger[slug]?.contentUpdatedAt ?? published;
    if (date) lastmod.set(slug, new Date(date).toISOString());
  }
  return lastmod;
}
