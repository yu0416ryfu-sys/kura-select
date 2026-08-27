// 内部リンクグラフ CLI（低順位記事の底上げ Phase 2）
//
// `pnpm build` 後の dist/articles/**/index.html から記事間リンクを数え、
// 孤立ページ・本文被リンクなし・出リンクなしを洗い出す。
// **記事 md は書き換えない**（レポートを出すだけ）。
//
// 使い方:
//   pnpm build && pnpm check-internal-links
//   pnpm check-internal-links -- --json
//
// 出力:
//   reports/internal-links/internal-links-<実行日>.md / .json
//
// 計画書: docs/IMPLEMENTATION_PLAN_LOW_RANK_ARTICLE_LIFT_2026-08-23.md §5
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractArticleCategory } from './lib/frontmatter.ts';
import {
  extractPageLinks,
  buildLinkGraph,
  summarizeLinks,
  suggestLinkSources,
  formatLinkReport,
} from './lib/internal-links.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_ARTICLES = path.join(ROOT, 'dist/articles');
const ARTICLES_DIR = path.join(ROOT, 'src/content/articles');
const HOLDS_PATH = path.join(ROOT, 'data/measurement-holds.json');
const OUTPUT_DIR = path.join(ROOT, 'reports/internal-links');

/** レポート名は JST の日付にする（UTC だと日本時間の午前中に前日付になる） */
function todayJst() {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

function formatJst(date) {
  return new Intl.DateTimeFormat('sv', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

/** dist/articles 配下の index.html を再帰列挙する（reviews/ など1階層深いものも拾う） */
function listBuiltArticles(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    const slug = prefix ? `${prefix}/${entry.name}` : entry.name;
    const indexPath = path.join(full, 'index.html');
    if (existsSync(indexPath)) found.push({ slug, indexPath });
    found.push(...listBuiltArticles(full, slug));
  }
  return found.sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

/** frontmatter の tags を配列で取る */
function extractTags(content) {
  const block = content.match(/^tags:[ \t]*\r?\n((?:[ \t]+-[ \t]+.*\r?\n)+)/m);
  if (!block) return [];
  return [...block[1].matchAll(/^[ \t]+-[ \t]+"?([^"\r\n]+?)"?[ \t]*$/gm)]
    .map(match => match[1].trim())
    .filter(Boolean);
}

/**
 * 記事 slug → { category, tags } を frontmatter から引く（リンク追加候補の絞り込み用）。
 *
 * **キーは dist 側の slug に合わせる**＝ファイル名から拡張子だけを落とした形
 * （`hand-soap-comparison`）。`toSlug()` は `-comparison` まで落とすため
 * （`hand-soap`）、そのまま使うと dist の slug と一致せず全記事が
 * 「カテゴリ不明」になり、推奨リンク元が全記事同じになる。
 */
function collectArticleMeta() {
  const map = new Map();
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, prefix ? `${prefix}/${entry.name}` : entry.name); continue; }
      if (!/\.mdx?$/.test(entry.name)) continue;
      const base = entry.name.replace(/\.mdx?$/, '');
      const slug = prefix ? `${prefix}/${base}` : base;
      const content = readFileSync(full, 'utf-8');
      map.set(slug, { category: extractArticleCategory(content) ?? null, tags: extractTags(content) });
    }
  };
  walk(ARTICLES_DIR);
  return map;
}

/**
 * 凍結台帳を読む。未整備なら available:false で動かす。
 * 台帳が単一の正になるまでは、実際にリンクを足す前にメモリ側を必ず確認すること。
 */
function loadHolds() {
  if (!existsSync(HOLDS_PATH)) return { frozenSlugs: new Set(), available: false };
  try {
    const parsed = JSON.parse(readFileSync(HOLDS_PATH, 'utf-8'));
    const rows = Array.isArray(parsed) ? parsed : (parsed.holds ?? []);
    const today = todayJst();
    const frozen = rows
      .filter(row => !row.releaseDate || String(row.releaseDate) > today)
      .flatMap(row => (Array.isArray(row.slugs) ? row.slugs : [row.slug]))
      .filter(Boolean);
    return { frozenSlugs: new Set(frozen), available: true };
  } catch (error) {
    console.error(`data/measurement-holds.json の読み込みに失敗: ${error instanceof Error ? error.message : error}`);
    return { frozenSlugs: new Set(), available: false };
  }
}

function main() {
  const options = { json: process.argv.includes('--json') };

  if (!existsSync(DIST_ARTICLES)) {
    console.error('dist/articles がありません。先に `pnpm build` を実行してください。');
    process.exit(1);
  }

  const built = listBuiltArticles(DIST_ARTICLES);
  if (built.length === 0) {
    console.error('dist/articles に index.html がありません。`pnpm build` の成果物を確認してください。');
    process.exit(1);
  }

  // dist の鮮度はレポートに必ず書く（古い dist で数えると実態とずれる・§5.2）
  const builtAt = formatJst(statSync(built[0].indexPath).mtime);

  const pages = built.map(({ slug, indexPath }) => extractPageLinks(slug, readFileSync(indexPath, 'utf-8')));
  const graph = buildLinkGraph(pages);
  const summary = summarizeLinks(graph);
  const holds = loadHolds();
  const suggestions = suggestLinkSources(graph.stats, collectArticleMeta(), holds);

  const today = todayJst();
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const mdPath = path.join(OUTPUT_DIR, `internal-links-${today}.md`);
  const jsonPath = path.join(OUTPUT_DIR, `internal-links-${today}.json`);
  writeFileSync(mdPath, formatLinkReport(graph, summary, suggestions, holds, { today, builtAt }), 'utf-8');
  writeFileSync(jsonPath, JSON.stringify({ today, builtAt, summary, stats: graph.stats, suggestions }, null, 2), 'utf-8');

  if (options.json) {
    console.log(JSON.stringify({ summary, mdPath: path.relative(ROOT, mdPath), jsonPath: path.relative(ROOT, jsonPath) }, null, 2));
    return;
  }

  console.log(`dist のビルド時刻: ${builtAt}`);
  console.log(`集計 ${summary.pages} ページ（comparison ${summary.comparisonPages}本）`);
  console.log(`本文リンク ${summary.bodyLinks} 本 / 自動関連 ${summary.autoLinks} 本`);
  console.log(`孤立 ${summary.isolated} 本（${(summary.isolatedRate * 100).toFixed(1)}%） / 本文被リンクなし ${summary.noInboundBody} 本 / 出リンクなし ${summary.noOutboundBody} 本`);
  if (summary.isolatedRate > 0.2) {
    console.log('⚠️ 孤立が20%超。§5.4 によりリンクを足す前に分類方法を見直すこと。');
  }
  if (!holds.available) {
    console.log('⚠️ data/measurement-holds.json が無いため凍結判定なし。実施前にメモリ project_measurement_holds を開くこと。');
  }
  console.log(`出力: ${path.relative(ROOT, mdPath).split(path.sep).join('/')}`);
  console.log(`出力: ${path.relative(ROOT, jsonPath).split(path.sep).join('/')}`);
}

main();
