// GSC「あと一歩クエリ」刈り取り（Harvest）レポート生成 CLI
//
// 使い方:
//   pnpm gsc:harvest                      # 直近28日の候補レポート生成
//   pnpm gsc:harvest -- --days=28         # 期間指定
//   pnpm gsc:harvest -- --baseline-only   # 生データ保存のみ（レポート出力なし）
//   pnpm gsc:harvest -- --min-impressions=15
//   pnpm gsc:harvest -- --start=2026-07-08 --end=2026-08-04
//
// 出力（reports/ は gitignore 済み）:
//   reports/gsc-harvest/baseline-<実行日>.json  ← 判定用の生データ。生命線
//   reports/gsc-harvest/harvest-<実行日>.md     ← 候補レポート
//
// 計画書: docs/IMPLEMENTATION_PLAN_GSC_HARVEST_2026-08-07.md
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getGscAuth,
  fetchAllSearchAnalytics,
  resolveDateRange,
  resolveServiceAccountKey,
  toDateString,
  SITE_URL,
} from './lib/gsc-client.mjs';
import {
  classifyRows,
  summarizeByPage,
  detectCannibalization,
  buildHarvestReport,
  DEFAULT_MIN_IMPRESSIONS,
} from './lib/gsc-harvest.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../reports/gsc-harvest');

function parseArgs(argv) {
  const options = {
    days: 28,
    minImpressions: DEFAULT_MIN_IMPRESSIONS,
    baselineOnly: false,
    startDate: null,
    endDate: null,
  };

  for (const arg of argv) {
    if (arg === '--baseline-only') {
      options.baselineOnly = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'days') options.days = Number(value);
    else if (key === 'min-impressions') options.minImpressions = Number(value);
    else if (key === 'start') options.startDate = value;
    else if (key === 'end') options.endDate = value;
  }

  if (!Number.isFinite(options.days) || options.days < 1) {
    throw new Error(`--days が不正です: ${options.days}`);
  }
  if (!Number.isFinite(options.minImpressions) || options.minImpressions < 0) {
    throw new Error(`--min-impressions が不正です: ${options.minImpressions}`);
  }
  if ((options.startDate && !options.endDate) || (!options.startDate && options.endDate)) {
    throw new Error('--start と --end は両方指定してください');
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const key = resolveServiceAccountKey();
  if (!key) {
    // getGscAuth が同じメッセージで throw するが、先に案内を出して意図を明確にする
    const { missingKeyMessage } = await import('./lib/gsc-client.mjs');
    console.error(`❌ ${missingKeyMessage()}`);
    process.exit(1);
  }
  console.log(`✓ 認証鍵: ${key.source}`);

  const range =
    options.startDate && options.endDate
      ? { startDate: options.startDate, endDate: options.endDate }
      : resolveDateRange(options.days);

  console.log(`✓ 対象サイト: ${SITE_URL}`);
  console.log(`✓ データ期間: ${range.startDate} 〜 ${range.endDate}`);

  const auth = await getGscAuth();
  const rawRows = await fetchAllSearchAnalytics(auth, {
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: ['query', 'page'],
  });

  const rows = rawRows.map((row) => ({
    query: row.keys?.[0] ?? '',
    page: row.keys?.[1] ?? '',
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
  console.log(`✓ 取得: ${rows.length} 行（query×page）`);

  // ページ単位のクリックは query×page の合算では出せない（匿名化クエリが行ごと落ち、
  // 実測でクリックが約 -75% ズレる。CLAUDE.md §5.0.2 ルール2）。
  // 人気記事の自動選定はこの pageRows だけを根拠にする。
  const rawPageRows = await fetchAllSearchAnalytics(auth, {
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: ['page'],
  });
  const pageRows = rawPageRows.map((row) => ({
    page: row.keys?.[0] ?? '',
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
  console.log(`✓ 取得: ${pageRows.length} 行（page）`);

  const runDate = toDateString(new Date());
  const meta = {
    startDate: range.startDate,
    endDate: range.endDate,
    fetchedAt: new Date().toISOString(),
    runDate,
    minImpressions: options.minImpressions,
    totalRows: rows.length,
    totalPageRows: pageRows.length,
    siteUrl: SITE_URL,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // ベースライン（生データ）は施策判定の生命線。--baseline-only でも必ず保存する。
  const baselinePath = path.join(OUTPUT_DIR, `baseline-${runDate}.json`);
  writeFileSync(baselinePath, JSON.stringify({ meta, rows, pageRows }, null, 2), 'utf-8');
  console.log(`✓ ベースライン保存: ${path.relative(process.cwd(), baselinePath)}`);

  if (options.baselineOnly) {
    console.log('ℹ --baseline-only のためレポート出力はスキップしました');
    return;
  }

  const classified = classifyRows(rows, { minImpressions: options.minImpressions });
  const pages = summarizeByPage(classified);
  const cannibals = detectCannibalization(rows);
  const report = buildHarvestReport(meta, pages, cannibals);

  const reportPath = path.join(OUTPUT_DIR, `harvest-${runDate}.md`);
  writeFileSync(reportPath, report, 'utf-8');
  console.log(`✓ レポート保存: ${path.relative(process.cwd(), reportPath)}`);
  console.log(
    `  候補ページ ${pages.length} 件 / 候補クエリ ${classified.length} 件 / カニバリ ${cannibals.length} 件`,
  );
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
