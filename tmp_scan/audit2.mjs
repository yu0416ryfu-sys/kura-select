import fs from 'node:fs';
import path from 'node:path';
import { isSalesQuantityVariantItemName, isMultiMeasureVariantItemName, buildSearchKeyword } from '../scripts/lib/frontmatter.ts';
import { extractCapacityTotal } from '../src/lib/capacity.ts';
import { buildItemCodeKeywords } from '../scripts/lib/rakuten-url.ts';
import { stripCapacityForKeyword } from '../scripts/lib/product-match-keywords.ts';

const env = {};
for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
  const t = l.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const EP = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401';
const H = {
  accessKey: env.RAKUTEN_ACCESS_KEY,
  Origin: 'https://yu0416ryfu-sys.github.io',
  Referer: 'https://yu0416ryfu-sys.github.io/',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const products = [];
function collect(fp, name) {
  const s = fs.readFileSync(fp, 'utf8');
  for (const b of s.split('\n---')[0].split(/^  - rank: /m).slice(1)) {
    const g = (k) => {
      const m = b.match(new RegExp('^    ' + k + ': "?(.*?)"?$', 'm'));
      return m ? m[1] : null;
    };
    const url = g('rakutenUrl');
    if (!url) continue;
    const m = decodeURIComponent(url).match(/item\.rakuten\.co\.jp\/([^/]+)\/([^/?&]+)/);
    if (!m) continue;
    products.push({
      file: name,
      rank: b.split('\n')[0].trim(),
      name: g('name'),
      price: Number(g('price')),
      capacity: g('capacity'),
      shop: m[1],
      item: m[2],
    });
  }
}
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, e.name);
    if (e.isDirectory()) walk(fp);
    else if (e.name.endsWith('.md')) collect(fp, e.name);
  }
})('src/content/articles');
console.error('商品数', products.length);

async function search({ keyword, shopCode, hits = 30, sort = 'standard' }) {
  const params = new URLSearchParams({
    applicationId: env.RAKUTEN_APPLICATION_ID,
    affiliateId: env.PUBLIC_RAKUTEN_AFFILIATE_ID,
    keyword,
    hits: String(hits),
    sort,
    formatVersion: '2',
  });
  if (shopCode) params.set('shopCode', shopCode);
  try {
    const r = await fetch(EP + '?' + params, { headers: H });
    if (r.status === 429) {
      await sleep(5000);
      return [];
    }
    if (!r.ok) return [];
    return (await r.json()).Items || [];
  } catch {
    return [];
  } finally {
    await sleep(900);
  }
}

function captionTotals(caption, unit) {
  const out = new Set();
  const u = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of caption.matchAll(new RegExp(`(\\d[\\d,]*)\\s*${u}\\s*[×xX*]\\s*(\\d[\\d,]*)\\s*(?:個|袋|パック|箱|本|セット|P|ロール)`, 'gi'))) {
    out.add(parseInt(m[1].replace(/,/g, ''), 10) * parseInt(m[2].replace(/,/g, ''), 10));
  }
  for (const m of caption.matchAll(new RegExp(`(?:入数|内容量|枚数|総枚数)[^\\d]{0,12}(\\d[\\d,]*)\\s*${u}`, 'gi'))) {
    out.add(parseInt(m[1].replace(/,/g, ''), 10));
  }
  return [...out].filter((n) => Number.isFinite(n) && n > 0);
}

const results = [];
let done = 0;
let miss = 0;
for (const p of products) {
  const matches = (raw) => {
    if (!raw) return false;
    const d = decodeURIComponent(raw);
    return d.includes(`/${p.shop}/${p.item}/`) || d.endsWith(`/${p.shop}/${p.item}`);
  };
  const nameKw = buildSearchKeyword(p.name || '').slice(0, 60);
  const stripped = stripCapacityForKeyword(p.name || '').slice(0, 40);
  const brand = buildSearchKeyword(p.name || '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  const strategies = [
    { label: '基本', keyword: nameKw, shopCode: p.shop, hits: 10, sort: '-reviewCount' },
    ...(stripped.length >= 2 ? [{ label: 'A', keyword: stripped, shopCode: p.shop, sort: '-reviewCount' }] : []),
    ...(brand.length >= 2 && brand !== stripped ? [{ label: 'B', keyword: brand, shopCode: p.shop }] : []),
    ...(brand.length >= 2 ? [{ label: 'C', keyword: brand, shopCode: null }] : []),
    ...buildItemCodeKeywords(p.item).flatMap((code) => [
      { label: 'D', keyword: code, shopCode: p.shop },
      { label: 'D', keyword: code, shopCode: null },
    ]),
  ];

  let hit = null;
  let via = null;
  for (const st of strategies) {
    if (!st.keyword) continue;
    const items = await search(st);
    hit = items.find((i) => matches(i.itemUrl) || matches(i.affiliateUrl));
    if (hit) {
      via = st.label;
      break;
    }
  }
  done++;
  if (done % 50 === 0) console.error(' ...', done, '/', products.length, 'miss', miss);
  if (!hit) {
    miss++;
    results.push({ ...p, matched: false });
    continue;
  }

  const flags = [];
  if (hit.itemPriceMax1 && hit.itemPriceMin1 && hit.itemPriceMax1 !== hit.itemPriceMin1) {
    flags.push(`価格帯商品 ${hit.itemPriceMin1}〜${hit.itemPriceMax1}円`);
  }
  if (isSalesQuantityVariantItemName(hit.itemName)) flags.push('組数選択型（商品名）');
  if (isMultiMeasureVariantItemName(hit.itemName)) flags.push('容量選択型（商品名）');
  if (typeof hit.itemPrice === 'number' && p.price && Math.abs(hit.itemPrice - p.price) / p.price > 0.05) {
    flags.push(`価格乖離 記事${p.price}円 / API${hit.itemPrice}円`);
  }
  const t = extractCapacityTotal(p.capacity || '');
  if (t) {
    const cands = captionTotals(hit.itemCaption || '', t.unit);
    if (cands.length) {
      const exact = cands.some((c) => Math.abs(c - t.total) / t.total < 0.02);
      const larger = cands.filter((c) => c > t.total * 1.5);
      const smaller = cands.filter((c) => c < t.total / 1.5);
      if (!exact && larger.length) flags.push(`容量過少疑い 記事${t.total}${t.unit} / 説明文${larger.join(',')}${t.unit}`);
      else if (!exact && smaller.length) flags.push(`容量過大疑い 記事${t.total}${t.unit} / 説明文${smaller.join(',')}${t.unit}`);
    }
  }
  results.push({
    ...p,
    matched: true,
    via,
    apiName: hit.itemName,
    apiPrice: hit.itemPrice ?? null,
    priceMin: hit.itemPriceMin1 ?? null,
    priceMax: hit.itemPriceMax1 ?? null,
    flags,
  });
}
console.error('完了 done', done, 'miss', miss);
fs.writeFileSync('tmp_scan/audit2.json', JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 1));
