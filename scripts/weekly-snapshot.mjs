// 週次アクセス スナップショット生成 CLI
//
// 使い方:
//   pnpm weekly:snapshot                 # 確定日を実測して今週/前週/28日の窓で取得
//   pnpm weekly:snapshot -- --week-days=7 --month-days=28
//   pnpm weekly:snapshot -- --no-bing    # Bing をスキップ
//   pnpm weekly:snapshot -- --top-pages=30 --top-queries=30
//
// 出力（reports/ は gitignore 済み）:
//   reports/weekly/snapshot-<確定日>.json  ← 生データ（判定の生命線）
//   reports/weekly/snapshot-<確定日>.md    ← AI が読むダイジェスト
//
// 設計意図: 「どの期間を、どの取得法で、どう正規化するか」を毎回 AI に判断させると
// レポートの質がばらつく。CLAUDE.md §5.0.2 の3ルールをここで機械的に満たす。
//   1. 確定日を dimensions:["date"] で実測してから窓を切る
//   2. サイト全体は dimensions: [] で取る（次元の行を足し上げない）
//   3. 確定日を出力の先頭に明記する
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import {
  getGscAuth,
  querySearchAnalytics,
  fetchAllSearchAnalytics,
  resolveDateRange,
  resolveServiceAccountKey,
  missingKeyMessage,
  toDateString,
  SITE_URL,
} from './lib/gsc-client.mjs';
import {
  buildDigest,
  excludeFragmentPages,
  buildWindows,
  comparePages,
  countDays,
  findMissingDates,
  resolveConfirmedDate,
  toMetrics,
  toPerDay,
} from './lib/weekly-snapshot.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../reports/weekly');
const ENV_PATH = path.resolve(__dirname, '../.env');

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID ?? '535186053';
const GA4_METRICS = [
  'screenPageViews',
  'sessions',
  'activeUsers',
  'newUsers',
  'engagedSessions',
  'engagementRate',
];
// src/lib/offers.ts の PROVIDER_META と src/components/service/ServiceLink.astro より
const OUTBOUND_EVENTS = [
  'click_rakuten_link',
  'click_yahoo_link',
  'click_amazon_link',
  'click_service_link',
];

const BING_API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const BING_SITE_URL = process.env.BING_SITE_URL ?? 'https://www.kura-select.com/';

function parseArgs(argv) {
  const options = {
    weekDays: 7,
    monthDays: 28,
    topPages: 20,
    topQueries: 20,
    bing: true,
    confirmedDate: null,
  };

  for (const arg of argv) {
    if (arg === '--no-bing') {
      options.bing = false;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'week-days') options.weekDays = Number(value);
    else if (key === 'month-days') options.monthDays = Number(value);
    else if (key === 'top-pages') options.topPages = Number(value);
    else if (key === 'top-queries') options.topQueries = Number(value);
    else if (key === 'confirmed-date') options.confirmedDate = value;
  }

  for (const key of ['weekDays', 'monthDays', 'topPages', 'topQueries']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) {
      throw new Error(`--${key} が不正です: ${options[key]}`);
    }
  }
  if (options.monthDays < options.weekDays) {
    throw new Error('--month-days は --week-days 以上にしてください');
  }

  return options;
}

// ---------------------------------------------------------------- GSC

/** 確定日を実測する。直近 lookback 日を dimensions:["date"] で引き、返却行の最終日を採用する。 */
async function measureConfirmedDate(auth, lookback = 10) {
  const { startDate, endDate } = resolveDateRange(lookback, 0);
  const rows = await querySearchAnalytics(auth, {
    startDate,
    endDate,
    dimensions: ['date'],
    rowLimit: 100,
  });
  const dateRows = rows.map((row) => ({
    date: row.keys?.[0] ?? '',
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
  return { confirmedDate: resolveConfirmedDate(dateRows), dateRows };
}

/** サイト全体（dimensions: []）。次元の行を足し上げないための専用取得。 */
async function fetchSiteTotals(auth, window) {
  const rows = await querySearchAnalytics(auth, {
    startDate: window.start,
    endDate: window.end,
    dimensions: [],
    rowLimit: 1,
  });
  return toPerDay(toMetrics(rows[0]), window.days);
}

async function fetchPageRows(auth, window) {
  const rows = await fetchAllSearchAnalytics(auth, {
    startDate: window.start,
    endDate: window.end,
    dimensions: ['page'],
  });
  return rows.map((row) => ({
    page: row.keys?.[0] ?? '',
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

async function fetchQueryRows(auth, window) {
  const rows = await fetchAllSearchAnalytics(auth, {
    startDate: window.start,
    endDate: window.end,
    dimensions: ['query'],
  });
  return rows
    .map((row) => ({
      query: row.keys?.[0] ?? '',
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

async function fetchDailyRows(auth, window) {
  const rows = await querySearchAnalytics(auth, {
    startDate: window.start,
    endDate: window.end,
    dimensions: ['date'],
    rowLimit: 1000,
  });
  return rows.map((row) => ({
    date: row.keys?.[0] ?? '',
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

// ---------------------------------------------------------------- GA4

async function getGa4Client() {
  const resolved = resolveServiceAccountKey();
  if (!resolved) throw new Error(missingKeyMessage());
  const auth = new google.auth.GoogleAuth({
    keyFile: resolved.keyFile,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  return google.analyticsdata({ version: 'v1beta', auth: await auth.getClient() });
}

function ga4Rows(data) {
  const dimensionHeaders = (data.dimensionHeaders ?? []).map(({ name }) => name);
  const metricHeaders = (data.metricHeaders ?? []).map(({ name }) => name);
  return (data.rows ?? []).map((row) => {
    const out = {};
    dimensionHeaders.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? '';
    });
    metricHeaders.forEach((name, i) => {
      out[name] = Number(row.metricValues?.[i]?.value ?? 0);
    });
    return out;
  });
}

async function runGa4Report(
  client,
  { window, dimensions, metrics, limit = 200, dimensionFilter },
) {
  const requestBody = {
    dateRanges: [{ startDate: window.start, endDate: window.end }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit,
  };
  if (dimensionFilter) requestBody.dimensionFilter = dimensionFilter;
  const res = await client.properties.runReport({
    property: `properties/${GA4_PROPERTY_ID}`,
    requestBody,
  });
  return ga4Rows(res.data);
}

/** 送客イベントだけに絞るフィルタ。placement は送客リンクにしか付かないため必須。 */
const OUTBOUND_FILTER = {
  filter: {
    fieldName: 'eventName',
    inListFilter: { values: OUTBOUND_EVENTS },
  },
};

function sumBy(rows, keyField, valueField) {
  const map = new Map();
  for (const row of rows) {
    const key = row[keyField] ?? '';
    map.set(key, (map.get(key) ?? 0) + Number(row[valueField] ?? 0));
  }
  return map;
}

async function collectGa4(windows) {
  const client = await getGa4Client();

  const totals = {};
  for (const [label, window] of [
    ['current', windows.current],
    ['previous', windows.previous],
  ]) {
    const rows = await runGa4Report(client, {
      window,
      dimensions: [],
      metrics: GA4_METRICS,
      limit: 1,
    });
    totals[label] = rows[0] ?? Object.fromEntries(GA4_METRICS.map((m) => [m, 0]));
  }

  const [currentPages, previousPages] = await Promise.all([
    runGa4Report(client, {
      window: windows.current,
      dimensions: ['pagePath'],
      metrics: ['screenPageViews', 'sessions', 'engagementRate'],
      limit: 300,
    }),
    runGa4Report(client, {
      window: windows.previous,
      dimensions: ['pagePath'],
      metrics: ['screenPageViews', 'sessions', 'engagementRate'],
      limit: 300,
    }),
  ]);

  const [currentChannels, previousChannels] = await Promise.all([
    runGa4Report(client, {
      window: windows.current,
      dimensions: ['sessionDefaultChannelGroup'],
      metrics: ['sessions'],
      limit: 50,
    }),
    runGa4Report(client, {
      window: windows.previous,
      dimensions: ['sessionDefaultChannelGroup'],
      metrics: ['sessions'],
      limit: 50,
    }),
  ]);

  const [currentEvents, previousEvents] = await Promise.all([
    runGa4Report(client, {
      window: windows.current,
      dimensions: ['eventName'],
      metrics: ['eventCount'],
      limit: 100,
    }),
    runGa4Report(client, {
      window: windows.previous,
      dimensions: ['eventName'],
      metrics: ['eventCount'],
      limit: 100,
    }),
  ]);

  // placement は送客イベント限定で集計する（全イベントで引くと page_view 等の (not set) に埋もれる）
  let currentPlacements = [];
  let previousPlacements = [];
  try {
    [currentPlacements, previousPlacements] = await Promise.all([
      runGa4Report(client, {
        window: windows.current,
        dimensions: ['customEvent:placement', 'deviceCategory'],
        metrics: ['eventCount'],
        limit: 100,
        dimensionFilter: OUTBOUND_FILTER,
      }),
      runGa4Report(client, {
        window: windows.previous,
        dimensions: ['customEvent:placement', 'deviceCategory'],
        metrics: ['eventCount'],
        limit: 100,
        dimensionFilter: OUTBOUND_FILTER,
      }),
    ]);
  } catch (error) {
    // カスタムディメンション未登録でも他の集計は返したいので握りつぶす
    console.warn(`⚠️ GA4 placement 次元を取得できませんでした: ${error.message}`);
  }

  const currentEventMap = sumBy(currentEvents, 'eventName', 'eventCount');
  const previousEventMap = sumBy(previousEvents, 'eventName', 'eventCount');
  const currentChannelMap = sumBy(currentChannels, 'sessionDefaultChannelGroup', 'sessions');
  const previousChannelMap = sumBy(previousChannels, 'sessionDefaultChannelGroup', 'sessions');
  const currentPlacementMap = sumBy(currentPlacements, 'customEvent:placement', 'eventCount');
  const previousPlacementMap = sumBy(previousPlacements, 'customEvent:placement', 'eventCount');

  // placement × デバイス（StickyCta のデスクトップ解禁判定に必要。TODO.md §2）
  const deviceKey = (row) => `${row['customEvent:placement']}	${row.deviceCategory}`;
  const currentDeviceMap = new Map();
  const previousDeviceMap = new Map();
  for (const [rows, map] of [
    [currentPlacements, currentDeviceMap],
    [previousPlacements, previousDeviceMap],
  ]) {
    for (const row of rows) {
      map.set(deviceKey(row), (map.get(deviceKey(row)) ?? 0) + Number(row.eventCount ?? 0));
    }
  }
  const placementDevices = [...new Set([...currentDeviceMap.keys(), ...previousDeviceMap.keys()])]
    .map((key) => {
      const [placement, device] = key.split('	');
      return {
        placement,
        device,
        current: currentDeviceMap.get(key) ?? 0,
        previous: previousDeviceMap.get(key) ?? 0,
      };
    })
    .sort((a, b) => b.current - a.current || a.placement.localeCompare(b.placement));

  return {
    available: true,
    propertyId: GA4_PROPERTY_ID,
    window: windows.current,
    siteTotals: {
      current: Object.fromEntries(GA4_METRICS.map((m) => [m, Number(totals.current[m] ?? 0)])),
      previous: Object.fromEntries(GA4_METRICS.map((m) => [m, Number(totals.previous[m] ?? 0)])),
    },
    pages: { current: currentPages, previous: previousPages },
    channels: [...new Set([...currentChannelMap.keys(), ...previousChannelMap.keys()])]
      .map((channel) => ({
        channel,
        sessions: currentChannelMap.get(channel) ?? 0,
        previousSessions: previousChannelMap.get(channel) ?? 0,
      }))
      .sort((a, b) => b.sessions - a.sessions),
    outbound: OUTBOUND_EVENTS.map((eventName) => ({
      eventName,
      current: currentEventMap.get(eventName) ?? 0,
      previous: previousEventMap.get(eventName) ?? 0,
    })),
    placements: [...new Set([...currentPlacementMap.keys(), ...previousPlacementMap.keys()])]
      .map((placement) => ({
        placement,
        current: currentPlacementMap.get(placement) ?? 0,
        previous: previousPlacementMap.get(placement) ?? 0,
      }))
      .sort((a, b) => b.current - a.current),
    placementDevices,
    events: {
      current: Object.fromEntries(currentEventMap),
      previous: Object.fromEntries(previousEventMap),
    },
  };
}

// ---------------------------------------------------------------- Bing

const WCF_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

function parseWcfDate(value) {
  if (typeof value !== 'string') return null;
  const match = WCF_DATE.exec(value);
  if (!match) return null;
  let ms = Number(match[1]);
  if (match[2]) {
    const sign = match[2][0] === '-' ? -1 : 1;
    const hours = Number(match[2].slice(1, 3));
    const minutes = Number(match[2].slice(3, 5));
    ms += sign * (hours * 60 + minutes) * 60_000;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function callBing(method, extraParams = {}) {
  const apiKey = process.env.BING_WEBMASTER_API_KEY;
  if (!apiKey) throw new Error('BING_WEBMASTER_API_KEY が未設定です（.env）');
  const url = new URL(`${BING_API_BASE}/${method}`);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('siteUrl', BING_SITE_URL);
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Bing API ${method} が ${res.status} ${res.statusText} を返しました`);
  }
  const json = await res.json();
  return json?.d ?? json;
}

function sumBingWindow(rows, window) {
  const dates = new Set();
  let clicks = 0;
  let impressions = 0;
  for (const row of rows) {
    const date = parseWcfDate(row?.Date);
    if (!date || date < window.start || date > window.end) continue;
    dates.add(date);
    clicks += Number(row?.Clicks ?? 0);
    impressions += Number(row?.Impressions ?? 0);
  }
  return { clicks, impressions, dates: [...dates] };
}

async function collectBing(windows) {
  const rows = await callBing('GetRankAndTrafficStats');
  if (!Array.isArray(rows)) {
    throw new Error('GetRankAndTrafficStats が配列を返しませんでした');
  }
  const current = sumBingWindow(rows, windows.current);
  const previous = sumBingWindow(rows, windows.previous);
  return {
    available: true,
    note:
      'GetRankAndTrafficStats の日次行を窓で絞って合算している。' +
      'GetPageStats / GetQueryStats は期間指定できないため取得していない。',
    current: { clicks: current.clicks, impressions: current.impressions },
    previous: { clicks: previous.clicks, impressions: previous.impressions },
    missingDates: findMissingDates(
      current.dates.map((date) => ({ date })),
      windows.current,
    ),
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2));

  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    // .env が無くても環境変数で渡っていれば動く
  }

  if (!resolveServiceAccountKey()) {
    console.error(`❌ ${missingKeyMessage()}`);
    process.exitCode = 1;
    return;
  }

  console.log(`サイト: ${SITE_URL}`);
  const auth = await getGscAuth();

  // 1. 確定日の実測（CLAUDE.md §5.0.2 ルール1）
  const { confirmedDate: measured } = await measureConfirmedDate(auth);
  const confirmedDate = options.confirmedDate ?? measured;
  if (!confirmedDate) {
    console.error('❌ GSC が直近10日で1行も返しませんでした。確定日を決定できません。');
    process.exitCode = 1;
    return;
  }
  const lagDays = countDays(confirmedDate, toDateString(new Date())) - 1;
  console.log(`GSC の最新確定日: ${confirmedDate}（遅延 ${lagDays} 日）`);
  if (options.confirmedDate && measured && options.confirmedDate !== measured) {
    console.warn(`⚠️ 実測の確定日 ${measured} を --confirmed-date で上書きしています`);
  }

  const windows = buildWindows(confirmedDate, options.weekDays, options.monthDays);
  console.log(`今週: ${windows.current.start}〜${windows.current.end}`);
  console.log(`前週: ${windows.previous.start}〜${windows.previous.end}`);

  // 2. サイト全体は dimensions: [] で個別取得（ルール2）
  const [siteCurrent, sitePrevious, siteMonth] = await Promise.all([
    fetchSiteTotals(auth, windows.current),
    fetchSiteTotals(auth, windows.previous),
    fetchSiteTotals(auth, windows.month),
  ]);

  const [currentPages, previousPages, monthQueries, monthDaily] = await Promise.all([
    fetchPageRows(auth, windows.current),
    fetchPageRows(auth, windows.previous),
    fetchQueryRows(auth, windows.month),
    fetchDailyRows(auth, windows.month),
  ]);

  const pages = comparePages(currentPages, previousPages, siteCurrent, sitePrevious, windows);
  // 見出しアンカー付き URL は親ページの二重計上。除外した行数をレポートに明記する
  const fragmentRowsExcluded = {
    current: excludeFragmentPages(currentPages).excludedCount,
    previous: excludeFragmentPages(previousPages).excludedCount,
  };
  // 窓の内側に穴が空いていないかを見る。確定日より後は「まだ来ていない日」なので対象外。
  const missingDates = findMissingDates(monthDaily, windows.current);
  const missingDatesMonth = findMissingDates(monthDaily, windows.month);

  let ga4 = { available: false, error: 'skipped' };
  try {
    ga4 = await collectGa4(windows);
  } catch (error) {
    ga4 = { available: false, error: error.message };
    console.warn(`⚠️ GA4 を取得できませんでした: ${error.message}`);
  }

  let bing = { available: false, error: '--no-bing が指定されました' };
  if (options.bing) {
    try {
      bing = await collectBing(windows);
    } catch (error) {
      bing = { available: false, error: error.message };
      console.warn(`⚠️ Bing を取得できませんでした: ${error.message}`);
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    siteUrl: SITE_URL,
    confirmedDate,
    lagDays,
    windows,
    gsc: {
      siteTotals: { current: siteCurrent, previous: sitePrevious, month: siteMonth },
      daily: monthDaily,
      missingDates,
      missingDatesMonth,
      fragmentRowsExcluded,
      pages,
      topQueries: monthQueries,
      rawPageRows: { current: currentPages, previous: previousPages },
    },
    ga4,
    bing,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const jsonPath = path.join(OUTPUT_DIR, `snapshot-${confirmedDate}.json`);
  const mdPath = path.join(OUTPUT_DIR, `snapshot-${confirmedDate}.md`);
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), 'utf8');
  writeFileSync(
    mdPath,
    buildDigest(snapshot, { topPages: options.topPages, topQueries: options.topQueries }),
    'utf8',
  );

  console.log(`\n✅ 出力しました`);
  console.log(`  ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  ${path.relative(process.cwd(), mdPath)}`);
  console.log(`\n次: 新しいチャットで /kura-weekly-access-review を実行してください。`);
}

main().catch((error) => {
  console.error(`❌ ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
