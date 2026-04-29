/**
 * 楽天検索ページから実際の商品データを取得して、記事のフロントマターを更新するスクリプト
 * APIキー不要。楽天の公開検索ページから JSON-LD 構造化データを取得する。
 *
 * 使い方:
 *   node scripts/update-products.mjs
 *   node scripts/update-products.mjs --dry-run  # ファイルを書き換えず結果だけ表示
 *
 * 更新対象フィールド: price / rating / reviewCount / rakutenUrl / imageUrl
 * バックアップ: 実行前に <ファイル名>.bak を自動作成
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join, basename } from 'path';

const DRY_RUN = process.argv.includes('--dry-run');

// ─── .env を手動パース ───────────────────────────────────────────────────────
function loadEnv() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    console.error('❌ .env ファイルが見つかりません。.env.example をコピーして .env を作成してください。');
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

const env = loadEnv();
const AFFILIATE_ID = env.PUBLIC_RAKUTEN_AFFILIATE_ID;

if (!AFFILIATE_ID || AFFILIATE_ID === 'your_affiliate_id_here') {
  console.error('❌ PUBLIC_RAKUTEN_AFFILIATE_ID が .env に設定されていません');
  process.exit(1);
}

// ─── フロントマターから products 配列の name を抽出 ─────────────────────────
function extractProductNames(content) {
  // --- と --- の間のフロントマター部分を取得
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];

  const names = [];
  const nameRe = /^    name:\s*"(.+)"$/gm;
  let m;
  while ((m = nameRe.exec(match[1])) !== null) {
    names.push(m[1]);
  }
  return names;
}

// ─── 楽天検索ページから JSON-LD を取得 ─────────────────────────────────────
async function fetchRakutenSearch(keyword) {
  const encodedKeyword = encodeURIComponent(keyword);
  const url = `https://search.rakuten.co.jp/search/mall/${encodedKeyword}/`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // JSON-LD の ItemList ブロックを抽出
  const ldMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?ItemList[\s\S]*?)<\/script>/);
  if (!ldMatch) throw new Error('JSON-LD ItemList が見つかりませんでした');

  const jsonld = JSON.parse(ldMatch[1]);
  if (!jsonld.itemListElement || jsonld.itemListElement.length === 0) {
    throw new Error('検索結果が空です');
  }

  // 1件目の商品データを取得
  const first = jsonld.itemListElement[0].item;
  const itemUrl = first.url.split('?')[0];

  // 商品画像URLを取得（楽天の画像URLを標準形式に変換）
  const rawImageUrl = first.image ?? null;
  let imageUrl = rawImageUrl;
  if (imageUrl && imageUrl.includes('thumbnail.image.rakuten.co.jp')) {
    // サムネイルURLから直接画像URLに変換
    const pcMatch = imageUrl.match(/[?&]pc=([^&]+)/);
    if (pcMatch) imageUrl = decodeURIComponent(pcMatch[1]);
  }

  // アフィリエイトURLを生成
  const affiliateUrl = `https://hb.afl.rakuten.co.jp/hgc/${AFFILIATE_ID}/?pc=${encodeURIComponent(itemUrl)}&link_type=picttext`;

  return {
    name: first.name,
    price: first.offers?.price ? Number(first.offers.price) : null,
    rating: first.aggregateRating?.ratingValue ? Number(first.aggregateRating.ratingValue) : null,
    reviewCount: first.aggregateRating?.reviewCount ? Number(first.aggregateRating.reviewCount) : null,
    itemUrl,
    imageUrl,
    affiliateUrl,
  };
}

// ─── フロントマター内の特定商品ブロックを更新 ─────────────────────────────
function updateProductInFrontmatter(content, productName, updates) {
  // フロントマター全体を取得
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return content;

  const prefix = fmMatch[1];
  let fm = fmMatch[2];
  const suffix = fmMatch[3];
  const rest = content.slice(prefix.length + fm.length + suffix.length);

  // 商品ブロックを name フィールドで特定
  // 各 product ブロックは "  - rank:" で始まる
  const namePattern = `    name: "${productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`;
  const nameIdx = fm.indexOf(`    name: "${productName}"`);
  if (nameIdx === -1) {
    console.warn(`    ⚠ 商品名が見つかりません: ${productName.slice(0, 40)}`);
    return content;
  }

  // この name フィールドが属するブロックの開始位置（直前の "  - rank:"）を探す
  const blockStart = fm.lastIndexOf('  - rank:', nameIdx);
  if (blockStart === -1) return content;

  // ブロックの終端を探す（次の "  - rank:" または products: 配列の終わり）
  const nextBlockIdx = fm.indexOf('  - rank:', blockStart + 1);
  const blockEnd = nextBlockIdx === -1 ? fm.length : nextBlockIdx;

  let block = fm.slice(blockStart, blockEnd);

  // 各フィールドを更新（値が取得できた場合のみ）
  if (updates.price !== null) {
    block = block.replace(/^    price: .+$/m, `    price: ${updates.price}`);
  }
  if (updates.rating !== null) {
    block = block.replace(/^    rating: .+$/m, `    rating: ${updates.rating}`);
    // rating がない場合は追加しない（スキーマは optional）
  }
  if (updates.reviewCount !== null) {
    block = block.replace(/^    reviewCount: .+$/m, `    reviewCount: ${updates.reviewCount}`);
  }
  if (updates.affiliateUrl) {
    block = block.replace(/^    rakutenUrl: ".+"$/m, `    rakutenUrl: "${updates.affiliateUrl}"`);
  }
  if (updates.imageUrl) {
    block = block.replace(/^    imageUrl: ".+"$/m, `    imageUrl: "${updates.imageUrl}"`);
  }

  fm = fm.slice(0, blockStart) + block + fm.slice(blockEnd);
  return prefix + fm + suffix + rest;
}

// ─── メイン処理 ────────────────────────────────────────────────────────────
async function main() {
  const articlesDir = resolve(process.cwd(), 'src/content/articles');
  const files = readdirSync(articlesDir).filter(f => f.endsWith('.md'));

  console.log(`📂 対象ファイル: ${files.length}件\n`);
  if (DRY_RUN) console.log('⚠ --dry-run モード: ファイルは書き換えません\n');

  let totalSuccess = 0;
  let totalFail = 0;

  for (const file of files) {
    const filePath = join(articlesDir, file);
    const content = readFileSync(filePath, 'utf-8');
    const productNames = extractProductNames(content);

    console.log(`\n📄 ${file} (${productNames.length}商品)`);

    if (productNames.length === 0) {
      console.log('   → 商品なし。スキップ');
      continue;
    }

    let updatedContent = content;
    const results = [];

    for (const name of productNames) {
      const shortName = name.slice(0, 45);
      process.stdout.write(`   [${shortName}...] `);
      try {
        const data = await fetchRakutenSearch(name);
        updatedContent = updateProductInFrontmatter(updatedContent, name, {
          price: data.price,
          rating: data.rating,
          reviewCount: data.reviewCount,
          affiliateUrl: data.affiliateUrl,
          imageUrl: data.imageUrl,
        });
        results.push({ success: true, name: data.name.slice(0, 40), price: data.price, rating: data.rating, reviewCount: data.reviewCount });
        console.log(`✅ ¥${data.price?.toLocaleString()} 評価${data.rating}(${data.reviewCount?.toLocaleString()}件)`);
        totalSuccess++;
      } catch (e) {
        console.log(`❌ ${e.message}`);
        results.push({ success: false, name: shortName, reason: e.message });
        totalFail++;
      }
      // サーバー負荷軽減のため間隔を空ける
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!DRY_RUN && updatedContent !== content) {
      // バックアップ作成
      writeFileSync(filePath + '.bak', content, 'utf-8');
      // ファイル更新
      writeFileSync(filePath, updatedContent, 'utf-8');
      console.log(`   💾 更新完了（バックアップ: ${basename(filePath)}.bak）`);
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`✅ 成功: ${totalSuccess}件  ❌ 失敗: ${totalFail}件`);
  if (!DRY_RUN && totalSuccess > 0) {
    console.log('各ファイルの .bak でいつでも元に戻せます。');
  }
}

main().catch(err => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
