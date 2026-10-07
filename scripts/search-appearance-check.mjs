// 検索での見え方（searchAppearance）別の実績を取得する CLI（読み取り専用）
//
// 使い方:
//   pnpm gsc:appearance                                  # 確定日を実測し、確定日までの28日
//   pnpm gsc:appearance -- --start=2026-09-06 --end=2026-10-04
//   pnpm gsc:appearance -- --json                        # JSON を標準出力に出す
//
// 出力（reports/ は gitignore 済み）:
//   reports/gsc-appearance/appearance-<start>_<end>.{json,md}
//
// 用途: 構造化データ是正（docs/IMPLEMENTATION_PLAN_STRUCTURED_DATA_FIX_2026-10-07.md）の
// 第1段で商品スニペットが残っているかの監視と、第2段（aggregateRating）の判断材料。
//
// API の制約: searchAppearance 次元は他の次元と同じリクエストで併用できない。
// そのため ①サイト合計 ②見え方別の合計 ③見え方でフィルタした page 次元 の順に取る。
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { getGscAuth, resolveDateRange, SITE_URL } from './lib/gsc-client.mjs';
import { addDays, countDays, resolveConfirmedDate } from './lib/weekly-snapshot.ts';
import {
  buildAppearanceMarkdown,
  joinSnippetPages,
  resolveProductSnippetKey,
  toDateRows,
  toKeyedRows,
  toPageRows,
} from './lib/search-appearance.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../reports/gsc-appearance');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAYS = 28;
const PAGE_SIZE = 5000;
const MAX_ROWS = 25000;

function parseArgs(argv) {
  const options = { start: null, end: null, json: false };
  for (const arg of argv) {
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'start') options.start = value;
    else if (key === 'end') options.end = value;
  }
  for (const key of ['start', 'end']) {
    if (options[key] !== null && !DATE_RE.test(options[key])) {
      throw new Error(`--${key} は YYYY-MM-DD で指定してください: ${options[key]}`);
    }
  }
  if ((options.start === null) !== (options.end === null)) {
    throw new Error('--start と --end は両方指定するか、両方省略してください');
  }
  if (options.start && options.start > options.end) {
    throw new Error('--start は --end 以前にしてください');
  }
  return options;
}

/** Search Analytics を startRow でページングして全件取る（フィルタは任意） */
async function queryAll(webmasters, { startDate, endDate, dimensions, filters }) {
  const all = [];
  for (let startRow = 0; startRow < MAX_ROWS; startRow += PAGE_SIZE) {
    const requestBody = { startDate, endDate, dimensions, rowLimit: PAGE_SIZE, startRow };
    if (filters) requestBody.dimensionFilterGroups = [{ filters }];
    const res = await webmasters.searchanalytics.query({ siteUrl: SITE_URL, requestBody });
    const rows = res.data.rows ?? [];
    all.push(...rows);
    // dimensions: [] は1行しか返らないのでページングしない
    if (dimensions.length === 0 || rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const auth = await getGscAuth();
  const webmasters = google.webmasters({ version: 'v3', auth });

  // 確定日を実測する（CLAUDE.md §5.0.2 データ取得ルール1）
  const recent = resolveDateRange(10, 0);
  const dateRows = await queryAll(webmasters, {
    startDate: recent.startDate,
    endDate: recent.endDate,
    dimensions: ['date'],
  });
  const confirmedDate = resolveConfirmedDate(toDateRows(dateRows));
  if (!options.end && !confirmedDate) {
    throw new Error('確定日を取得できませんでした（直近10日の date 行が空）');
  }

  const end = options.end ?? confirmedDate;
  const start = options.start ?? addDays(end, -(DEFAULT_DAYS - 1));
  if (confirmedDate && end > confirmedDate) {
    console.error(`警告: --end（${end}）が確定日（${confirmedDate}）より後です。未反映日は行ごと欠落します`);
  }
  const window = { start, end, days: countDays(start, end) };
  const range = { startDate: start, endDate: end };

  const [siteRows, appearanceRows, totalPageRows] = await Promise.all([
    queryAll(webmasters, { ...range, dimensions: [] }),
    queryAll(webmasters, { ...range, dimensions: ['searchAppearance'] }),
    queryAll(webmasters, { ...range, dimensions: ['page'] }),
  ]);
  const siteTotal = toKeyedRows(siteRows)[0] ?? { key: '', clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const appearances = toKeyedRows(appearanceRows).sort((a, b) => b.clicks - a.clicks);
  const snippetKey = resolveProductSnippetKey(appearances);

  let joined = { rows: [], excludedSnippetRows: 0, excludedTotalRows: 0 };
  if (snippetKey) {
    const snippetPageRows = await queryAll(webmasters, {
      ...range,
      dimensions: ['page'],
      filters: [{ dimension: 'searchAppearance', operator: 'equals', expression: snippetKey }],
    });
    joined = joinSnippetPages(toPageRows(snippetPageRows), toPageRows(totalPageRows));
  }

  const report = {
    confirmedDate,
    window,
    siteTotal: {
      clicks: siteTotal.clicks,
      impressions: siteTotal.impressions,
      ctr: siteTotal.ctr,
      position: siteTotal.position,
    },
    appearances,
    snippetKey,
    snippetPages: joined.rows,
    excludedSnippetRows: joined.excludedSnippetRows,
    excludedTotalRows: joined.excludedTotalRows,
  };
  const markdown = buildAppearanceMarkdown(report);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, `appearance-${start}_${end}`);
  writeFileSync(`${base}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2) + '\n');
  writeFileSync(`${base}.md`, markdown);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(markdown);
  }
  console.error(`保存: ${path.relative(process.cwd(), base)}.{json,md}`);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
