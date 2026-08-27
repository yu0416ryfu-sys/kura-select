// カテゴリ適合スキャン CLI（低順位記事の底上げ Phase 1）
//
// 記事の既存商品が「いま この記事の追加候補として出てきたら採用されるか」を
// 本番と同じガード（stage1 → stage2 → stage4）で判定する。
// **楽天APIは叩かない**。判定は reports/item-names/item-names-*.jsonl の実出品名に対して行う。
// **記事 md は書き換えない**（レポートを出すだけ）。
//
// 使い方:
//   pnpm check-category-fit
//   pnpm check-category-fit -- --slug=laundry-gel-ball
//   pnpm check-category-fit -- --input=reports/item-names/item-names-2026-08-23.jsonl
//   pnpm check-category-fit -- --json
//
// 出力:
//   reports/category-fit/category-fit-<実行日>.md
//   reports/category-fit/category-fit-<実行日>.json
//
// 計画書: docs/IMPLEMENTATION_PLAN_LOW_RANK_ARTICLE_LIFT_2026-08-23.md §4.3 / §4.4
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractArticleTitle,
  extractArticleCategory,
  extractArticleType,
  isProductManagedArticle,
} from './lib/frontmatter.ts';
import { toSlug } from './lib/item-names.ts';
import { buildFitProducts, judgeArticle, summarize, formatFitReport } from './lib/category-fit.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTICLES_DIR = path.join(ROOT, 'src/content/articles');
const ITEM_NAMES_DIR = path.join(ROOT, 'reports/item-names');
const OUTPUT_DIR = path.join(ROOT, 'reports/category-fit');

/** レポート名は JST の日付にする（UTC だと日本時間の午前中に前日付になる） */
function todayJst() {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

function parseArgs(argv) {
  const get = prefix => argv.find(a => a.startsWith(prefix))?.split('=').slice(1).join('=') ?? null;
  return {
    slug: get('--slug='),
    input: get('--input='),
    json: argv.includes('--json'),
  };
}

/** --input 未指定なら reports/item-names/item-names-YYYY-MM-DD.jsonl の最新を使う */
function resolveInputPath(explicit) {
  if (explicit) {
    const full = path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit);
    if (!existsSync(full)) {
      console.error(`--input のファイルが見つかりません: ${explicit}`);
      process.exit(1);
    }
    return full;
  }
  if (!existsSync(ITEM_NAMES_DIR)) {
    console.error('reports/item-names/ がありません。先に `pnpm collect-item-names` を実行してください。');
    process.exit(1);
  }
  const candidates = readdirSync(ITEM_NAMES_DIR)
    .filter(name => /^item-names-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();
  if (candidates.length === 0) {
    console.error('item-names-YYYY-MM-DD.jsonl が見つかりません。先に `pnpm collect-item-names` を実行してください。');
    process.exit(1);
  }
  return path.join(ITEM_NAMES_DIR, candidates[candidates.length - 1]);
}

/** 実出品名を key（shopCode/itemCode 小文字）で引けるようにする */
function loadItemNames(inputPath) {
  const byKey = new Map();
  for (const line of readFileSync(inputPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // 壊れた行は捨てる（collect-item-names と同じ方針）
    }
    if (!row.key || !row.known || !row.itemName) continue;
    byKey.set(String(row.key).toLowerCase(), row);
  }
  return byKey;
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

/** 判定対象の記事を集める（サービス記事・レビュー記事・draft は本番と同じく対象外） */
function collectArticles() {
  const articles = [];
  const categoryCounts = new Map();

  for (const file of listArticleFiles(ARTICLES_DIR)) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const content = readFileSync(file, 'utf-8');
    if (!isProductManagedArticle(content)) continue;
    if (extractArticleType(content) === 'review') continue;
    if (/^draft:\s*true\s*$/m.test(content)) continue;

    const slug = toSlug(relative) ?? path.basename(file).replace(/\.mdx?$/, '');
    const category = extractArticleCategory(content) ?? slug;
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    articles.push({
      slug,
      articleFile: relative,
      fileName: path.basename(file),
      title: extractArticleTitle(content) ?? '',
      category,
      content,
    });
  }
  return { articles, categoryCounts };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const today = todayJst();
  const inputPath = resolveInputPath(options.input);
  const itemNames = loadItemNames(inputPath);

  const { articles, categoryCounts } = collectArticles();
  const targets = options.slug ? articles.filter(a => a.slug === options.slug) : articles;
  if (targets.length === 0) {
    console.error(options.slug ? `--slug=${options.slug} に一致する記事がありません。` : '対象記事がありません。');
    process.exit(1);
  }

  const results = targets.map(article => judgeArticle({
    slug: article.slug,
    // resolveArticleSearchRule の file は baseKeyword のフォールバックにしか使わないのでファイル名を渡す
    articleFile: article.fileName,
    title: article.title,
    category: article.category,
    articlesInCategory: categoryCounts.get(article.category) ?? 1,
    products: buildFitProducts(article.content, {
      slug: article.slug,
      articleFile: article.articleFile,
      itemNames,
    }),
  }));

  // articleFile はレポートに出すので記事の相対パスへ戻す
  for (let i = 0; i < results.length; i++) results[i].articleFile = targets[i].articleFile;

  const summary = summarize(results);
  const relativeInput = path.relative(ROOT, inputPath).split(path.sep).join('/');

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const suffix = options.slug ? `-${options.slug}` : '';
  const mdPath = path.join(OUTPUT_DIR, `category-fit${suffix}-${today}.md`);
  const jsonPath = path.join(OUTPUT_DIR, `category-fit${suffix}-${today}.json`);
  writeFileSync(mdPath, formatFitReport(results, summary, { today, inputPath: relativeInput }), 'utf-8');
  writeFileSync(jsonPath, JSON.stringify({ today, inputPath: relativeInput, summary, articles: results }, null, 2), 'utf-8');

  if (options.json) {
    console.log(JSON.stringify({ summary, mdPath: path.relative(ROOT, mdPath), jsonPath: path.relative(ROOT, jsonPath) }, null, 2));
    return;
  }

  const pct = value => (value === null ? '判定不能' : `${(value * 100).toFixed(1)}%`);
  console.log(`入力: ${relativeInput}`);
  console.log(`対象 ${summary.articles} 記事 / ${summary.products} 商品`);
  console.log(`判定できた ${summary.judged} 商品 ・ unknown（判定不能） ${summary.unknown} 商品`);
  console.log(`error ${summary.errors}（判定できた商品の ${pct(summary.errorRate)}） ・ warn ${summary.warns}`);
  console.log(`過半数 error の記事 ${summary.majorityErrorSlugs.length} 本` +
    (summary.majorityErrorSlugs.length ? `: ${summary.majorityErrorSlugs.join(', ')}` : ''));
  console.log(`ルール未定義 ${summary.ruleMissing.length} 本`);
  console.log(`出力: ${path.relative(ROOT, mdPath).split(path.sep).join('/')}`);
  console.log(`出力: ${path.relative(ROOT, jsonPath).split(path.sep).join('/')}`);
}

main();
