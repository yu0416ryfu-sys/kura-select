/**
 * 入れ替えで外した記事（data/noindex-articles.json）のビルド後検査。計画書5 §4.4。
 *
 * - noindex の記事: HTML に `noindex,follow` があり、sitemap に載っていない
 * - それ以外の記事: HTML に robots noindex が無く、sitemap に載っている
 * どちらかが崩れたら exit 1（＝デプロイされない）。dist/articles/ が無いときは何もせず exit 0。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { getNoindexArticleSlugs, articleSlugFromUrl } from './lib/noindex-articles.mjs';

const ROOT = resolve(process.cwd());
const DIST = join(ROOT, 'dist');
const ARTICLES = join(DIST, 'articles');

function collectIndexHtml(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectIndexHtml(p));
    else if (name === 'index.html') out.push(p);
  }
  return out;
}

if (!existsSync(ARTICLES)) {
  console.log('[check-noindex-dist] dist/articles/ なし。スキップ');
  process.exit(0);
}

const noindexSlugs = getNoindexArticleSlugs();

// sitemap-0.xml などの本サイトマップに載っている記事 slug（一時サイトマップ sitemap-recrawl.xml は数えない）
const sitemapSlugs = new Set();
for (const name of readdirSync(DIST)) {
  if (!/^sitemap-\d+\.xml$/.test(name)) continue;
  for (const [, loc] of readFileSync(join(DIST, name), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const slug = articleSlugFromUrl(loc);
    if (slug) sitemapSlugs.add(slug);
  }
}

const errors = [];
let checked = 0;
const seen = new Set();
for (const file of collectIndexHtml(ARTICLES)) {
  // dist/articles/<slug>/index.html → <slug>（reviews/ 配下も含む）。一覧ページ dist/articles/index.html は除く
  const slug = relative(ARTICLES, file).replace(/\\/g, '/').replace(/\/?index\.html$/, '');
  if (!slug) continue;
  checked++;
  seen.add(slug);
  const robots = readFileSync(file, 'utf8').match(/<meta name="robots" content="([^"]+)"/)?.[1];
  if (noindexSlugs.has(slug)) {
    if (robots !== 'noindex,follow') errors.push(`${slug}: noindex 対象なのに robots が ${robots ?? '(なし)'}`);
    if (sitemapSlugs.has(slug)) errors.push(`${slug}: noindex 対象なのに sitemap に載っている`);
  } else {
    if (robots?.includes('noindex')) errors.push(`${slug}: noindex 対象外なのに robots が ${robots}`);
    if (!sitemapSlugs.has(slug)) errors.push(`${slug}: sitemap に載っていない`);
  }
}
for (const slug of noindexSlugs) {
  if (!seen.has(slug)) errors.push(`${slug}: data/noindex-articles.json にあるが dist に記事ページが無い`);
}

if (errors.length > 0) {
  for (const e of errors) console.error(`[check-noindex-dist] ${e}`);
  console.error(`[check-noindex-dist] 不整合 ${errors.length} 件`);
  process.exit(1);
}
console.log(`[check-noindex-dist] 記事 ${checked} ページ検査・noindex ${noindexSlugs.size} 本・不整合なし`);
