/**
 * 楽天商品検索APIを使って商品データを取得し、記事のフロントマターを更新するスクリプト
 *
 * 必要な環境変数（.env に設定）:
 *   RAKUTEN_APPLICATION_ID  — 楽天 Web Service アプリID
 *   RAKUTEN_ACCESS_KEY      — 楽天 Web Service アクセスキー
 *   PUBLIC_RAKUTEN_AFFILIATE_ID — 楽天アフィリエイトID（アフィリエイトURL生成用）
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
import { extractProductNames, buildSearchKeyword, updateProductInFrontmatter, extractProductCapacity, extractCapacityTotal, calcPricePerUnit } from './lib/frontmatter.ts';

const DRY_RUN = process.argv.includes('--dry-run');

// ─── 環境変数を読み込み（.env またはプロセス環境変数） ─────────────────────────
function loadEnv() {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    // ローカル開発: .env ファイルからパース
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
  // CI環境: process.env から読み込み
  console.log('ℹ .env ファイルが見つかりません。プロセス環境変数を使用します。');
  return process.env;
}

const env = loadEnv();
const APPLICATION_ID = env.RAKUTEN_APPLICATION_ID;
const ACCESS_KEY = env.RAKUTEN_ACCESS_KEY;
const AFFILIATE_ID = env.PUBLIC_RAKUTEN_AFFILIATE_ID;

if (!APPLICATION_ID) {
  console.error('❌ RAKUTEN_APPLICATION_ID が .env に設定されていません');
  process.exit(1);
}
if (!ACCESS_KEY) {
  console.error('❌ RAKUTEN_ACCESS_KEY が .env に設定されていません');
  process.exit(1);
}
if (!AFFILIATE_ID || AFFILIATE_ID === 'your_affiliate_id_here') {
  console.error('❌ PUBLIC_RAKUTEN_AFFILIATE_ID が .env に設定されていません');
  process.exit(1);
}

// ─── 楽天商品検索APIで商品データを取得 ───────────────────────────────────
const RAKUTEN_API_ENDPOINT = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';

async function fetchRakutenSearch(keyword) {
  const searchKeyword = buildSearchKeyword(keyword);

  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    affiliateId: AFFILIATE_ID,
    keyword: searchKeyword,
    hits: '10',          // ふるさと納税・高額セット除外のため多めに取得
    imageFlag: '1',      // 画像付き商品のみ
    sort: '-reviewCount', // レビュー件数の多い順（人気順）
    formatVersion: '2',  // 改善版レスポンス形式
    elements: [
      'itemName', 'itemPrice', 'itemUrl', 'affiliateUrl',
      'mediumImageUrls', 'reviewCount', 'reviewAverage',
      'shopName', 'shopUrl',
    ].join(','),
  });

  const url = `${RAKUTEN_API_ENDPOINT}?${params}`;
  let res = await fetch(url, {
    headers: {
      'accessKey': ACCESS_KEY,
      'Origin': 'https://yu0416ryfu-sys.github.io',
      'Referer': 'https://yu0416ryfu-sys.github.io/',
    },
  });

  if (res.status === 429) {
    // レート制限: 5秒待ってリトライ
    await new Promise(r => setTimeout(r, 5000));
    const res2 = await fetch(url, {
      headers: {
        'accessKey': ACCESS_KEY,
        'Origin': 'https://yu0416ryfu-sys.github.io',
        'Referer': 'https://yu0416ryfu-sys.github.io/',
      },
    });
    if (!res2.ok) {
      const body = await res2.text();
      throw new Error(`APIリクエスト制限超過（リトライ後も失敗: ${res2.status}）`);
    }
    res = res2;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  if (!data.Items || data.Items.length === 0) {
    throw new Error('検索結果が0件です');
  }

  // ふるさと納税・異常価格の商品を除外
  const filtered = data.Items.filter(item => {
    const url = item.itemUrl || item.affiliateUrl || '';
    const name = (item.itemName || '').toLowerCase();
    const shopUrl = item.shopUrl || '';
    // ふるさと納税ショップURLパターン: f{数字}-{自治体名}
    if (/\/f\d{4,}-[a-z]/.test(shopUrl) || /\/f\d{4,}-[a-z]/.test(url)) return false;
    // 商品名やショップ名にふるさと納税関連ワード
    if (/ふるさと納税|ふるさと|寄付|寄附|返礼品/.test(item.itemName || '')) return false;
    if (/ふるさと納税|furusato/.test(item.shopName || '')) return false;
    return true;
  });

  if (filtered.length === 0) {
    throw new Error('通常商品が見つかりません（ふるさと納税のみ）');
  }

  // フィルタ後の1件目を使用
  const item = filtered[0];

  // 画像URLを取得（128px角のサムネイル）
  const imageUrl = item.mediumImageUrls?.[0] ?? null;

  return {
    name: item.itemName,
    price: item.itemPrice ?? null,
    rating: item.reviewAverage ? Number(item.reviewAverage) : null,
    reviewCount: item.reviewCount ? Number(item.reviewCount) : null,
    itemUrl: item.itemUrl,
    imageUrl,
    affiliateUrl: item.affiliateUrl ?? null,
  };
}

// ─── 容量差異の警告 ────────────────────────────────────────────────────────
// 楽天の itemName 内の括弧表記（例: 「210枚」）と記事の capacity を比較し、
// 5%超の差異があれば警告を出す
function warnIfCapacityMismatch(articleCapacity, rakutenItemName) {
  const rakutenRe = new RegExp(`[（(]([\\d,]+)\\s*(mL|ml|kg|L|g|m|枚|本|個|袋|巻|回|粒)[）)]`);
  const rakutenM = rakutenItemName.match(rakutenRe);
  if (!rakutenM) return;

  const rakutenTotal = parseInt(rakutenM[1].replace(/,/g, ''), 10);
  const articleExtracted = extractCapacityTotal(articleCapacity);
  if (!articleExtracted) return;

  const diff = Math.abs(rakutenTotal - articleExtracted.total) / articleExtracted.total;
  if (diff > 0.05) {
    console.log(`  ⚠ 容量の差異を検出`);
    console.log(`    記事の capacity: "${articleCapacity}"（${articleExtracted.total}${articleExtracted.unit}）`);
    console.log(`    楽天の情報: ${rakutenTotal}${rakutenM[2]}（${rakutenItemName.slice(0, 70)}）`);
    console.log(`    → capacity と pricePerUnit を手動で確認してください`);
  }
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

        // capacity を読み取り pricePerUnit を再計算
        const capacity = extractProductCapacity(updatedContent, name);
        const newPricePerUnit = (capacity && data.price !== null)
          ? calcPricePerUnit(data.price, capacity)
          : null;

        // 楽天 itemName と記事 capacity を比較して差異を警告
        if (capacity) warnIfCapacityMismatch(capacity, data.name);

        updatedContent = updateProductInFrontmatter(updatedContent, name, {
          price: data.price,
          rating: data.rating,
          reviewCount: data.reviewCount,
          affiliateUrl: data.affiliateUrl,
          imageUrl: data.imageUrl,
          pricePerUnit: newPricePerUnit,
        });
        results.push({ success: true, name: data.name.slice(0, 40), price: data.price, rating: data.rating, reviewCount: data.reviewCount });
        const ppuSuffix = newPricePerUnit ? ` → ${newPricePerUnit}` : '';
        console.log(`✅ ¥${data.price?.toLocaleString()} 評価${data.rating}(${data.reviewCount?.toLocaleString()}件)${ppuSuffix}`);
        totalSuccess++;
      } catch (e) {
        console.log(`❌ ${e.message}`);
        results.push({ success: false, name: shortName, reason: e.message });
        totalFail++;
      }
      // APIレート制限対策（2秒間隔）
      await new Promise(r => setTimeout(r, 2000));
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
