/**
 * 日用品価格レポートの集計スクリプト（計画書6）。
 *
 * data/price-history/**\/*.jsonl を読み、集計済み JSON を data/price-report/<as-of>.json に書き出す。
 * 集計の入力はすべてコミット済みファイル（reports/ は --refresh-price-range のときだけ読む）。
 * **記事ファイル・frontmatter は一切変更しない**。
 *
 * 使い方:
 *   pnpm price-report -- --as-of=2026-10-11                         # 集計して JSON を書く
 *   pnpm price-report -- --as-of=2026-10-11 --refresh-price-range   # 価格帯の名簿を作り直してから集計（追加のみ）
 *   pnpm price-report:dry -- --as-of=2026-10-11                     # 書き込みなしで要約だけ
 *   pnpm price-report -- --check-links --issue=2026-10              # 号のリンク先を凍結台帳・薄いカテゴリと突き合わせる
 *   オプション: --list-suspects（原因不明型の単発の外れを一覧表示。第3段の登録用）
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { parseFrontmatter } from './lib/frontmatter.ts';
import { parseJsonl, collectArticleFiles, toArticleId } from './lib/price-history.ts';
import { loadHolds, todayJst } from './lib/measurement-holds.ts';
import { getThinCategorySlugs } from './lib/thin-categories.mjs';
import { extractRakutenItemCode } from '../src/lib/price-history.ts';
import {
  buildPriceReport,
  findFrozenLinks,
  groupSeries,
  listSuspects,
  normalizeItemCode,
} from '../src/lib/price-report.ts';

const ROOT = resolve(process.cwd());
const HISTORY_DIR = join(ROOT, 'data', 'price-history');
const REPORT_DIR = join(ROOT, 'data', 'price-report');
const ARTICLES_DIR = join(ROOT, 'src', 'content', 'articles');
const PRICE_RANGE_PATH = join(REPORT_DIR, 'price-range-items.json');
const EXCLUSIONS_PATH = join(REPORT_DIR, 'exclusions.json');
const GROUPS_PATH = join(REPORT_DIR, 'category-groups.json');
const HOLDS_PATH = join(ROOT, 'data', 'measurement-holds.json');
const AUDIT_PATH = 'reports/product-data-audit-2026-08-28.json';

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name) => args.includes(`--${name}`);

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ── --check-links ────────────────────────────────────────────────────────

if (flag('check-links')) {
  const issue = arg('issue');
  if (!issue || !/^\d{4}-\d{2}$/.test(issue)) {
    console.error('--check-links には --issue=YYYY-MM が必要です');
    process.exit(1);
  }
  const linksPath = join(REPORT_DIR, `links-${issue}.json`);
  if (!existsSync(linksPath)) {
    console.error(`${linksPath} がありません`);
    process.exit(1);
  }
  const links = readJson(linksPath);
  const today = todayJst();
  const holds = loadHolds(HOLDS_PATH, today);
  if (!holds.available) {
    console.error('凍結台帳を読めませんでした。判定できないので失敗させます');
    process.exit(1);
  }
  const frozen = findFrozenLinks(links.articles ?? [], holds.frozenSlugs);
  const thin = getThinCategorySlugs();
  const thinHits = (links.categories ?? []).filter((c) => thin.has(c));
  console.log(`[check-links] 号 ${issue}・判定日 ${today}`);
  console.log(`  記事リンク ${links.articles?.length ?? 0} 件・うち凍結中 ${frozen.length} 件`);
  console.log(`  カテゴリリンク ${links.categories?.length ?? 0} 件・うち noindex ${thinHits.length} 件`);
  for (const s of frozen) console.error(`  ✗ 凍結中の記事: ${s}`);
  for (const s of thinHits) console.error(`  ✗ noindex のカテゴリ: ${s}`);
  process.exit(frozen.length + thinHits.length > 0 ? 1 : 0);
}

// ── 集計 ─────────────────────────────────────────────────────────────────

const asOf = arg('as-of');
if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error('--as-of=YYYY-MM-DD が必要です');
  process.exit(1);
}
const dryRun = flag('dry-run');

/** data/price-history/ をサブディレクトリまで再帰して読む */
function readAllHistory(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAllHistory(p));
    else if (entry.name.endsWith('.jsonl')) out.push(...parseJsonl(readFileSync(p, 'utf8')));
  }
  return out;
}

/** articleId → category・および frontmatter の priceMax を持つ商品の itemCode */
function readArticles() {
  const articleCategory = {};
  const priceMaxCodes = new Set();
  for (const { relPath, fullPath } of collectArticleFiles(ARTICLES_DIR)) {
    const parsed = parseFrontmatter(readFileSync(fullPath, 'utf8'));
    if (!parsed) continue;
    const category = parsed.data.category;
    if (typeof category === 'string' && category) articleCategory[toArticleId(relPath)] = category.trim();
    for (const p of Array.isArray(parsed.data.products) ? parsed.data.products : []) {
      if (p && p.priceMax != null) {
        const code = normalizeItemCode(extractRakutenItemCode(p.rakutenUrl));
        if (code) priceMaxCodes.add(code);
      }
    }
  }
  return { articleCategory, priceMaxCodes };
}

/** 価格帯の出品の名簿を作り直す（追加のみ・削除しない） */
function refreshPriceRange(priceMaxCodes) {
  if (!existsSync(join(ROOT, AUDIT_PATH))) {
    console.error(`${AUDIT_PATH} がありません。名簿を作れません`);
    process.exit(1);
  }
  const audit = readJson(join(ROOT, AUDIT_PATH));
  const auditCodes = new Set();
  for (const f of audit.findings ?? []) {
    if (!Array.isArray(f.flags) || !f.flags.some((x) => typeof x === 'string' && x.startsWith('価格帯商品'))) continue;
    const code = normalizeItemCode(f.shop && f.item ? `${f.shop}/${f.item}` : null);
    if (code) auditCodes.add(code);
  }
  const existing = existsSync(PRICE_RANGE_PATH) ? readJson(PRICE_RANGE_PATH) : { sources: [], items: [] };
  const bySource = new Map(existing.items.map((i) => [i.itemCode, i.source]));
  for (const code of new Set([...priceMaxCodes, ...auditCodes])) {
    const source = priceMaxCodes.has(code) && auditCodes.has(code) ? 'both' : priceMaxCodes.has(code) ? 'priceMax' : 'audit';
    if (!bySource.has(code)) bySource.set(code, source);
  }
  const items = [...bySource.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([itemCode, source]) => ({ itemCode, source }));
  const count = (s) => items.filter((i) => i.source === s).length;
  const doc = {
    generatedAt: todayJst(),
    description:
      '価格帯（選択式）の出品の名簿（計画書6 §3.2 第1段）。--refresh-price-range のときだけ書き換える。追加のみで削除しない。照合は小文字の shop/code',
    sources: [
      ...(existing.sources ?? []),
      { kind: 'frontmatter-priceMax', path: 'src/content/articles/**/*.md', asOf: todayJst() },
      { kind: 'product-data-audit', path: AUDIT_PATH, asOf: '2026-08-28' },
    ],
    counts: { total: items.length, priceMaxOnly: count('priceMax'), auditOnly: count('audit'), both: count('both') },
    items,
  };
  if (!dryRun) writeFileSync(PRICE_RANGE_PATH, JSON.stringify(doc, null, 2) + '\n');
  console.log(`[price-range] 名簿 ${items.length} 件（priceMax のみ ${doc.counts.priceMaxOnly}・監査のみ ${doc.counts.auditOnly}・両方 ${doc.counts.both}）${dryRun ? '（dry-run・未保存）' : ''}`);
  return doc;
}

const records = readAllHistory(HISTORY_DIR);
const { articleCategory, priceMaxCodes } = readArticles();
const priceRange = flag('refresh-price-range')
  ? refreshPriceRange(priceMaxCodes)
  : existsSync(PRICE_RANGE_PATH)
    ? readJson(PRICE_RANGE_PATH)
    : (console.error(`${PRICE_RANGE_PATH} がありません。初回は --refresh-price-range を付けてください`), process.exit(1));
const exclusions = existsSync(EXCLUSIONS_PATH) ? readJson(EXCLUSIONS_PATH).exclusions : [];
const groups = readJson(GROUPS_PATH).groups;

const report = buildPriceReport({
  records,
  asOf,
  priceRangeCodes: priceRange.items.map((i) => i.itemCode),
  exclusions,
  articleCategory,
  groups,
});

// ── 要約 ─────────────────────────────────────────────────────────────────

console.log(`[price-report] as-of ${asOf}・行 ${report.input.rows}（as-of 後で捨てた行 ${report.input.droppedAfterAsOf}）`);
console.log(`  カテゴリ対応が取れず外した記事 ${report.input.unmappedArticles.count}: ${report.input.unmappedArticles.articleIds.join(', ') || '-'}`);
for (const p of report.providers) {
  const c = p.cleaning;
  console.log(`\n■ ${p.provider}: 系列 ${p.input.series}・観測 ${p.input.observations}`);
  console.log(`  第1段 価格帯: 系列 ${c.priceRange.excludedSeries}（観測 ${c.priceRange.excludedObservations}）`);
  console.log(`  第2段 単発: 誤判定型 ${c.suspect.setMultiple}・原因不明型 ${c.suspect.unknown}`);
  console.log(`  第2段 段差: 区間 ${c.levelShift.intervals}（観測 ${c.levelShift.observations}）・端で判定しない: 戻りなし ${c.levelShift.unresolvedNoReturn}・L0 なし ${c.levelShift.unresolvedNoBaseline}`);
  console.log(`  第3段 手入力: 観測 ${c.manual.observations}`);
  console.log(`  取得日 ${p.coverage.captureDays}（${p.coverage.firstDate}〜${p.coverage.lastDate}）・最大欠測 ${p.coverage.maxGapDays}日`);
  console.log('  月       系列  取得日  継続率   指数    pairs');
  for (const m of p.coverage.months) {
    const idx = p.index.months.find((x) => x.month === m.month);
    const part = p.index.partial?.month === m.month ? p.index.partial : null;
    const v = idx ?? part;
    console.log(
      `  ${m.month}  ${String(m.series).padStart(5)}  ${String(m.captureDays).padStart(5)}  ${m.retentionRate == null ? '   -  ' : (m.retentionRate * 100).toFixed(1).padStart(5) + '%'}  ${v ? String(v.index ?? 'null').padStart(7) : '      -'}${part ? '(途中)' : '      '}  ${v ? v.pairs : '-'}`,
    );
  }
  console.log('  グループ別（index / pairs）:');
  for (const g of p.groups) {
    const cells = g.months.map((m) => `${m.month.slice(5)}:${m.index ?? 'null'}/${m.pairs}`).join(' ');
    const part = g.partial ? ` | ${g.partial.month.slice(5)}途中:${g.partial.index ?? 'null'}/${g.partial.pairs}` : '';
    console.log(`    ${g.label}（系列 ${g.series}） ${cells}${part}`);
  }
  const cap = p.capacityChanges;
  console.log(`  容量の変化: 減 ${cap.decreases}・増 ${cap.increases}・解析失敗の観測 ${cap.unparsedObservations}・単位違い ${cap.unitMismatches}`);
  const shares = p.discountShare.filter((d) => d.share != null);
  if (shares.length) {
    const s = shares.map((d) => d.share);
    console.log(`  値下がり割合: 日数 ${shares.length}・最小 ${Math.min(...s)}・最大 ${Math.max(...s)}`);
  }
}

if (flag('list-suspects')) {
  const s = listSuspects(groupSeries(records.filter((r) => r.capturedAt <= asOf)), 'unknown');
  console.log(`\n原因不明型の単発の外れ（第1段の前・${s.length} 件）:`);
  for (const r of s) console.log(`  ${r.key.replace(/\t/g, ' | ')} | ${r.date} | ${r.price}`);
}

if (!dryRun) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const out = join(REPORT_DIR, `${asOf}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n書き出し: ${out}`);
} else {
  console.log('\n（dry-run・書き込みなし）');
}
