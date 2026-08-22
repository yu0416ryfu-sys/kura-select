// 人気記事欄（src/data/popularArticles.ts）を GSC のページ単位クリック実績から生成する CLI
//
// 使い方:
//   pnpm generate-popular                        # 生成して書き込む
//   pnpm generate-popular:dry                    # 書き込まず選定結果と差分だけ表示
//   pnpm generate-popular -- --baseline=<path>   # 使う baseline を明示
//   pnpm generate-popular -- --force             # 安全弁を無視して書き込む
//
// 入力:
//   reports/gsc-harvest/baseline-<日付>.json の pageRows（pnpm gsc:harvest で生成）
//   data/popular-articles-policy.json（手書きの運用ポリシー）
//   src/content/articles/**/*.md（存在確認・draft 除外）
//
// reports/ は gitignore 済みのためローカル実行専用。CI では走らせず、生成物だけをコミットする。
// 計画書: docs/IMPLEMENTATION_PLAN_POPULAR_ARTICLES_AUTO_2026-08-22.md
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from './lib/frontmatter.ts';
import {
  normalizeArticleId,
  aggregatePageRows,
  normalizePolicy,
  selectPopularArticles,
  diffSelection,
  renderPopularArticlesFile,
} from './lib/popular-articles.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASELINE_DIR = path.join(ROOT, 'reports/gsc-harvest');
const ARTICLES_DIR = path.join(ROOT, 'src/content/articles');
const POLICY_PATH = path.join(ROOT, 'data/popular-articles-policy.json');
const OUTPUT_PATH = path.join(ROOT, 'src/data/popularArticles.ts');

/** baseline の endDate がこれより古ければ、古いデータでの上書き事故として止める */
const MAX_BASELINE_AGE_DAYS = 60;

function parseArgs(argv) {
  const options = { dryRun: false, force: false, baseline: null };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else {
      const match = /^--baseline=(.+)$/.exec(arg);
      if (match) options.baseline = match[1];
    }
  }
  return options;
}

/** reports/gsc-harvest/ からファイル名の日付が最大の baseline を選ぶ */
function findLatestBaseline() {
  if (!existsSync(BASELINE_DIR)) return null;
  const files = readdirSync(BASELINE_DIR)
    .filter((name) => /^baseline-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  const latest = files.at(-1);
  return latest ? path.join(BASELINE_DIR, latest) : null;
}

/** src/content/articles 配下の .md / .mdx を再帰列挙する */
function listArticleFiles(dir, prefix = '') {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listArticleFiles(path.join(dir, entry.name), rel));
    } else if (/\.mdx?$/.test(entry.name)) {
      results.push({ rel, abs: path.join(dir, entry.name) });
    }
  }
  return results;
}

/**
 * 公開中の記事 id 集合を作る。
 * parseFrontmatter が null（YAML 破損など）の記事は黙って除外せず警告を出す。
 * draft は `data.draft === true` のときだけ除外する（真偽変換に頼らない）。
 */
function collectAvailableIds() {
  const ids = new Set();
  for (const file of listArticleFiles(ARTICLES_DIR)) {
    const parsed = parseFrontmatter(readFileSync(file.abs, 'utf-8'));
    if (!parsed) {
      console.warn(`⚠ frontmatter を解析できずスキップ: ${file.rel}`);
      continue;
    }
    if (parsed.data.draft === true) continue;
    ids.add(normalizeArticleId(file.rel));
  }
  return ids;
}

/** 既存の src/data/popularArticles.ts から現在の id 配列を読む */
function readCurrentIds() {
  if (!existsSync(OUTPUT_PATH)) return [];
  const source = readFileSync(OUTPUT_PATH, 'utf-8');
  const body = /popularArticleIds\s*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!body) return [];
  return [...body[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function daysBetween(fromDate, toDate) {
  return Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000);
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const baselinePath = options.baseline
    ? path.resolve(ROOT, options.baseline)
    : findLatestBaseline();
  if (!baselinePath || !existsSync(baselinePath)) {
    throw new Error(
      'baseline が見つかりません。`pnpm gsc:harvest` を実行して baseline を作成してください',
    );
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const relBaseline = path.relative(ROOT, baselinePath).replace(/\\/g, '/');

  // query×page の合算をページ実績に流用しない（クリックが約 -75% ズレる）。
  if (!Array.isArray(baseline.pageRows)) {
    throw new Error(
      `${relBaseline} に pageRows がありません。\n` +
        '   `pnpm gsc:harvest` を実行して baseline を取り直してください' +
        '（query×page 行の合算はページ実績として使えません）',
    );
  }

  const meta = baseline.meta ?? {};
  if (!meta.startDate || !meta.endDate) {
    throw new Error(`${relBaseline} の meta に startDate / endDate がありません`);
  }
  const age = daysBetween(new Date(meta.endDate), new Date());
  if (age >= MAX_BASELINE_AGE_DAYS) {
    throw new Error(
      `baseline が古すぎます（endDate ${meta.endDate} / ${age}日前）。` +
        '`pnpm gsc:harvest` で取り直してください',
    );
  }

  const policy = normalizePolicy(JSON.parse(readFileSync(POLICY_PATH, 'utf-8')));
  const availableIds = collectAvailableIds();
  const stats = aggregatePageRows(baseline.pageRows);
  const result = selectPopularArticles(stats, policy, availableIds);

  const currentIds = readCurrentIds();
  const diff = diffSelection(currentIds, result.ids);

  console.log(`✓ baseline: ${relBaseline}`);
  console.log(`✓ 窓: ${meta.startDate} 〜 ${meta.endDate}`);
  console.log(`✓ 記事（公開中）: ${availableIds.size} 本 / GSC 実績のある記事: ${stats.length} 本`);
  console.log(`✓ 選定 ${result.ids.length}/${policy.slots} 件:`);
  const statById = new Map(stats.map((s) => [s.id, s]));
  for (const [index, id] of result.ids.entries()) {
    const s = statById.get(id);
    const tags = [];
    if (policy.pinned.includes(id)) tags.push('pinned');
    if (policy.spotlight === id) tags.push('spotlight');
    const label = tags.length ? ` [${tags.join(',')}]` : '';
    const numbers = s ? `clicks ${s.clicks} / imp ${s.impressions}` : 'GSC 実績なし';
    console.log(`   ${index + 1}. ${id} — ${numbers}${label}`);
  }

  const reasonCount = new Map();
  for (const entry of result.dropped) {
    reasonCount.set(entry.reason, (reasonCount.get(entry.reason) ?? 0) + 1);
  }
  if (reasonCount.size > 0) {
    const summary = [...reasonCount.entries()].map(([r, n]) => `${r}: ${n}`).join(' / ');
    console.log(`ℹ 除外: ${summary}`);
  }
  if (diff.changed > 0) {
    console.log(`ℹ 差分: +${diff.added.join(', ') || 'なし'} / -${diff.removed.join(', ') || 'なし'}`);
  } else {
    console.log('ℹ 差分: なし');
  }

  // --- 安全弁（--force で無視可） ---
  const blockers = [];

  const conflicts = [...policy.pinned, ...(policy.spotlight ? [policy.spotlight] : [])].filter(
    (id) => policy.excluded.includes(id),
  );
  if (conflicts.length > 0) {
    console.warn(
      `⚠ pinned/spotlight と excluded に同じ id があります（除外側を採用）: ${conflicts.join(', ')}`,
    );
  }

  const minIds = Math.ceil(policy.slots / 2);
  if (result.ids.length < minIds) {
    blockers.push(
      `候補が ${result.ids.length} 件しかありません（slots ${policy.slots} の半数 ${minIds} 未満）`,
    );
  } else if (result.shortfall > 0) {
    console.warn(`⚠ 候補が slots に ${result.shortfall} 件足りません`);
  }

  if (currentIds.length > 0 && diff.changed > policy.slots / 2) {
    blockers.push(
      `前回リストとの入れ替わりが ${diff.changed} 件で slots ${policy.slots} の過半を超えています`,
    );
  }

  if (blockers.length > 0 && !options.force) {
    for (const message of blockers) console.error(`❌ ${message}`);
    console.error('   内容を確認し、意図どおりなら --force を付けて再実行してください');
    process.exit(1);
  }
  if (blockers.length > 0 && options.force) {
    for (const message of blockers) console.warn(`⚠ --force のため続行: ${message}`);
  }

  if (options.dryRun) {
    console.log('ℹ --dry-run のため書き込みはスキップしました');
    return;
  }

  const output = renderPopularArticlesFile(result.ids, {
    baselinePath: relBaseline,
    startDate: meta.startDate,
    endDate: meta.endDate,
    generatedAt: new Date().toISOString().slice(0, 10),
    policyPath: 'data/popular-articles-policy.json',
  });
  writeFileSync(OUTPUT_PATH, output, 'utf-8');
  console.log(`✓ 書き込み: ${path.relative(ROOT, OUTPUT_PATH).replace(/\\/g, '/')}`);
}

try {
  main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
