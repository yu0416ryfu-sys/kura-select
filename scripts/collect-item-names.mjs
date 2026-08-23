// 実出品名の集約 CLI（Phase 0.6）
//
// reports/ai-capacity-input-*.jsonl（85ファイル）を集約し、
// 現 frontmatter の全商品に突き合わせてカバー率を出す。
// 楽天APIは叩かない（欠損補完は update-products --dump-item-names 側）。
//
// 使い方:
//   pnpm collect-item-names
//   pnpm collect-item-names -- --slug=laundry-gel-ball   # 出力を1記事に絞る（カバー率は全体も併記）
//   pnpm collect-item-names -- --merge=reports/item-names/dump-laundry-gel-ball.jsonl
//
// 出力:
//   reports/item-names/item-names-<実行日>.jsonl  ← Phase 1 の --input
//   reports/item-names/coverage-<実行日>.md       ← カバー率レポート
//
// 計画書: docs/IMPLEMENTATION_PLAN_LOW_RANK_ARTICLE_LIFT_2026-08-23.md §4.2
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractAllProductsData } from './lib/frontmatter.ts';
import {
  aggregateItemNames,
  buildItemNameRows,
  summarizeCoverage,
  formatCoverageReport,
  toSlug,
} from './lib/item-names.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUTPUT_DIR = path.join(REPORTS_DIR, 'item-names');
const ARTICLES_DIR = path.join(ROOT, 'src/content/articles');

function parseArgs(argv) {
  const get = prefix => argv.find(a => a.startsWith(prefix))?.split('=').slice(1).join('=') ?? null;
  return {
    slug: get('--slug='),
    // --dump-item-names で回収した JSONL を追加の集約ソースとして混ぜる（複数可）
    merge: argv.filter(a => a.startsWith('--merge=')).map(a => a.split('=').slice(1).join('=')),
    json: argv.includes('--json'),
  };
}

/** 記事 .md を再帰列挙する */
function listArticleFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listArticleFiles(full));
    else if (/\.mdx?$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

/** 現 frontmatter の全商品（母数）を集める */
function collectCurrentProducts() {
  const products = [];
  for (const file of listArticleFiles(ARTICLES_DIR)) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const slug = toSlug(relative);
    const content = readFileSync(file, 'utf-8');
    for (const product of extractAllProductsData(content)) {
      products.push({
        articleFile: relative,
        slug: slug ?? '',
        rank: product.rank,
        name: product.name,
        rakutenUrl: product.rakutenUrl,
      });
    }
  }
  return products;
}

/** reports/ai-capacity-input-YYYY-MM-DD.jsonl を全部読む */
function collectJsonlSources() {
  const sources = [];
  for (const name of readdirSync(REPORTS_DIR)) {
    const matched = name.match(/^ai-capacity-input-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!matched) continue;
    sources.push({ date: matched[1], text: readFileSync(path.join(REPORTS_DIR, name), 'utf-8') });
  }
  return sources;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);

  const sources = collectJsonlSources();
  // --dump-item-names の回収ファイルは常に最新扱いにして既存値を上書きする
  for (const file of options.merge) {
    const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
    if (!existsSync(full)) {
      console.error(`--merge のファイルが見つかりません: ${file}`);
      process.exit(1);
    }
    sources.push({ date: '9999-12-31', text: readFileSync(full, 'utf-8') });
  }

  const aggregated = aggregateItemNames(sources);
  const currentProducts = collectCurrentProducts();
  const allRows = buildItemNameRows(aggregated, currentProducts);
  const summary = summarizeCoverage(allRows);

  const rows = options.slug ? allRows.filter(r => r.slug === options.slug) : allRows;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const jsonlName = options.slug
    ? `item-names-${options.slug}-${today}.jsonl`
    : `item-names-${today}.jsonl`;
  const jsonlPath = path.join(OUTPUT_DIR, jsonlName);
  writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

  const relativeJsonl = path.relative(ROOT, jsonlPath).split(path.sep).join('/');
  const reportPath = path.join(OUTPUT_DIR, `coverage-${today}.md`);
  writeFileSync(
    reportPath,
    formatCoverageReport(summary, {
      today,
      sourceFileCount: sources.length,
      jsonlPath: relativeJsonl,
    }),
    'utf-8'
  );

  if (options.json) {
    console.log(JSON.stringify({ summary, jsonlPath: relativeJsonl, rows: rows.length }, null, 2));
    return;
  }

  console.log(`集約元: ai-capacity-input-*.jsonl ${sources.length - options.merge.length} ファイル`
    + (options.merge.length ? ` + 補完 ${options.merge.length} ファイル` : ''));
  console.log(`母数 ${summary.total} 商品 / 実出品名あり ${summary.known}（${(summary.coverage * 100).toFixed(1)}%）`);
  console.log(`unknown（判定不能） ${summary.unknown} 商品 ・ 履歴のみのエントリ ${summary.historical} 件`);
  if (options.slug) {
    const target = rows.filter(r => r.inCurrent);
    const known = target.filter(r => r.known).length;
    console.log(`--slug=${options.slug}: 現商品 ${target.length} 件中 ${known} 件に実出品名あり`
      + `（履歴のみ ${rows.length - target.length} 件を併せて出力）`);
  }
  console.log(`出力: ${relativeJsonl}`);
  console.log(`出力: ${path.relative(ROOT, reportPath).split(path.sep).join('/')}`);
}

main();
