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

// ─── フロントマターから products 配列の name を抽出 ─────────────────────────
function extractProductNames(content) {
  // --- と --- の間のフロントマター部分を取得（CRLF/LF両対応）
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [];

  const names = [];
  // CRLF環境では行末に \r が残るため \r? を付与
  const nameRe = /^    name:\s*"(.+?)"\r?$/gm;
  let m;
  while ((m = nameRe.exec(match[1])) !== null) {
    names.push(m[1]);
  }
  return names;
}

// ─── 楽天商品検索APIで商品データを取得 ───────────────────────────────────
const RAKUTEN_API_ENDPOINT = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';

// 商品名から検索キーワードを生成（長すぎると0件になるため短縮）
function buildSearchKeyword(productName) {
  // 容量・数量の詳細情報を除去してコアな商品名に絞る
  let kw = productName
    .replace(/\s*[（(].+?[）)]/g, '')           // 括弧内を除去
    .replace(/\s*\d+[mMlLgG枚本袋個入パック巻]+.*$/g, '') // 容量・数量以降を除去
    .replace(/\s*(×|x|X)\s*\d+.*$/g, '')        // ×N以降を除去
    .replace(/\s*(大容量|超大型|超特大|特大|大型|レギュラー|ミニ)/g, '') // サイズ表現を除去
    .trim();

  // それでも長すぎる場合は先頭40文字に切り詰め
  if (kw.length > 40) {
    kw = kw.slice(0, 40);
  }

  // 短すぎる場合は元の名前の先頭30文字を使用
  if (kw.length < 3) {
    kw = productName.slice(0, 30);
  }

  return kw;
}

async function fetchRakutenSearch(keyword) {
  const searchKeyword = buildSearchKeyword(keyword);

  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    affiliateId: AFFILIATE_ID,
    keyword: searchKeyword,
    hits: '3',           // 上位3件を取得（最も近い商品を選ぶため）
    imageFlag: '1',      // 画像付き商品のみ
    formatVersion: '2',  // 改善版レスポンス形式
    elements: [
      'itemName', 'itemPrice', 'itemUrl', 'affiliateUrl',
      'mediumImageUrls', 'reviewCount', 'reviewAverage',
    ].join(','),
  });

  const url = `${RAKUTEN_API_ENDPOINT}?${params}`;
  const res = await fetch(url, {
    headers: {
      'accessKey': ACCESS_KEY,
      'Origin': 'https://yu0416ryfu-sys.github.io',
      'Referer': 'https://yu0416ryfu-sys.github.io/',
    },
  });

  if (res.status === 429) {
    throw new Error('APIリクエスト制限超過。しばらく待ってから再試行してください');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  if (!data.Items || data.Items.length === 0) {
    throw new Error('検索結果が0件です');
  }

  // 1件目の商品データを使用
  const item = data.Items[0];

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

// ─── フロントマター内の特定商品ブロックを更新 ─────────────────────────────
function updateProductInFrontmatter(content, productName, updates) {
  // フロントマター全体を取得
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
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
      // APIレート制限対策（1秒間隔）
      await new Promise(r => setTimeout(r, 1000));
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
