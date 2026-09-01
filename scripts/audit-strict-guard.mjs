// isLikelySameProductName を strict:true に上げたときの影響を、実出品名の JSONL から見積もる
// 使い方: node --experimental-strip-types scripts/audit-strict-guard.mjs [--input=reports/item-names/xxx.jsonl]
//
// 記事は一切書き換えない。出力は標準出力 + reports/rank1-audit/strict-guard-<日付>.md
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractAllProductsData, extractProductSnapshotByRank } from './lib/frontmatter.ts';
import { toRakutenUrlKey } from './lib/rakuten-url.ts';
import { isLikelySameProductName, getDistinctiveProductNameTokens } from './lib/product-name-match.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTICLES_DIR = path.join(ROOT, 'src/content/articles');

const inputArg = process.argv.find((a) => a.startsWith('--input='))?.split('=').slice(1).join('=');
const inputPath = inputArg
  ? path.resolve(ROOT, inputArg)
  : path.join(ROOT, 'reports/item-names', readdirSync(path.join(ROOT, 'reports/item-names')).filter((f) => f.endsWith('.jsonl')).sort().pop());
if (!existsSync(inputPath)) {
  console.error('入力 JSONL が見つかりません: ' + inputPath);
  process.exit(1);
}

// key(shopCode/itemCode) → 実出品名
const byKey = new Map();
for (const line of readFileSync(inputPath, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  const itemName = row.itemName ?? row.api?.itemName ?? null;
  const key = (row.key ?? toRakutenUrlKey(row.current?.rakutenUrl) ?? '').toLowerCase();
  if (!key || !itemName) continue;
  if (row.known === false) continue;
  byKey.set(key, { itemName, method: row.method ?? null, sourceDate: row.sourceDate ?? row.dumpedAt ?? null });
}

function listArticleFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listArticleFiles(full));
    else if (/\.mdx?$/.test(e.name)) out.push(full);
  }
  return out.sort();
}

const rows = [];
for (const file of listArticleFiles(ARTICLES_DIR)) {
  const content = readFileSync(file, 'utf-8');
  const slug = path.basename(file).replace(/-comparison\.mdx?$/, '').replace(/\.mdx?$/, '');
  for (const p of extractAllProductsData(content)) {
    const snap = p.rank != null ? extractProductSnapshotByRank(content, p.rank) : null;
    const key = toRakutenUrlKey(p.rakutenUrl ?? snap?.rakutenUrl);
    const hit = key ? byKey.get(key) : null;
    if (!hit) continue;
    const loose = isLikelySameProductName(p.name, hit.itemName);
    const strict = isLikelySameProductName(p.name, hit.itemName, { strict: true });
    const tokens = getDistinctiveProductNameTokens(p.name);
    rows.push({
      slug, rank: p.rank, name: p.name, itemName: hit.itemName,
      method: hit.method, sourceDate: hit.sourceDate,
      loose, strict, tokens,
      matched: tokens.filter((t) => hit.itemName.toLowerCase().includes(t)).length,
    });
  }
}

const newlyRejected = rows.filter((r) => r.loose && !r.strict);
const alreadyRejected = rows.filter((r) => !r.loose);

const lines = [];
lines.push('# 同一性ガードを strict:true にしたときの影響見積もり');
lines.push('');
lines.push('- 入力: ' + path.relative(ROOT, inputPath).split(path.sep).join('/'));
lines.push('- 判定できた商品: ' + rows.length + ' 件（実出品名が JSONL にある商品のみ）');
lines.push('- 現行 loose で既にスキップされる: ' + alreadyRejected.length + ' 件');
lines.push('- **strict にすると新たにスキップされる: ' + newlyRejected.length + ' 件**');
lines.push('');
lines.push('## strict で新たにスキップされる商品');
lines.push('');
lines.push('| 記事 | rank | 記事の商品名 | 実出品名 | 特徴語 | 一致語数 |');
lines.push('|---|---|---|---|---|---|');
for (const r of newlyRejected.sort((a, b) => a.slug.localeCompare(b.slug) || a.rank - b.rank)) {
  lines.push('| ' + [
    r.slug, r.rank,
    String(r.name).replace(/\|/g, '\\|'),
    String(r.itemName).slice(0, 90).replace(/\|/g, '\\|'),
    r.tokens.join(' / ').replace(/\|/g, '\\|'),
    r.matched + '/' + r.tokens.length,
  ].join(' | ') + ' |');
}

const outDir = path.join(ROOT, 'reports/rank1-audit');
mkdirSync(outDir, { recursive: true });
const today = new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
const outPath = path.join(outDir, 'strict-guard-' + today + '.md');
writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');

console.log('入力: ' + path.relative(ROOT, inputPath).split(path.sep).join('/'));
console.log('判定できた商品 ' + rows.length + ' 件 / 現行スキップ ' + alreadyRejected.length + ' 件 / strict で新規スキップ ' + newlyRejected.length + ' 件');
console.log('出力: ' + path.relative(ROOT, outPath).split(path.sep).join('/'));
