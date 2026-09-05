// 楽天ジャンル適合スキャン CLI（カテゴリ混入検出の第2証拠）
//
// 記事 frontmatter の products[].genreId（楽天が返した事実）を
// data/article-genres.json の期待ジャンル（人間の判断）と突き合わせる。
// **楽天APIは叩かない**（frontmatter を読むだけ）。**記事 md は書き換えない**。
//
// 使い方:
//   pnpm check-genre-fit
//   pnpm check-genre-fit -- --slug=garbage-bag
//   pnpm check-genre-fit -- --json
//
// 出力:
//   reports/genre-fit/genre-fit-<実行日>.md
//   reports/genre-fit/genre-fit-<実行日>.json
//
// 計画書: docs/IMPLEMENTATION_PLAN_RAKUTEN_GENRE_ID_2026-09-05.md §3.6
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractAllProductsData,
  extractArticleType,
  isProductManagedArticle,
} from './lib/frontmatter.ts';
import { toSlug } from './lib/item-names.ts';
import { loadHolds, todayJst } from './lib/measurement-holds.ts';
import {
  normalizePolicy,
  judgeArticleGenres,
  summarizeGenreFit,
  formatGenreFitReport,
} from './lib/genre-fit.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTICLES_DIR = path.join(ROOT, 'src/content/articles');
const HOLDS_PATH = path.join(ROOT, 'data/measurement-holds.json');
const GENRES_PATH = path.join(ROOT, 'data/article-genres.json');
const OUTPUT_DIR = path.join(ROOT, 'reports/genre-fit');

function parseArgs(argv) {
  const get = prefix => argv.find(a => a.startsWith(prefix))?.split('=').slice(1).join('=') ?? null;
  return {
    slug: get('--slug='),
    json: argv.includes('--json'),
  };
}

function listArticleFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listArticleFiles(full));
    else if (/\.mdx?$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

/** 判定対象の記事を集める（サービス記事・レビュー記事・draft は対象外。check-category-fit と同条件） */
function collectArticles() {
  const articles = [];
  for (const file of listArticleFiles(ARTICLES_DIR)) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const content = readFileSync(file, 'utf-8');
    if (!isProductManagedArticle(content)) continue;
    if (extractArticleType(content) === 'review') continue;
    if (/^draft:\s*true\s*$/m.test(content)) continue;

    const slug = toSlug(relative) ?? path.basename(file).replace(/\.mdx?$/, '');
    articles.push({
      slug,
      // 凍結台帳の slug は `-comparison` 付きで記帳されているので両方で引く
      fileSlug: path.basename(file).replace(/\.mdx?$/, ''),
      articleFile: relative,
      products: extractAllProductsData(content)
        .map(product => ({ rank: product.rank, name: product.name, genreId: product.genreId })),
    });
  }
  return articles;
}

/** data/article-genres.json を読む。無ければ全記事 unconfigured として動く */
function loadArticleGenres() {
  if (!existsSync(GENRES_PATH)) return { policies: new Map(), available: false };
  try {
    const parsed = JSON.parse(readFileSync(GENRES_PATH, 'utf-8'));
    const entries = Object.entries(parsed?.articles ?? {});
    const policies = new Map();
    for (const [slug, raw] of entries) {
      const policy = normalizePolicy(raw);
      if (policy) policies.set(slug, policy);
    }
    return { policies, available: true };
  } catch (error) {
    console.error(`data/article-genres.json の読み込みに失敗: ${error instanceof Error ? error.message : error}`);
    return { policies: new Map(), available: false };
  }
}

/**
 * 凍結中なら着手可能日（releaseDate をそのまま）、期限なし凍結なら 'open-ended'、
 * 凍結していなければ null。⚠️ releaseDate は「解除日」ではなく「この日から編集してよい日」。
 */
function resolveHold(holds, article) {
  const key = [article.slug, article.fileSlug].find(candidate => holds.frozenSlugs.has(candidate));
  if (!key) return null;
  return holds.releaseDateBySlug.get(key) ?? 'open-ended';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const today = todayJst();
  const holds = loadHolds(HOLDS_PATH, today);
  const genres = loadArticleGenres();

  const articles = collectArticles();
  const targets = options.slug ? articles.filter(a => a.slug === options.slug) : articles;
  if (targets.length === 0) {
    console.error(options.slug ? `--slug=${options.slug} に一致する記事がありません。` : '対象記事がありません。');
    process.exit(1);
  }

  const results = targets.map(article => ({
    ...judgeArticleGenres({
      slug: article.slug,
      products: article.products,
      policy: genres.policies.get(article.slug) ?? null,
      heldUntil: resolveHold(holds, article),
    }),
    articleFile: article.articleFile,
  }));
  const summary = summarizeGenreFit(results);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const suffix = options.slug ? `-${options.slug}` : '';
  const mdPath = path.join(OUTPUT_DIR, `genre-fit${suffix}-${today}.md`);
  const jsonPath = path.join(OUTPUT_DIR, `genre-fit${suffix}-${today}.json`);
  writeFileSync(mdPath, formatGenreFitReport(results, summary, { today }), 'utf-8');
  writeFileSync(jsonPath, JSON.stringify({ today, summary, articles: results }, null, 2), 'utf-8');

  if (options.json) {
    console.log(JSON.stringify({ summary, mdPath: path.relative(ROOT, mdPath), jsonPath: path.relative(ROOT, jsonPath) }, null, 2));
    return;
  }

  const label = article => `${article.slug}(${article.outliers})`;
  const contamination = results.filter(a => a.code === 'contamination');
  const actionable = contamination.filter(a => a.heldUntil === null);
  const heldBack = contamination.filter(a => a.heldUntil !== null);
  const designReview = results.filter(a => a.code === 'design-review');
  const unconfigured = results.filter(a => a.code === 'unconfigured');
  const noData = results.filter(a => a.code === 'no-data');

  console.log(`対象 ${summary.articles} 記事 / ${summary.products} 商品（genreId 取得済み ${summary.withGenre}）`);
  console.log(`■ 混入候補（今すぐ着手可）        ${actionable.length}件   ${actionable.map(label).join(' ')}`);
  console.log(`■ 混入候補（凍結中）              ${heldBack.length}件   ` +
    heldBack.map(a => `${label(a)}→${a.heldUntil === 'open-ended' ? '期限なし' : `${a.heldUntil} 以降`}`).join(' '));
  console.log(`■ 記事設計の要判断                ${designReview.length}件   ${designReview.map(a => a.slug).join(' ')}`);
  console.log(`■ 期待ジャンル未設定              ${unconfigured.length}件  （--json で提案値を確認）`);
  console.log(`■ genreId 未取得                  ${noData.length}件`);
  if (!holds.available) {
    console.log('⚠️ data/measurement-holds.json が無いため凍結判定なし。着手前にメモリ project_measurement_holds を開くこと。');
  }
  if (!genres.available) {
    console.log('⚠️ data/article-genres.json が無いため全記事が「期待ジャンル未設定」です。');
  }
  console.log('⚠️ 凍結判定に prohibitions は含めていない。混入是正は商品構成の変更（区分D）なので最終確認はメモリ側で行うこと。');
  console.log(`出力: ${path.relative(ROOT, mdPath).split(path.sep).join('/')}`);
  console.log(`出力: ${path.relative(ROOT, jsonPath).split(path.sep).join('/')}`);
}

main();
