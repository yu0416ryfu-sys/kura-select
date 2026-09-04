// 全記事の「1位商品」を楽天APIで実地照合する監査 CLI（読み取り専用・記事mdは書き換えない）
//
// 確認項目:
//   1. リンク先が生きているか（アフィリエイトURLの shopCode/itemCode で実商品を引けるか）
//   2. 記事の商品名と実出品名が同じ商品を指しているか
//   3. price が楽天の現在価格と一致しているか
//   4. capacity（数量）が実出品名から読み取れる容量と一致しているか
//   5. その商品が記事のカテゴリ検索ルールに適合するか（本番と同じ stage1/2/4 ガード）
//
// 使い方: node --experimental-strip-types scripts/audit-rank1.mjs [--rank=2] [--slug=a,b]
//   --rank は監査対象の順位（既定 1）。出力は reports/rank1-audit/rank<N>-audit-<実行日>.json
// 出力:   reports/rank1-audit/rank1-audit-<実行日>.json / .md
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractAllProductsData,
  extractProductSnapshotByRank,
  extractArticleTitle,
  extractArticleCategory,
  extractArticleType,
  isProductManagedArticle,
  buildSearchKeyword,
  extractCapacityFromItemName,
  extractCapacityTotal,
} from './lib/frontmatter.ts';
import { parseRakutenItemUrl, buildItemCodeKeywords } from './lib/rakuten-url.ts';
import { isLikelySameProductName } from './lib/product-name-match.ts';
import { judgeArticle, KNOWN_ITEM_METHOD } from './lib/category-fit.ts';
import { toSlug } from './lib/item-names.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTICLES_DIR = path.join(ROOT, 'src/content/articles');

function loadEnv() {
  const p = path.join(ROOT, '.env');
  const env = { ...process.env };
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  }
  return env;
}

const env = loadEnv();
const APPLICATION_ID = env.RAKUTEN_APPLICATION_ID;
const ACCESS_KEY = env.RAKUTEN_ACCESS_KEY;
const AFFILIATE_ID = env.PUBLIC_RAKUTEN_AFFILIATE_ID ?? '';
if (!APPLICATION_ID || !ACCESS_KEY) {
  console.error('RAKUTEN_APPLICATION_ID / RAKUTEN_ACCESS_KEY が未設定です');
  process.exit(1);
}

const ENDPOINT = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401';
const HEADERS = {
  accessKey: ACCESS_KEY,
  Origin: 'https://yu0416ryfu-sys.github.io',
  Referer: 'https://yu0416ryfu-sys.github.io/',
};
const ELEMENTS = 'itemName,itemPrice,itemUrl,affiliateUrl,reviewCount,reviewAverage,shopName,shopUrl';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
async function api(params) {
  const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
  if (wait) await sleep(wait);
  lastRequestAt = Date.now();
  const url = ENDPOINT + '?' + new URLSearchParams(params);
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  } catch {
    return null;
  }
  if (res.status === 429) {
    await sleep(5000);
    try {
      res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    } catch {
      return null;
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('  API ' + res.status + ' ' + body.replace(/\s+/g, ' ').slice(0, 120));
    return null;
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function makeMatcher(shopCode, itemCode) {
  return (raw) => {
    if (!raw) return false;
    const decoded = decodeURIComponent(raw);
    return decoded.includes('/' + shopCode + '/' + itemCode + '/') || decoded.endsWith('/' + shopCode + '/' + itemCode);
  };
}

/** update-products の fetchRakutenItem と同じ戦略（商品名→固有語→管理番号）で実商品を引く */
async function fetchItem(shopCode, itemCode, productName) {
  const keyword = buildSearchKeyword(productName);
  const brand = keyword.split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  const strategies = [
    { keyword, hits: 30, sort: '-reviewCount' },
    ...(brand && brand !== keyword ? [{ keyword: brand, hits: 30, sort: 'standard' }] : []),
    ...buildItemCodeKeywords(itemCode).flatMap((code) => [
      { keyword: code, hits: 30, sort: 'standard' },
      { keyword: code, hits: 30, sort: 'standard', noShop: true },
    ]),
  ];
  const matches = makeMatcher(shopCode, itemCode);
  for (const s of strategies) {
    const data = await api({
      applicationId: APPLICATION_ID,
      affiliateId: AFFILIATE_ID,
      ...(s.noShop ? {} : { shopCode }),
      keyword: s.keyword,
      hits: String(s.hits),
      sort: s.sort,
      formatVersion: '2',
      elements: ELEMENTS,
    });
    if (!data || !Array.isArray(data.Items) || data.Items.length === 0) continue;
    const target = data.Items.find((i) => matches(i.itemUrl) || matches(i.affiliateUrl));
    if (target) {
      return {
        name: target.itemName,
        price: target.itemPrice ?? null,
        reviewCount: target.reviewCount ?? null,
        rating: target.reviewAverage ? Number(target.reviewAverage) : null,
        shopName: target.shopName ?? null,
      };
    }
  }
  return null;
}

function listArticleFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listArticleFiles(full));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

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
  articles.push({ slug, relative, fileName: path.basename(file), title: extractArticleTitle(content) ?? '', category, content });
}
const TARGET_RANK = Number(process.argv.find((a) => a.startsWith('--rank='))?.split('=')[1] ?? 1);
if (!Number.isInteger(TARGET_RANK) || TARGET_RANK < 1) {
  console.error('--rank は1以上の整数で指定してください');
  process.exit(1);
}
const SLUG_FILTER = process.argv.find((a) => a.startsWith('--slug='))?.split('=').slice(1).join('=') ?? null;
if (SLUG_FILTER) {
  const wanted = new Set(SLUG_FILTER.split(','));
  for (let i = articles.length - 1; i >= 0; i--) if (!wanted.has(articles[i].slug)) articles.splice(i, 1);
}
console.error('対象記事: ' + articles.length + ' 本');

const results = [];
let n = 0;
for (const a of articles) {
  n++;
  const snap = extractProductSnapshotByRank(a.content, TARGET_RANK);
  const row = {
    slug: a.slug,
    category: a.category,
    title: a.title,
    rank: TARGET_RANK,
    // レポート側（audit-rank1-report.mjs）が読むキー名。rank を変えても互換のため名前は据え置く
    rank1Name: snap?.name ?? null,
    price: snap?.price ?? null,
    capacity: snap?.capacity ?? null,
    rakutenUrl: snap?.rakutenUrl ?? null,
  };
  if (!snap) {
    row.status = 'no-rank';
    results.push(row);
    console.error('[' + n + '/' + articles.length + '] ' + a.slug + ': ' + TARGET_RANK + '位商品なし');
    continue;
  }
  const ref = parseRakutenItemUrl(snap.rakutenUrl);
  if (!ref) {
    row.status = 'bad-url';
    results.push(row);
    console.error('[' + n + '/' + articles.length + '] ' + a.slug + ': URL解析不能');
    continue;
  }
  row.itemKey = ref.shopCode + '/' + ref.itemCode;
  const item = await fetchItem(ref.shopCode, ref.itemCode, snap.name);
  if (!item) {
    row.status = 'not-found';
    results.push(row);
    console.error('[' + n + '/' + articles.length + '] ' + a.slug + ': リンク先を取得できず');
    continue;
  }
  row.status = 'found';
  row.apiName = item.name;
  row.apiPrice = item.price;
  row.shopName = item.shopName;
  row.nameMatch = isLikelySameProductName(snap.name, item.name);
  row.nameMatchStrict = isLikelySameProductName(snap.name, item.name, { strict: true });
  row.priceDiff = snap.price != null && item.price != null ? item.price - snap.price : null;

  const apiCapacity = extractCapacityFromItemName(item.name);
  row.apiCapacity = apiCapacity;
  const articleTotal = snap.capacity ? extractCapacityTotal(snap.capacity) : null;
  const apiTotal = apiCapacity ? extractCapacityTotal(apiCapacity) : null;
  row.capacityVerdict = !articleTotal || !apiTotal
    ? 'unknown'
    : articleTotal.unit !== apiTotal.unit
      ? 'unit-diff'
      : Math.abs(articleTotal.total - apiTotal.total) < Math.max(0.01, articleTotal.total * 0.005)
        ? 'match'
        : 'mismatch';
  row.capacityTotals = { article: articleTotal, api: apiTotal };

  const fit = judgeArticle({
    slug: a.slug,
    articleFile: a.fileName,
    title: a.title,
    category: a.category,
    articlesInCategory: categoryCounts.get(a.category) ?? 1,
    products: extractAllProductsData(a.content).map((p) => {
      const s = p.rank != null ? extractProductSnapshotByRank(a.content, p.rank) : null;
      const isRank1 = p.rank === TARGET_RANK;
      return {
        slug: a.slug,
        articleFile: a.relative,
        rank: p.rank ?? null,
        currentName: p.name,
        itemName: isRank1 ? item.name : null,
        method: isRank1 ? KNOWN_ITEM_METHOD : null,
        price: isRank1 ? item.price : s?.price ?? null,
        rating: isRank1 ? item.rating : s?.rating ?? null,
        reviewCount: isRank1 ? item.reviewCount : s?.reviewCount ?? p.reviewCount ?? null,
      };
    }),
  });
  const f1 = fit.findings.find((f) => f.rank === TARGET_RANK);
  row.baseKeyword = fit.baseKeyword;
  row.ruleMissing = fit.ruleMissing;
  row.fitCode = f1?.code ?? null;
  row.fitSeverity = f1?.severity ?? null;
  row.fitReason = f1?.reason ?? null;

  results.push(row);
  console.error(
    '[' + n + '/' + articles.length + '] ' + a.slug +
    ': 名前' + (row.nameMatch ? '○' : '×') +
    ' 価格差' + (row.priceDiff === null ? '?' : row.priceDiff) +
    ' 容量' + row.capacityVerdict +
    ' 適合' + row.fitSeverity
  );
}

const outDir = path.join(ROOT, 'reports/rank1-audit');
mkdirSync(outDir, { recursive: true });
const today = new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
const jsonPath = path.join(outDir, 'rank' + TARGET_RANK + '-audit-' + today + '.json');
writeFileSync(jsonPath, JSON.stringify({ today, results }, null, 2), 'utf-8');
console.error('出力: ' + path.relative(ROOT, jsonPath));
