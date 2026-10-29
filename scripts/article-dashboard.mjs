// 記事別ダッシュボード（HTML）生成 CLI
//
// 使い方:
//   pnpm article-dashboard                  # 直近90日の日次 + 28日集計で生成
//   pnpm article-dashboard -- --days=120    # 日次グラフの日数
//   pnpm article-dashboard -- --no-inspect  # URL 検査（インデックス状態）をスキップ
//   pnpm article-dashboard -- --no-bing     # Bing をスキップ
//
// 出力（reports/ は gitignore 済み）:
//   reports/dashboard/articles-<GSC確定日>.html  ← 1ファイル完結（外部読み込みなし）
//
// データ源:
//   記事・商品数        src/content/articles/**/*.md（現在値）＋ git 履歴（推移）
//   検索（GSC）         page×date。確定日は dimensions:["date"] で実測する（CLAUDE.md §5.0.2）
//   アクセス・送客（GA4） pagePath×date の PV / セッション / 送客イベント（終端は T-1。engagementRate は読まない）
//   Bing               GetPageStats を28日窓で絞って合算
//   施策・変化点        data/measurement-holds.json / docs/CONTENT_IMPROVEMENT_LOG.md /
//                      data/deleted-products-history.jsonl / data/noindex-articles.json / git log
//   インデックス        URL 検査 API（状態・最終クロール）＋ GSC の初表示日（登録日の目安）
//
// これは閲覧用の一覧で、施策の判定には使わない（判定は baseline-*.json の差分で行う）。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import yaml from 'js-yaml';
import {
  getGscAuth,
  querySearchAnalytics,
  fetchAllSearchAnalytics,
  resolveServiceAccountKey,
  missingKeyMessage,
  toDateString,
  SITE_URL,
} from './lib/gsc-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTICLES_DIR = path.join(ROOT, 'src/content/articles');
const OUTPUT_DIR = path.join(ROOT, 'reports/dashboard');
const ENV_PATH = path.join(ROOT, '.env');

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID ?? '535186053';
// weekly-snapshot.mjs と同じ送客イベント
const OUTBOUND_EVENTS = [
  'click_rakuten_link',
  'click_yahoo_link',
  'click_amazon_link',
  'click_service_link',
];
const BING_API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const BING_SITE_URL = process.env.BING_SITE_URL ?? SITE_URL;
const SUMMARY_DAYS = 28;

function parseArgs(argv) {
  const options = { days: 90, inspect: true, bing: true };
  for (const arg of argv) {
    if (arg === '--no-inspect') options.inspect = false;
    else if (arg === '--no-bing') options.bing = false;
    else if (arg.startsWith('--days=')) options.days = Math.max(28, Number(arg.slice(7)) || 90);
  }
  return options;
}

function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function fmtDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// ---------------------------------------------------------------- 記事

function listArticleFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listArticleFiles(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** 商品（または services）の件数。履歴は大量なので YAML を解かず行で数える */
function countProductsFast(text) {
  const fm = FRONTMATTER_RE.exec(text)?.[1];
  if (!fm) return null;
  return (fm.match(/^ {2}- rank:/gm) ?? []).length;
}

function loadArticles() {
  const articles = [];
  for (const file of listArticleFiles(ARTICLES_DIR)) {
    const text = readFileSync(file, 'utf8');
    const fm = FRONTMATTER_RE.exec(text)?.[1];
    if (!fm) continue;
    const data = yaml.load(fm) ?? {};
    if (data.draft === true) continue;
    const rel = path.relative(ARTICLES_DIR, file).replace(/\\/g, '/');
    const id = rel.replace(/\.md$/, '');
    const items = Array.isArray(data.products) ? data.products : Array.isArray(data.services) ? data.services : [];
    articles.push({
      id,
      file: `src/content/articles/${rel}`,
      url: `${SITE_URL}articles/${id}/`,
      path: `/articles/${id}/`,
      title: data.title ?? id,
      category: data.category ?? '',
      articleType: data.articleType ?? '',
      publishedAt: fmtDate(data.publishedAt),
      updatedAt: fmtDate(data.updatedAt),
      products: items.length,
      productsFast: countProductsFast(text),
      faqs: Array.isArray(data.faqs) ? data.faqs.length : 0,
      bodyChars: text.slice(text.indexOf('---', 3) + 3).replace(/\s/g, '').length,
    });
  }
  return articles;
}

// ---------------------------------------------------------------- git 履歴

function git(args, input) {
  const res = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT,
    input,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`git ${args[0]} 失敗: ${res.stderr?.toString()}`);
  return res.stdout;
}

function isBotCommit(commit) {
  return commit.subject.startsWith('商品データ更新') || /github-actions|\[bot\]/i.test(commit.author);
}

/** 記事ファイルに触れたコミットを古い順で返す */
function loadCommits() {
  const out = git([
    'log',
    '--reverse',
    '--format=@@%H%x09%ad%x09%an%x09%s',
    '--date=short',
    '--name-only',
    '--',
    'src/content/articles',
  ]).toString('utf8');
  const commits = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      const [hash, date, author, ...rest] = line.slice(2).split('\t');
      current = { hash, date, author, subject: rest.join('\t'), files: [] };
      commits.push(current);
    } else if (current && line.endsWith('.md') && line.startsWith('src/content/articles/')) {
      current.files.push(line);
    }
  }
  return commits;
}

/** `git cat-file --batch` を1回だけ起動して、各コミット時点の商品数を数える */
function countProductsAtCommits(specs) {
  if (specs.length === 0) return new Map();
  const buf = git(['cat-file', '--batch'], specs.join('\n') + '\n');
  const counts = new Map();
  let pos = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(0x0a, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing')) {
      counts.set(spec, null); // そのコミットで削除された
      continue;
    }
    const size = Number(header.split(' ')[2]);
    const content = buf.subarray(pos, pos + size).toString('utf8');
    pos += size + 1;
    counts.set(spec, countProductsFast(content));
  }
  return counts;
}

function buildGitHistory(articles) {
  const byFile = new Map(articles.map((a) => [a.file, a]));
  const commits = loadCommits();
  const specs = [];
  for (const c of commits) for (const f of c.files) if (byFile.has(f)) specs.push(`${c.hash}:${f}`);
  const counts = countProductsAtCommits(specs);

  const history = new Map(articles.map((a) => [a.id, { products: [], commits: [] }]));
  for (const c of commits) {
    for (const f of c.files) {
      const article = byFile.get(f);
      if (!article) continue;
      const h = history.get(article.id);
      const count = counts.get(`${c.hash}:${f}`);
      const prev = h.products.at(-1);
      if (count != null && (!prev || prev.count !== count)) {
        // 同じ日に複数回動いたら、その日の最後の値だけ残す
        if (prev && prev.date === c.date) prev.count = count;
        else h.products.push({ date: c.date, count, from: prev?.count ?? null });
      }
      if (!isBotCommit(c)) {
        h.commits.push({ date: c.date, hash: c.hash.slice(0, 8), subject: c.subject });
      }
    }
  }
  return history;
}

// ---------------------------------------------------------------- ローカル台帳

function readJson(rel, fallback) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 改善ログの slug は「-comparison」を省いた短縮形なので記事 ID に寄せる */
function resolveLogSlug(slug, ids) {
  for (const candidate of [slug, `${slug}-comparison`]) if (ids.has(candidate)) return candidate;
  for (const id of ids) if (id.endsWith(`/${slug}`)) return id;
  return null;
}

function loadImprovementLog(ids) {
  const p = path.join(ROOT, 'docs/CONTENT_IMPROVEMENT_LOG.md');
  if (!existsSync(p)) return [];
  const rows = [];
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const cells = line.split('|').map((s) => s.trim());
    // | 日付 | 記事 | 型 | 内容 | コミット | 登録リクエスト |
    if (cells.length < 8 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[1])) continue;
    const id = resolveLogSlug(cells[2], ids);
    if (!id) continue;
    rows.push({ date: cells[1], id, type: cells[3], text: cells[4], request: cells[6] });
  }
  return rows;
}

function buildLocalEvents(articles, today) {
  const ids = new Set(articles.map((a) => a.id));
  const events = new Map(articles.map((a) => [a.id, []]));
  const push = (id, ev) => events.get(id)?.push(ev);

  const holds = readJson('data/measurement-holds.json', { holds: [] }).holds ?? [];
  const activeHold = new Map();
  for (const h of holds) {
    if (!ids.has(h.slug)) continue;
    push(h.slug, {
      date: h.startedAt,
      kind: 'hold',
      text: `測定施策: ${(h.actions ?? []).join(' / ')}（解除 ${h.releaseLabel ?? h.releaseDate}）`,
    });
    if (h.releaseDate > today) activeHold.set(h.slug, h.releaseLabel ?? h.releaseDate);
  }

  const requests = new Map();
  for (const r of loadImprovementLog(ids)) {
    push(r.id, { date: r.date, kind: 'improve', text: `加筆 ${r.type}: ${r.text}` });
    const m = /(\d{1,2})-(\d{1,2})/.exec(r.request ?? '');
    if (m) {
      const d = `${r.date.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      push(r.id, { date: d, kind: 'index', text: 'GSC 登録リクエスト' });
      if (!requests.has(r.id) || requests.get(r.id) < d) requests.set(r.id, d);
    }
  }

  const deletedPath = path.join(ROOT, 'data/deleted-products-history.jsonl');
  if (existsSync(deletedPath)) {
    const grouped = new Map();
    for (const line of readFileSync(deletedPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const id = row.articleFile?.replace(/^src\/content\/articles\//, '').replace(/\.md$/, '');
      if (!ids.has(id)) continue;
      const key = `${id}\t${row.deletedAt}\t${row.reason}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row.name);
    }
    for (const [key, names] of grouped) {
      const [id, date, reason] = key.split('\t');
      push(id, { date, kind: 'delete', text: `商品削除 ${names.length}件（${reason}）: ${names.join('、')}` });
    }
  }

  const noindex = new Map();
  for (const n of readJson('data/noindex-articles.json', [])) {
    if (!ids.has(n.slug)) continue;
    noindex.set(n.slug, n.date);
    push(n.slug, { date: n.date, kind: 'noindex', text: `noindex 化: ${n.reason}` });
  }

  return { events, activeHold, noindex, requests };
}

// ---------------------------------------------------------------- GSC

async function collectGsc(auth, articles, options) {
  const today = toDateString(new Date());
  const probe = await querySearchAnalytics(auth, {
    startDate: addDays(today, -10),
    endDate: today,
    dimensions: ['date'],
  });
  const confirmed = probe.map((r) => r.keys[0]).sort().at(-1);
  if (!confirmed) throw new Error('GSC の確定日を実測できませんでした');

  // 初表示日を出すため、最古の公開日から全期間を page×date で取る
  const earliest = articles.map((a) => a.publishedAt).filter(Boolean).sort()[0] ?? addDays(confirmed, -480);
  const rows = await fetchAllSearchAnalytics(auth, {
    startDate: earliest,
    endDate: confirmed,
    dimensions: ['page', 'date'],
    maxRows: 200000,
    pageSize: 25000,
  });
  const byUrl = new Map();
  for (const r of rows) {
    const [page, date] = r.keys;
    if (page.includes('#')) continue; // 見出しアンカー行は除外（§5.0.2 ルール3）
    if (!byUrl.has(page)) byUrl.set(page, []);
    byUrl.get(page).push({ date, clicks: r.clicks, impressions: r.impressions, position: r.position });
  }

  const queryRows = await fetchAllSearchAnalytics(auth, {
    startDate: addDays(confirmed, -(SUMMARY_DAYS - 1)),
    endDate: confirmed,
    dimensions: ['page', 'query'],
    maxRows: 50000,
    pageSize: 25000,
  });
  const topQuery = new Map();
  for (const r of queryRows) {
    const [page, query] = r.keys;
    const cur = topQuery.get(page);
    if (!cur || r.impressions > cur.impressions) {
      topQuery.set(page, { query, impressions: r.impressions, clicks: r.clicks, position: r.position });
    }
  }
  return { confirmed, byUrl, topQuery };
}

async function collectInspection(auth, articles) {
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const out = new Map();
  let done = 0;
  // URL 検査 API はサイト単位の日次クォータがあるので直列で叩く
  for (const a of articles) {
    try {
      const res = await searchconsole.urlInspection.index.inspect({
        requestBody: { inspectionUrl: a.url, siteUrl: SITE_URL },
      });
      const s = res.data.inspectionResult?.indexStatusResult ?? {};
      out.set(a.id, {
        verdict: s.verdict ?? null,
        coverageState: s.coverageState ?? null,
        lastCrawlTime: s.lastCrawlTime ?? null,
        googleCanonical: s.googleCanonical ?? null,
      });
    } catch (error) {
      out.set(a.id, { error: error.message });
    }
    done += 1;
    if (done % 20 === 0) console.log(`  URL 検査 ${done}/${articles.length}`);
  }
  return out;
}

// ---------------------------------------------------------------- GA4

async function collectGa4(start, end) {
  const resolved = resolveServiceAccountKey();
  if (!resolved) throw new Error(missingKeyMessage());
  const auth = new google.auth.GoogleAuth({
    keyFile: resolved.keyFile,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  const client = google.analyticsdata({ version: 'v1beta', auth: await auth.getClient() });

  async function run(dimensions, metrics, dimensionFilter) {
    const rows = [];
    for (let offset = 0; ; offset += 100000) {
      const requestBody = {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        limit: 100000,
        offset,
      };
      if (dimensionFilter) requestBody.dimensionFilter = dimensionFilter;
      const res = await client.properties.runReport({ property: `properties/${GA4_PROPERTY_ID}`, requestBody });
      const batch = res.data.rows ?? [];
      for (const row of batch) {
        rows.push({
          dims: row.dimensionValues.map((v) => v.value),
          values: row.metricValues.map((v) => Number(v.value)),
        });
      }
      if (offset + batch.length >= (res.data.rowCount ?? 0) || batch.length === 0) break;
    }
    return rows;
  }

  const normalize = (p) => (p.endsWith('/') ? p : `${p}/`);
  const toIso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

  const daily = new Map(); // path -> date -> {pv, sessions, outbound}
  const cell = (p, d) => {
    if (!daily.has(p)) daily.set(p, new Map());
    const m = daily.get(p);
    if (!m.has(d)) m.set(d, { pv: 0, sessions: 0, outbound: 0, byProvider: {} });
    return m.get(d);
  };
  for (const r of await run(['pagePath', 'date'], ['screenPageViews', 'sessions'])) {
    const c = cell(normalize(r.dims[0]), toIso(r.dims[1]));
    c.pv += r.values[0];
    c.sessions += r.values[1];
  }
  const outboundFilter = { filter: { fieldName: 'eventName', inListFilter: { values: OUTBOUND_EVENTS } } };
  for (const r of await run(['pagePath', 'date', 'eventName'], ['eventCount'], outboundFilter)) {
    const c = cell(normalize(r.dims[0]), toIso(r.dims[1]));
    c.outbound += r.values[0];
    const provider = r.dims[2].replace(/^click_|_link$/g, '');
    c.byProvider[provider] = (c.byProvider[provider] ?? 0) + r.values[0];
  }
  return daily;
}

// ---------------------------------------------------------------- Bing

const WCF_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;
function parseWcfDate(value) {
  const match = typeof value === 'string' ? WCF_DATE.exec(value) : null;
  if (!match) return null;
  return new Date(Number(match[1])).toISOString().slice(0, 10);
}

async function collectBing(start, end) {
  const apiKey = process.env.BING_WEBMASTER_API_KEY;
  if (!apiKey) throw new Error('BING_WEBMASTER_API_KEY が未設定です（.env）');
  const url = new URL(`${BING_API_BASE}/GetPageStats`);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('siteUrl', BING_SITE_URL);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bing API GetPageStats が ${res.status} を返しました`);
  const json = await res.json();
  const rows = json?.d ?? json;
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = parseWcfDate(row?.Date);
    if (!date || date < start || date > end) continue;
    const page = String(row.Query ?? row.Url ?? '');
    const cur = out.get(page) ?? { clicks: 0, impressions: 0 };
    cur.clicks += Number(row.Clicks ?? 0);
    cur.impressions += Number(row.Impressions ?? 0);
    out.set(page, cur);
  }
  return out;
}

// ---------------------------------------------------------------- 集計

function sumWindow(series, start, end) {
  let clicks = 0;
  let impressions = 0;
  let posWeighted = 0;
  for (const r of series ?? []) {
    if (r.date < start || r.date > end) continue;
    clicks += r.clicks;
    impressions += r.impressions;
    posWeighted += r.position * r.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: impressions > 0 ? posWeighted / impressions : null,
  };
}

function round(v, digits = 1) {
  return v == null ? null : Math.round(v * 10 ** digits) / 10 ** digits;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (existsSync(ENV_PATH)) {
    try {
      process.loadEnvFile(ENV_PATH);
    } catch {
      // .env が読めなくても既定パスの鍵で動く可能性がある
    }
  }
  const today = toDateString(new Date());
  const warnings = [];

  console.log('記事と git 履歴を読み込み中…');
  const articles = loadArticles();
  const mismatch = articles.filter((a) => a.productsFast !== a.products);
  if (mismatch.length) {
    warnings.push(`商品数の行カウントと YAML が食い違う記事: ${mismatch.map((a) => a.id).join(', ')}（推移グラフの値がずれている可能性）`);
  }
  const history = buildGitHistory(articles);
  const local = buildLocalEvents(articles, today);

  console.log('GSC を取得中…');
  const auth = await getGscAuth();
  const gsc = await collectGsc(auth, articles, options);
  const confirmed = gsc.confirmed;
  const dailyStart = addDays(confirmed, -(options.days - 1));
  const sumStart = addDays(confirmed, -(SUMMARY_DAYS - 1));
  const prevEnd = addDays(sumStart, -1);
  const prevStart = addDays(prevEnd, -(SUMMARY_DAYS - 1));

  // GA4 は T-1 まで（PV・セッション・イベント数だけ使う。§5.0.2 ルール2）
  const ga4End = addDays(today, -1);
  const ga4SumStart = addDays(ga4End, -(SUMMARY_DAYS - 1));
  let ga4 = null;
  console.log('GA4 を取得中…');
  try {
    ga4 = await collectGa4(addDays(ga4End, -(options.days - 1)), ga4End);
  } catch (error) {
    warnings.push(`GA4 を取得できませんでした: ${error.message}`);
  }

  let bing = null;
  if (options.bing) {
    console.log('Bing を取得中…');
    try {
      bing = await collectBing(sumStart, confirmed);
    } catch (error) {
      warnings.push(`Bing を取得できませんでした: ${error.message}`);
    }
  }

  let inspection = null;
  if (options.inspect) {
    console.log(`URL 検査中（${articles.length}件・直列）…`);
    inspection = await collectInspection(auth, articles);
  }

  const dates = [];
  for (let d = dailyStart; d <= confirmed; d = addDays(d, 1)) dates.push(d);
  const ga4Dates = [];
  for (let d = addDays(ga4End, -(options.days - 1)); d <= ga4End; d = addDays(d, 1)) ga4Dates.push(d);

  const rows = articles.map((a) => {
    const series = gsc.byUrl.get(a.url) ?? [];
    const cur = sumWindow(series, sumStart, confirmed);
    const prev = sumWindow(series, prevStart, prevEnd);
    const firstImpression = series.filter((r) => r.impressions > 0).map((r) => r.date).sort()[0] ?? null;
    const gscByDate = new Map(series.map((r) => [r.date, r]));
    const ga4Map = ga4?.get(a.path) ?? new Map();

    let pv = 0;
    let sessions = 0;
    let outbound = 0;
    const providers = {};
    for (const [d, c] of ga4Map) {
      if (d < ga4SumStart || d > ga4End) continue;
      pv += c.pv;
      sessions += c.sessions;
      outbound += c.outbound;
      for (const [k, v] of Object.entries(c.byProvider)) providers[k] = (providers[k] ?? 0) + v;
    }

    const h = history.get(a.id);
    const events = [
      ...(a.publishedAt ? [{ date: a.publishedAt, kind: 'publish', text: '公開' }] : []),
      ...local.events.get(a.id),
      ...h.commits.map((c) => ({ date: c.date, kind: 'commit', text: `${c.subject}（${c.hash}）` })),
      ...h.products
        .filter((p) => p.from != null)
        .map((p) => ({ date: p.date, kind: 'products', text: `商品数 ${p.from} → ${p.count}` })),
    ].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
    const actions = events.filter((e) => ['hold', 'improve', 'commit', 'delete', 'noindex'].includes(e.kind));

    const insp = inspection?.get(a.id) ?? null;
    const b = bing?.get(a.url) ?? null;
    const tq = gsc.topQuery.get(a.url) ?? null;
    return {
      id: a.id,
      url: a.url,
      title: a.title,
      category: a.category,
      articleType: a.articleType,
      publishedAt: a.publishedAt,
      updatedAt: a.updatedAt,
      ageDays: a.publishedAt ? Math.round((Date.parse(today) - Date.parse(a.publishedAt)) / 86400000) : null,
      products: a.products,
      productsMin: h.products.length ? Math.min(...h.products.map((p) => p.count)) : a.products,
      productsMax: h.products.length ? Math.max(...h.products.map((p) => p.count)) : a.products,
      productHistory: h.products.map((p) => [p.date, p.count]),
      faqs: a.faqs,
      bodyChars: a.bodyChars,
      hold: local.activeHold.get(a.id) ?? null,
      noindex: local.noindex.get(a.id) ?? null,
      clicks: cur.clicks,
      clicksPrev: prev.clicks,
      clicksDelta: prev.clicks > 0 ? round((cur.clicks / prev.clicks - 1) * 100, 0) : null,
      impressions: cur.impressions,
      impressionsPrev: prev.impressions,
      ctr: round(cur.ctr == null ? null : cur.ctr * 100, 2),
      position: round(cur.position),
      positionPrev: round(prev.position),
      topQuery: tq?.query ?? null,
      topQueryImpr: tq?.impressions ?? null,
      bingClicks: b?.clicks ?? null,
      bingImpressions: b?.impressions ?? null,
      pv: ga4 ? pv : null,
      sessions: ga4 ? sessions : null,
      outbound: ga4 ? outbound : null,
      outboundRate: ga4 && pv > 0 ? round((outbound / pv) * 100, 2) : null,
      providers,
      firstImpression,
      daysToFirstImpression:
        firstImpression && a.publishedAt
          ? Math.round((Date.parse(firstImpression) - Date.parse(a.publishedAt)) / 86400000)
          : null,
      indexRequest: local.requests.get(a.id) ?? null,
      coverageState: insp?.coverageState ?? insp?.error ?? null,
      verdict: insp?.verdict ?? null,
      lastCrawl: insp?.lastCrawlTime ? insp.lastCrawlTime.slice(0, 10) : null,
      actionCount: actions.length,
      lastAction: actions[0]?.date ?? null,
      events,
      gscDaily: dates.map((d) => {
        const r = gscByDate.get(d);
        return r ? [r.clicks, r.impressions, round(r.position)] : [0, 0, null];
      }),
      ga4Daily: ga4Dates.map((d) => {
        const c = ga4Map.get(d);
        return c ? [c.pv, c.sessions, c.outbound] : [0, 0, 0];
      }),
    };
  });

  const meta = {
    generatedAt: new Date().toISOString(),
    gscConfirmed: confirmed,
    gscWindow: [sumStart, confirmed],
    gscPrevWindow: [prevStart, prevEnd],
    ga4Window: ga4 ? [ga4SumStart, ga4End] : null,
    bingWindow: bing ? [sumStart, confirmed] : null,
    dates,
    ga4Dates,
    inspected: Boolean(inspection),
    warnings,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `articles-${confirmed}.html`);
  writeFileSync(outPath, renderHtml({ meta, rows }), 'utf8');
  console.log(`GSC の最新確定日は ${confirmed}`);
  for (const w of warnings) console.warn(`⚠ ${w}`);
  console.log(`出力: ${path.relative(ROOT, outPath)}（${rows.length}記事）`);
}

// ---------------------------------------------------------------- HTML

function renderHtml(payload) {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KuraSelect 記事一覧</title>
<style>
:root {
  --bg: #f7f7f5; --surface: #ffffff; --surface-2: #f0f0ec; --text: #1d1d1b; --muted: #6b6b66;
  --border: #e2e2dc; --accent: #2f6fdb; --good: #1f8a4c; --bad: #c4372f; --warn: #b7791f;
  --c-pv: #2f6fdb; --c-click: #1f8a4c; --c-impr: #9aa5b1; --c-pos: #8a4fd1; --c-out: #d9822b; --c-prod: #2b8a8a;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141413; --surface: #1d1d1b; --surface-2: #262624; --text: #ecebe6; --muted: #9c9b95;
    --border: #34332f; --accent: #6b9cf0; --good: #4cc27d; --bad: #f0736a; --warn: #e0a84a;
    --c-pv: #6b9cf0; --c-click: #4cc27d; --c-impr: #6c7680; --c-pos: #b48af0; --c-out: #f0a35e; --c-prod: #5cc2c2;
  }
}
:root[data-theme="dark"] {
  --bg: #141413; --surface: #1d1d1b; --surface-2: #262624; --text: #ecebe6; --muted: #9c9b95;
  --border: #34332f; --accent: #6b9cf0; --good: #4cc27d; --bad: #f0736a; --warn: #e0a84a;
  --c-pv: #6b9cf0; --c-click: #4cc27d; --c-impr: #6c7680; --c-pos: #b48af0; --c-out: #f0a35e; --c-prod: #5cc2c2;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.5 "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; }
header { padding: 16px; border-bottom: 1px solid var(--border); background: var(--surface); }
h1 { margin: 0 0 4px; font-size: 18px; }
.meta { color: var(--muted); font-size: 12px; }
.warn { color: var(--warn); font-size: 12px; margin-top: 4px; }
.kpis { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.kpi { background: var(--surface-2); border-radius: 8px; padding: 6px 12px; min-width: 110px; }
.kpi b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
.kpi span { color: var(--muted); font-size: 11px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; background: var(--bg); border-bottom: 1px solid var(--border); }
.controls input[type=search], .controls select { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; font: inherit; }
.controls input[type=search] { width: 220px; max-width: 100%; }
.controls label { color: var(--muted); white-space: nowrap; }
.wrap { overflow: auto; max-height: calc(100vh - 56px); margin: 12px 16px 0; border: 1px solid var(--border); }
table { border-collapse: collapse; width: 100%; min-width: 1500px; background: var(--surface); }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
th { position: sticky; top: 0; background: var(--surface-2); font-weight: 600; font-size: 12px; cursor: pointer; user-select: none; z-index: 2; }
th.l, td.l { text-align: left; }
th[data-dir="asc"]::after { content: " ▲"; color: var(--accent); }
th[data-dir="desc"]::after { content: " ▼"; color: var(--accent); }
th .sub { display: block; font-weight: 400; color: var(--muted); font-size: 10px; }
tbody tr.row { cursor: pointer; }
tbody tr.row:hover { background: var(--surface-2); }
tbody tr.row.open { background: var(--surface-2); }
td.title { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
td.title a { color: var(--text); text-decoration: none; }
td.title .id { display: block; color: var(--muted); font-size: 11px; }
.up { color: var(--good); } .down { color: var(--bad); } .na { color: var(--muted); }
.tag { display: inline-block; border-radius: 4px; padding: 0 6px; font-size: 11px; margin-right: 4px; }
.tag.hold { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.tag.noidx { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
.tag.ok { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
svg.spark { display: block; }
tr.detail td { background: var(--surface); text-align: left; white-space: normal; padding: 12px 16px 20px; }
.detail-inner { position: sticky; left: 16px; width: calc(100vw - 80px); }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px 20px; }
.chart h4 { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.chart h4 .lg { font-weight: 400; color: var(--muted); margin-left: 8px; }
.chart h4 .sw { display: inline-block; width: 10px; height: 3px; vertical-align: middle; margin: 0 3px 0 8px; }
.chart svg { width: 100%; height: 130px; display: block; }
.chart .axis { fill: var(--muted); font-size: 10px; }
.chart .grid { stroke: var(--border); }
.facts { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 0 0 12px; color: var(--muted); }
.facts b { color: var(--text); font-weight: 600; }
.events { margin-top: 14px; max-height: 320px; overflow-y: auto; border-top: 1px solid var(--border); }
.events div { display: grid; grid-template-columns: 90px 70px 1fr; gap: 8px; padding: 4px 0; border-bottom: 1px dashed var(--border); }
.events .k { font-size: 11px; color: var(--muted); }
.k-hold { color: var(--warn) !important; } .k-improve { color: var(--accent) !important; } .k-products { color: var(--c-prod) !important; }
.k-delete, .k-noindex { color: var(--bad) !important; } .k-publish, .k-index { color: var(--good) !important; }
.note { color: var(--muted); font-size: 11px; padding: 8px 16px; }

</style>
</head>
<body>
<header>
  <h1>KuraSelect 記事一覧</h1>
  <div class="meta" id="meta"></div>
  <div id="warnings"></div>
  <div class="kpis" id="kpis"></div>
</header>
<div class="controls">
  <input type="search" id="q" placeholder="タイトル・slug・カテゴリ・クエリで絞り込み">
  <select id="type"><option value="">すべての種別</option></select>
  <label><input type="checkbox" id="onlyHold"> 凍結中のみ</label>
  <label><input type="checkbox" id="hideNoindex"> noindex を隠す</label>
  <label>スパークライン <select id="sparkMetric">
    <option value="clicks">GSC クリック</option><option value="impr">GSC 表示</option>
    <option value="pv">PV</option><option value="out">送客</option><option value="pos">順位</option>
  </select></label>
  <span class="meta" id="count"></span>
</div>
<div class="wrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
<p class="note">行をクリックすると日次グラフ・商品数の推移・施策と変化点の履歴を開きます。グラフの縦線は施策・変化点の日付です。
この一覧は閲覧用で、施策の効果判定には使いません（判定は reports/gsc-harvest/baseline-*.json の差分で行う）。</p>
<script id="data" type="application/json">${json}</script>
<script>
(() => {
  const { meta, rows } = JSON.parse(document.getElementById('data').textContent);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const num = (v, d = 0) => v == null ? '<span class="na">—</span>' : Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtDay = (s) => s ? s.slice(5) : '';

  const w = (a) => a ? a[0] + '〜' + a[1] : '取得なし';
  $('meta').innerHTML = 'GSC の最新確定日は <b>' + meta.gscConfirmed + '</b>　/　GSC 集計 ' + w(meta.gscWindow) + '（前28日 ' + w(meta.gscPrevWindow) + '）'
    + '　/　GA4 ' + w(meta.ga4Window) + '（T-1 含む・PV/セッション/イベント数のみ）　/　Bing ' + w(meta.bingWindow)
    + '　/　生成 ' + new Date(meta.generatedAt).toLocaleString('ja-JP');
  $('warnings').innerHTML = meta.warnings.map((x) => '<div class="warn">⚠ ' + esc(x) + '</div>').join('');

  const total = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const kpi = (label, v) => '<div class="kpi"><b>' + v + '</b><span>' + label + '</span></div>';
  $('kpis').innerHTML = [
    kpi('記事数', rows.length),
    kpi('凍結中', rows.filter((r) => r.hold).length),
    kpi('GSC クリック（28日・ページ行合計）', num(total('clicks'))),
    kpi('GSC 表示（28日）', num(total('impressions'))),
    kpi('PV（28日）', num(total('pv'))),
    kpi('送客（28日）', num(total('outbound'))),
    kpi('Bing クリック（28日）', num(total('bingClicks'))),
  ].join('');

  const types = [...new Set(rows.map((r) => r.articleType).filter(Boolean))].sort();
  $('type').innerHTML += types.map((t) => '<option>' + esc(t) + '</option>').join('');

  // 列定義: key はソートキー
  const delta = (cur, prev, invert) => {
    if (cur == null || prev == null) return '';
    const d = cur - prev;
    if (Math.abs(d) < 0.05) return '';
    const good = invert ? d < 0 : d > 0;
    return ' <span class="' + (good ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + d.toFixed(1) + '</span>';
  };
  const cols = [
    { key: 'title', label: '記事', cls: 'l title', html: (r) => '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(r.title) + '</a><span class="id">' + esc(r.id) + '</span>' },
    { key: 'status', label: '状態', cls: 'l', sort: (r) => (r.hold ? 2 : 0) + (r.noindex ? 1 : 0), html: (r) => (r.hold ? '<span class="tag hold">凍結〜' + fmtDay(r.hold) + '</span>' : '') + (r.noindex ? '<span class="tag noidx">noindex</span>' : '') },
    { key: 'spark', label: '日次推移', sub: '直近' + meta.dates.length + '日', cls: 'l', nosort: true, html: (r) => spark(r) },
    { key: 'clicks', label: 'クリック', sub: 'GSC 28日', html: (r) => num(r.clicks) },
    { key: 'clicksDelta', label: '前28日比', sub: '%', html: (r) => r.clicksDelta == null ? num(null) : '<span class="' + (r.clicksDelta >= 0 ? 'up' : 'down') + '">' + (r.clicksDelta > 0 ? '+' : '') + r.clicksDelta + '%</span>' },
    { key: 'impressions', label: '表示', sub: 'GSC 28日', html: (r) => num(r.impressions) },
    { key: 'ctr', label: 'CTR', sub: '%', html: (r) => num(r.ctr, 2) },
    { key: 'position', label: '掲載順位', sub: '表示加重・前28日差', html: (r) => num(r.position, 1) + delta(r.position, r.positionPrev, true) },
    { key: 'topQuery', label: '最多表示クエリ', cls: 'l', html: (r) => r.topQuery ? esc(r.topQuery) + ' <span class="na">' + r.topQueryImpr + '</span>' : num(null) },
    { key: 'pv', label: 'PV', sub: 'GA4 28日', html: (r) => num(r.pv) },
    { key: 'sessions', label: 'セッション', sub: 'GA4 28日', html: (r) => num(r.sessions) },
    { key: 'outbound', label: '送客', sub: 'GA4 28日', html: (r) => '<span title="' + esc(Object.entries(r.providers).map(([k, v]) => k + ' ' + v).join(' / ')) + '">' + num(r.outbound) + '</span>' },
    { key: 'outboundRate', label: '送客率', sub: '送客÷PV %', html: (r) => num(r.outboundRate, 2) },
    { key: 'bingClicks', label: 'Bing', sub: 'クリック 28日', html: (r) => num(r.bingClicks) },
    { key: 'products', label: '商品数', sub: '現在（最小〜最大）', html: (r) => r.products + ' <span class="na">(' + r.productsMin + '〜' + r.productsMax + ')</span>' },
    { key: 'faqs', label: 'FAQ', html: (r) => num(r.faqs) },
    { key: 'bodyChars', label: '本文', sub: '文字(空白除く)', html: (r) => num(r.bodyChars) },
    { key: 'publishedAt', label: '公開日', html: (r) => esc(r.publishedAt ?? '') + ' <span class="na">' + (r.ageDays ?? '') + '日</span>' },
    { key: 'firstImpression', label: '初表示日', sub: '≒登録の目安（公開から日数）', html: (r) => r.firstImpression ? r.firstImpression + ' <span class="na">+' + r.daysToFirstImpression + '日</span>' : num(null) },
    { key: 'coverageState', label: 'インデックス', sub: meta.inspected ? 'URL 検査' : '未取得', cls: 'l', html: (r) => r.coverageState ? '<span class="tag ' + (r.verdict === 'PASS' ? 'ok' : 'noidx') + '">' + esc(r.coverageState) + '</span>' : num(null) },
    { key: 'lastCrawl', label: '最終クロール', html: (r) => esc(r.lastCrawl ?? '—') },
    { key: 'indexRequest', label: '登録リクエスト', sub: '改善ログ', html: (r) => esc(r.indexRequest ?? '—') },
    { key: 'actionCount', label: '施策・変更', sub: '件数', html: (r) => num(r.actionCount) },
    { key: 'lastAction', label: '最終施策日', html: (r) => esc(r.lastAction ?? '—') },
  ];

  let sortKey = 'clicks';
  let sortDir = 'desc';
  let open = new Set();

  $('thead').innerHTML = '<tr>' + cols.map((c) => '<th class="' + (c.cls ?? '').replace('title', '') + '" data-key="' + c.key + '"' + (c.nosort ? ' style="cursor:default"' : '') + '>' + c.label + (c.sub ? '<span class="sub">' + c.sub + '</span>' : '') + '</th>').join('') + '</tr>';
  $('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th');
    const col = cols.find((c) => c.key === th?.dataset.key);
    if (!col || col.nosort) return;
    if (sortKey === col.key) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    else { sortKey = col.key; sortDir = ['title', 'topQuery', 'coverageState', 'publishedAt', 'firstImpression', 'position'].includes(col.key) ? 'asc' : 'desc'; }
    render();
  });

  function sortValue(r) {
    const col = cols.find((c) => c.key === sortKey);
    return col.sort ? col.sort(r) : r[sortKey];
  }

  function spark(r) {
    const m = $('sparkMetric').value;
    const pick = { clicks: [r.gscDaily, 0], impr: [r.gscDaily, 1], pos: [r.gscDaily, 2], pv: [r.ga4Daily, 0], out: [r.ga4Daily, 2] }[m];
    const vals = pick[0].map((d) => d[pick[1]]);
    const W = 120, H = 26;
    const defined = vals.filter((v) => v != null);
    if (!defined.length || defined.every((v) => v === 0)) return '<span class="na">—</span>';
    let min = m === 'pos' ? Math.min(...defined) : 0;
    let max = Math.max(...defined);
    if (max === min) max = min + 1;
    const x = (i) => (i / (vals.length - 1)) * W;
    const y = (v) => m === 'pos' ? 2 + ((v - min) / (max - min)) * (H - 4) : H - 2 - ((v - min) / (max - min)) * (H - 4);
    let d = '';
    vals.forEach((v, i) => { if (v == null) return; d += (d && vals[i - 1] != null ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); });
    const color = { clicks: 'var(--c-click)', impr: 'var(--c-impr)', pos: 'var(--c-pos)', pv: 'var(--c-pv)', out: 'var(--c-out)' }[m];
    return '<svg class="spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '"><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.4"/></svg>';
  }

  // 日次グラフ（SVG）。series = [{values, color, kind:'line'|'bar'}]
  function chart(title, dates, series, opts = {}) {
    const W = 600, H = 130, L = 34, R = 8, T = 6, B = 18;
    const all = series.flatMap((s) => s.values).filter((v) => v != null);
    if (!all.length) return '<div class="chart"><h4>' + title + '</h4><div class="na">データなし</div></div>';
    let min = opts.invert ? Math.min(...all) : 0;
    let max = Math.max(...all);
    if (max === min) max = min + 1;
    const n = dates.length;
    const x = (i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - R));
    const y = (v) => opts.invert ? T + ((v - min) / (max - min)) * (H - T - B) : H - B - ((v - min) / (max - min)) * (H - T - B);
    let svg = '';
    for (const t of [0, 0.5, 1]) {
      const v = min + (max - min) * t;
      const yy = y(v);
      svg += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/>';
      svg += '<text class="axis" x="' + (L - 4) + '" y="' + (yy + 3) + '" text-anchor="end">' + (Math.round(v * 10) / 10) + '</text>';
    }
    const ticks = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
    for (const i of ticks) svg += '<text class="axis" x="' + x(i) + '" y="' + (H - 4) + '" text-anchor="middle">' + fmtDay(dates[i]) + '</text>';
    for (const ev of opts.events ?? []) {
      const i = dates.indexOf(ev.date);
      if (i < 0) continue;
      svg += '<line x1="' + x(i) + '" x2="' + x(i) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--warn)" stroke-dasharray="2 2" opacity="0.7"><title>' + esc(ev.date + ' ' + ev.text) + '</title></line>';
    }
    for (const s of series) {
      if (s.kind === 'bar') {
        const bw = Math.max(1, (W - L - R) / n - 1);
        s.values.forEach((v, i) => { if (!v) return; svg += '<rect x="' + (x(i) - bw / 2) + '" y="' + y(v) + '" width="' + bw + '" height="' + (H - B - y(v)) + '" fill="' + s.color + '" opacity="0.75"><title>' + dates[i] + ' ' + v + '</title></rect>'; });
      } else {
        let d = '';
        s.values.forEach((v, i) => { if (v == null) return; d += (d && s.values[i - 1] != null ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); });
        svg += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="1.6"/>';
      }
    }
    const legend = series.map((s) => '<span class="sw" style="background:' + s.color + '"></span>' + s.name).join('');
    return '<div class="chart"><h4>' + title + '<span class="lg">' + legend + '</span></h4><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + svg + '</svg></div>';
  }

  // 商品数の推移（階段グラフ・全期間）
  function productChart(r) {
    const h = r.productHistory;
    if (!h.length) return '<div class="chart"><h4>商品数の推移</h4><div class="na">履歴なし</div></div>';
    const start = h[0][0];
    const end = new Date().toISOString().slice(0, 10);
    const dates = [];
    for (let d = new Date(start + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
    let j = 0, cur = h[0][1];
    const values = dates.map((d) => { while (j < h.length && h[j][0] <= d) { cur = h[j][1]; j++; } return cur; });
    const evs = r.events.filter((e) => ['hold', 'improve', 'delete'].includes(e.kind));
    return chart('商品数の推移（全期間・git 履歴）', dates, [{ name: '商品数', values, color: 'var(--c-prod)' }], { events: evs });
  }

  function detail(r) {
    const evs = r.events.filter((e) => ['hold', 'improve', 'products', 'delete', 'noindex', 'publish', 'index', 'commit'].includes(e.kind));
    const kindLabel = { hold: '測定施策', improve: '加筆', products: '商品数', delete: '商品削除', noindex: 'noindex', publish: '公開', index: '登録依頼', commit: 'コミット' };
    const markers = r.events.filter((e) => ['hold', 'improve', 'delete', 'noindex', 'index'].includes(e.kind));
    const facts = [
      ['カテゴリ', r.category], ['種別', r.articleType], ['frontmatter 更新日', r.updatedAt],
      ['前28日 クリック/表示', r.clicksPrev + ' / ' + r.impressionsPrev], ['前28日 順位', r.positionPrev ?? '—'],
      ['Bing 表示', r.bingImpressions ?? '—'], ['送客内訳', Object.entries(r.providers).map(([k, v]) => k + ' ' + v).join(' / ') || '—'],
    ];
    return '<div class="detail-inner"><div class="facts">' + facts.map(([k, v]) => '<span>' + k + ' <b>' + esc(v) + '</b></span>').join('') + '</div>'
      + '<div class="charts">'
      + chart('GA4 PV・送客 / 日', meta.ga4Dates, [{ name: 'PV', values: r.ga4Daily.map((d) => d[0]), color: 'var(--c-pv)' }, { name: '送客', values: r.ga4Daily.map((d) => d[2]), color: 'var(--c-out)', kind: 'bar' }], { events: markers })
      + chart('GSC クリック / 日', meta.dates, [{ name: 'クリック', values: r.gscDaily.map((d) => d[0]), color: 'var(--c-click)', kind: 'bar' }], { events: markers })
      + chart('GSC 表示 / 日', meta.dates, [{ name: '表示', values: r.gscDaily.map((d) => d[1]), color: 'var(--c-impr)' }], { events: markers })
      + chart('GSC 掲載順位 / 日（上ほど良い）', meta.dates, [{ name: '順位', values: r.gscDaily.map((d) => d[2]), color: 'var(--c-pos)' }], { events: markers, invert: true })
      + productChart(r)
      + '</div>'
      + '<div class="events">' + (evs.length ? evs.map((e) => '<div><span>' + e.date + '</span><span class="k k-' + e.kind + '">' + kindLabel[e.kind] + '</span><span>' + esc(e.text) + '</span></div>').join('') : '<div class="na">記録なし</div>') + '</div></div>';
  }

  function filtered() {
    const q = $('q').value.trim().toLowerCase();
    const type = $('type').value;
    return rows.filter((r) => {
      if ($('onlyHold').checked && !r.hold) return false;
      if ($('hideNoindex').checked && r.noindex) return false;
      if (type && r.articleType !== type) return false;
      if (q && ![r.title, r.id, r.category, r.topQuery].some((s) => String(s ?? '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function render() {
    const list = filtered().sort((a, b) => {
      const va = sortValue(a), vb = sortValue(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // 欠損は常に末尾
      if (vb == null) return -1;
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ja');
      return sortDir === 'asc' ? c : -c;
    });
    document.querySelectorAll('th').forEach((th) => { th.dataset.dir = th.dataset.key === sortKey ? sortDir : ''; });
    $('count').textContent = list.length + ' / ' + rows.length + ' 記事';
    $('tbody').innerHTML = list.map((r) => {
      const tr = '<tr class="row' + (open.has(r.id) ? ' open' : '') + '" data-id="' + esc(r.id) + '">' + cols.map((c) => '<td class="' + (c.cls ?? '') + '">' + c.html(r) + '</td>').join('') + '</tr>';
      return open.has(r.id) ? tr + '<tr class="detail"><td colspan="' + cols.length + '">' + detail(r) + '</td></tr>' : tr;
    }).join('');
  }

  $('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.row');
    if (!tr) return;
    const id = tr.dataset.id;
    open.has(id) ? open.delete(id) : open.add(id);
    render();
  });
  for (const id of ['q', 'type', 'onlyHold', 'hideNoindex', 'sparkMetric']) $(id).addEventListener('input', render);
  render();
})();
</script>
</body>
</html>
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
