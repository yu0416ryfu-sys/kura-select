// 記事の入れ替えで外す記事の候補（M0〜M4）を出す CLI
//
// 使い方:
//   pnpm rotation:candidates
//
// 出力（reports/ は gitignore 済み）:
//   reports/rotation/candidates-<GSC確定日>.json / .md
//
// 判定は scripts/lib/rotation-candidates.mjs の純関数（テストは tests/rotation-candidates.test.ts）。
// ここはデータを集めて渡すだけで、data/ も記事も書かない。
// 取得できなかったデータは 0 として扱わず、その条件に頼る判定を hold（判定保留）にする。
// 計画書: docs/IMPLEMENTATION_PLAN_ARTICLE_ROTATION_SKILL_2026-11-21.md §5-2
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGscAuth, querySearchAnalytics, fetchAllSearchAnalytics } from './lib/gsc-client.mjs';
import { excludeFragmentPages } from './lib/gsc-pages.ts';
import { loadHolds, todayJst } from './lib/measurement-holds.ts';
import { getNoindexArticleSlugs } from './lib/noindex-articles.mjs';
import {
  addDays,
  assessBingFetchHealth,
  classifyRotationCandidates,
  parseImprovementLog,
  parseRecoverPending,
  parseTrialFailures,
  selectLatestBingWeeks,
  sumByArticleId,
} from './lib/rotation-candidates.mjs';
import { loadArticles, collectGa4, fetchBingPageStatsRows } from './article-dashboard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const OUTPUT_DIR = path.join(ROOT, 'reports/rotation');
const WINDOW_DAYS = 28;
const BING_WEEKS = 4;

/** 季節品リスト。読めなければ止める（季節品が M4 に落ちるのを防ぐ） */
function loadSeasonal() {
  const p = path.join(ROOT, 'data/rotation-seasonal.json');
  if (!existsSync(p)) throw new Error('data/rotation-seasonal.json がありません（季節品を判定できないので止めます）');
  let json;
  try {
    json = JSON.parse(readFileSync(p, 'utf8'));
  } catch (error) {
    throw new Error(`data/rotation-seasonal.json を読めません: ${error.message}`);
  }
  if (!Array.isArray(json?.items)) throw new Error('data/rotation-seasonal.json の items が配列ではありません');
  return new Set(json.items.map((item) => String(item.slug)));
}

async function measureConfirmedDate(auth, today) {
  const rows = await querySearchAnalytics(auth, {
    startDate: addDays(today, -10),
    endDate: today,
    dimensions: ['date'],
  });
  const dates = rows.map((r) => r.keys[0]).sort();
  if (!dates.length) throw new Error('GSC の date 次元が0行でした（確定日を決められないので止めます）');
  return dates[dates.length - 1];
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push(`# 入れ替えの候補（${payload.today} 実行）`, '');
  lines.push(`**GSC の最新確定日は ${payload.confirmed}**（実測）`, '');
  lines.push(`- GSC: ${payload.windows.gsc}（page 次元・見出しアンカー行を除く）`);
  lines.push(`- GA4 送客: ${payload.windows.ga4}`);
  lines.push(
    `- Bing: ${payload.windows.bing.weeks.length ? payload.windows.bing.weeks.join('・') : 'なし'} の週（${payload.windows.bing.weeks.length} 週${payload.windows.bing.scale && payload.windows.bing.scale !== 1 ? `・4週あたりに ×${payload.windows.bing.scale.toFixed(2)} で換算` : ''}）`,
  );
  lines.push(
    `- Bing の取得: ${
      payload.missing.bing
        ? '取得失敗（M2 は全行 hold）'
        : payload.windows.bing.health.healthy
          ? '正常（行なしは表示0とみなす）'
          : `異常の疑い（${payload.windows.bing.health.reasons.join('／')}）・行なしは M2-hold`
    }`,
  );
  lines.push(
    `- 対象: 公開 ${payload.rules.minAgeDays} 日以上（試験枠で2週判定が ❌・暫定でない記事は ${payload.rules.trialFailedMinAgeDays} 日以上）・GSC 表示 ${payload.rules.maxImpressions} 未満・noindex でない`,
    '',
  );
  if (payload.warnings.length) {
    lines.push('## 警告', '');
    for (const w of payload.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  const counts = {};
  for (const row of payload.rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  lines.push('## 判定', '');
  lines.push(`件数: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / ') || '0'}`, '');
  lines.push('| 記事 | 公開日 | 日数 | GSC | 送客 | Bing | 判定 | 理由 | 表示0とみなした判定 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? String(Math.round(v * 10) / 10) : String(v));
  for (const r of payload.rows) {
    lines.push(
      `| \`${r.id}\` | ${fmt(r.publishedAt)} | ${fmt(r.ageDays)} | ${fmt(r.gsc)} | ${fmt(r.outbound)} | ${fmt(r.bing)} | ${r.verdict} | ${r.reason} | ${fmt(r.verdictIfBingZero)} |`,
    );
  }
  lines.push('', '`M4` だけが noindex 候補。`hold` は取得できなかったデータがあるので noindex に回さない。`M2-hold` は Bing の取得に異常の疑いがある回だけに出る。「表示0とみなした判定」は、前回の月次でも Bing 行なしだった記事にだけ使う（スキル `kura-article-rotation` §3-3）。');
  return `${lines.join('\n')}\n`;
}

async function main() {
  if (existsSync(ENV_PATH)) {
    try {
      process.loadEnvFile(ENV_PATH);
    } catch {
      // .env が読めなくても既定パスの鍵で動く可能性がある
    }
  }
  const today = todayJst();
  const warnings = [];
  const seasonal = loadSeasonal();

  console.log('記事を読み込み中…');
  const articles = loadArticles().map((a) => ({ id: a.id, publishedAt: a.publishedAt }));

  console.log('GSC を取得中…');
  const auth = await getGscAuth();
  const confirmed = await measureConfirmedDate(auth, today);
  const start = addDays(confirmed, -(WINDOW_DAYS - 1));
  const gscRows = await fetchAllSearchAnalytics(auth, {
    startDate: start,
    endDate: confirmed,
    dimensions: ['page'],
    maxRows: 25000,
  });
  const { rows: gscKept } = excludeFragmentPages(gscRows.map((r) => ({ page: r.keys[0], impressions: r.impressions })));
  const gscImpressions = sumByArticleId(gscKept.map((r) => ({ key: r.page, value: r.impressions })));

  // GA4 は終端を GSC の確定日にそろえる（T-1 を含めない）
  console.log('GA4 を取得中…');
  let outbound = null;
  try {
    const daily = await collectGa4(start, confirmed);
    const entries = [];
    for (const [p, byDate] of daily) {
      let sum = 0;
      for (const cell of byDate.values()) sum += cell.outbound;
      entries.push({ key: p, value: sum });
    }
    outbound = sumByArticleId(entries);
  } catch (error) {
    warnings.push(`GA4 を取得できませんでした（全行の M1 を判定保留にしました）: ${error.message}`);
  }

  // Bing は確定日以前で最新の4週の行を使う（固定の28日窓だと最新週が未公開の日に3週分になる）
  console.log('Bing を取得中…');
  let bingImpressions = null;
  let bingWindow = { weeks: [], scale: 0, health: { healthy: false, reasons: ['未取得'] } };
  // noindex 済みの記事にも Bing の行は残るので、実在する記事に数える
  const noindexed = getNoindexArticleSlugs();
  const knownArticleIds = new Set([...articles.map((a) => a.id), ...noindexed]);
  try {
    const rows = await fetchBingPageStatsRows();
    if (!rows.length) throw new Error('GetPageStats の応答が0行でした');
    const picked = selectLatestBingWeeks(rows, confirmed, BING_WEEKS);
    if (!picked.weeks.length) throw new Error(`確定日 ${confirmed} 以前の週の行がありません`);
    const health = assessBingFetchHealth(picked, knownArticleIds, BING_WEEKS);
    bingWindow = { weeks: picked.weeks, scale: picked.scale, health };
    if (!health.healthy) warnings.push(`Bing の取得に異常の疑い（行なしは M2-hold にしました）: ${health.reasons.join('／')}`);
    if (picked.weeks.length < BING_WEEKS) {
      warnings.push(`Bing の週が ${picked.weeks.length} 週しかないため、4週あたりに換算しました（×${picked.scale.toFixed(2)}）`);
    }
    const summed = sumByArticleId(picked.rows.map((r) => ({ key: r.page, value: r.impressions })));
    bingImpressions = new Map([...summed].map(([id, v]) => [id, v * picked.scale]));
  } catch (error) {
    warnings.push(`Bing を取得できませんでした（全行の M2 を判定保留にしました）: ${error.message}`);
  }

  const holds = loadHolds(path.join(ROOT, 'data/measurement-holds.json'), today);
  if (!holds.available) warnings.push('data/measurement-holds.json を読めませんでした（全行を判定保留にしました）');
  const frozen = holds.available ? holds.frozenSlugs : null;

  const ids = new Set(articles.map((a) => a.id));
  const logPath = path.join(ROOT, 'docs/CONTENT_IMPROVEMENT_LOG.md');
  let improvements = null;
  let recoverPending = null;
  if (existsSync(logPath)) {
    const text = readFileSync(logPath, 'utf8');
    improvements = parseImprovementLog(text, ids);
    recoverPending = parseRecoverPending(text, ids);
  } else {
    warnings.push('docs/CONTENT_IMPROVEMENT_LOG.md がありません（全行を判定保留にしました）');
  }

  // 試験枠で2週判定が ❌（暫定でない）の記事は公開28日から対象にする。ログが無ければ通常の60日に戻るだけ
  const rotationLogPath = path.join(ROOT, 'docs/ROTATION_LOG.md');
  let trialFailed = new Set();
  if (existsSync(rotationLogPath)) trialFailed = parseTrialFailures(readFileSync(rotationLogPath, 'utf8'));
  else warnings.push('docs/ROTATION_LOG.md がありません（試験枠の28日の条件を使わず、全記事を公開60日で見ました）');

  const rows = classifyRotationCandidates({
    today,
    articles,
    gscImpressions,
    outbound,
    bingImpressions,
    bingHealthy: bingWindow.health.healthy,
    frozen,
    noindexed,
    seasonal,
    improvements,
    recoverPending,
    trialFailed,
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    today,
    confirmed,
    windows: { gsc: `${start}〜${confirmed}`, ga4: `${start}〜${confirmed}`, bing: bingWindow },
    rules: { minAgeDays: 60, trialFailedMinAgeDays: 28, maxImpressions: 10, bingAddThreshold: 100 },
    missing: {
      ga4: outbound === null,
      bing: bingImpressions === null,
      holds: frozen === null,
      improvementLog: improvements === null,
    },
    warnings,
    rows,
  };
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, `candidates-${confirmed}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeFileSync(`${base}.md`, renderMarkdown(payload), 'utf8');

  const counts = {};
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  console.log(`GSC 確定日 ${confirmed}・対象 ${rows.length} 本: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / ') || 'なし'}`);
  for (const w of warnings) console.warn(`警告: ${w}`);
  console.log(`出力: ${path.relative(ROOT, base)}.{json,md}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
