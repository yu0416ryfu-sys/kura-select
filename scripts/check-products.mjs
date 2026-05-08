/**
 * MDファイルの各商品を楽天APIで照合してCSVを生成
 * 方式: 商品名でキーワード検索 → itemUrlとrakutenUrlのshop/itemCodeを照合
 * 使い方: node scripts/check-products.mjs
 */

import { readFileSync, readdirSync, existsSync, createWriteStream } from 'fs';
import { resolve, join } from 'path';

function loadEnv() {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const env = {};
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return env;
  }
  return process.env;
}

const env = loadEnv();
const APPLICATION_ID = env.RAKUTEN_APPLICATION_ID;
const ACCESS_KEY = env.RAKUTEN_ACCESS_KEY;
const AFFILIATE_ID = env.PUBLIC_RAKUTEN_AFFILIATE_ID;

if (!APPLICATION_ID || !ACCESS_KEY) {
  console.error('RAKUTEN_APPLICATION_ID / RAKUTEN_ACCESS_KEY が未設定です');
  process.exit(1);
}

// URLから "shopCode:itemCode" を抽出
function extractCode(url) {
  let target = url;
  if (url.includes('hb.afl.rakuten.co.jp')) {
    try {
      const pc = new URL(url).searchParams.get('pc');
      if (pc) target = decodeURIComponent(pc);
    } catch {}
  }
  const m = target.match(/item\.rakuten\.co\.jp\/([^/]+)\/([^/?#]+)/);
  return m ? `${m[1]}:${m[2]}` : null;
}

// キーワード検索で全件取得し、URLが一致する商品を探す
async function fetchAndMatch(productName, targetCode) {
  const keyword = productName.slice(0, 60);
  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    affiliateId: AFFILIATE_ID,
    keyword,
    hits: '10',
    imageFlag: '1',
    formatVersion: '2',
    elements: 'itemName,itemPrice,itemUrl',
  });
  const url = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601?${params}`;
  const res = await fetch(url, {
    headers: { accessKey: ACCESS_KEY, Origin: 'https://www.kura-select.com', Referer: 'https://www.kura-select.com/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.Items?.length) throw new Error('0件');

  // URLで一致確認
  for (const item of data.Items) {
    const code = extractCode(item.itemUrl ?? '');
    if (code && code === targetCode) {
      return { name: item.itemName, price: item.itemPrice, matched: true };
    }
  }
  // 一致なし: 1件目を使用（価格参考値）
  const first = data.Items[0];
  return { name: first.itemName, price: first.itemPrice, matched: false };
}

// frontmatterから商品データを抽出（シンプルな正規表現解析）
function extractProducts(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const prodBlock = fm.match(/^products:\s*\n([\s\S]*)/m);
  if (!prodBlock) return [];

  const products = [];
  let cur = null;
  for (const line of prodBlock[1].split('\n')) {
    const rankM = line.match(/^\s{2}-\s+rank:\s+(\d+)/);
    if (rankM) {
      if (cur) products.push(cur);
      cur = { rank: parseInt(rankM[1]), name: '', price: '', capacity: '', rakutenUrl: '' };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s{4}(\w+):\s+"?(.+?)"?\s*$/);
    if (kv) cur[kv[1]] = kv[2].trim();
  }
  if (cur) products.push(cur);
  return products;
}

function esc(v) {
  const s = String(v ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  const articlesDir = resolve(process.cwd(), 'src/content/articles');
  const files = readdirSync(articlesDir).filter(f => f.endsWith('.md') && !f.endsWith('.bak'));
  const outPath = resolve(process.cwd(), 'rakuten-check.csv');
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  out.write('\uFEFF'); // BOM
  out.write('file,rank,name,price,capacity,rakutenUrl,楽天商品名,楽天価格,URL一致\n');

  let total = 0, ok = 0, urlMatch = 0, fail = 0;

  for (const file of files) {
    const content = readFileSync(join(articlesDir, file), 'utf-8');
    const products = extractProducts(content);
    if (!products.length) continue;
    console.log(`\n📄 ${file} (${products.length}件)`);

    for (const p of products) {
      total++;
      const targetCode = extractCode(p.rakutenUrl);
      let rName = '', rPrice = '', matched = '';

      if (!targetCode) {
        rName = 'URLエラー'; fail++;
      } else {
        try {
          const data = await fetchAndMatch(p.name, targetCode);
          rName = data.name;
          rPrice = data.price ?? '';
          matched = data.matched ? '○' : '△(別商品)';
          if (data.matched) { ok++; urlMatch++; } else ok++;
          console.log(`  ${data.matched ? '✅' : '⚠'} rank${p.rank} ¥${rPrice} ${matched}`);
        } catch (e) {
          rName = `ERROR: ${e.message}`; fail++;
          console.log(`  ❌ rank${p.rank} ${e.message}`);
        }
      }

      out.write([file, p.rank, p.name, p.price, p.capacity, p.rakutenUrl, rName, rPrice, matched].map(esc).join(',') + '\n');
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  out.end();
  console.log(`\n✅ 完了: ${ok}件成功(内URL完全一致:${urlMatch}件) / ${fail}件失敗 / 計${total}件`);
  console.log(`📄 ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });