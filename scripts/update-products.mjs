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
 *   node scripts/update-products.mjs --file=diaper*  # ワイルドカード指定
 *   node scripts/update-products.mjs --file=/^diaper-(newborn|tape)/  # 正規表現指定
 *
 * 更新対象フィールド: price / rating / reviewCount / rakutenUrl / imageUrl
 * バックアップ: 実行前に <ファイル名>.bak を自動作成
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, mkdirSync, renameSync } from 'fs';
import { resolve, join, basename, dirname } from 'path';
import { spawnSync } from 'child_process';
import { extractProductNames, buildSearchKeyword, updateProductInFrontmatter, extractProductSnapshot, extractProductCapacity, extractProductRakutenUrl, extractCapacityTotal, normalizeCapacityTotal, calcPricePerUnit, getArticleTargetUnit, extractCapacityFromItemName, analyzeCapacityFromItemName, isMultiMeasureVariantItemName, mergeExistingMeasureWithSalesQuantity, isSameMeasureBaseWithExistingQuantity, isSalesQuantityCapacity, hasMeasureCapacity, isLikelySalesQuantityCapacityMisread, removeProductFromFrontmatter, reorderProductsByPricePerUnit, limitProductsByRank, syncTitleProductCount, updateUpdatedAt, fixNameCapacityConflicts, extractAllProductsData, extractArticleTitle, extractArticleCategory, buildArticleSearchKeyword } from './lib/frontmatter.ts';
import { markProviderOffersForReview } from './lib/yahoo-offers.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const CHECK_REPLACEMENTS = process.argv.includes('--check-replacements');
const CHECK_ADDITIONS = process.argv.includes('--check-additions');
const FILE_FILTER = process.argv.find(a => a.startsWith('--file='))?.split('=')[1] ?? null;
const THRESHOLD = parseFloat(process.argv.find(a => a.startsWith('--threshold='))?.split('=')[1] ?? '2');
const TARGET_COUNT = parseInt(process.argv.find(a => a.startsWith('--target='))?.split('=')[1] ?? '15');
const CHECK_TARGET_COUNT = (() => {
  const raw = process.argv.find(a => a.startsWith('--check-target-count='))?.split('=')[1];
  if (raw == null) return null;
  if (!/^\d+$/.test(raw)) {
    console.error(`❌ --check-target-count の値が不正です: "${raw}"（0以上の整数を指定してください）`);
    process.exit(1);
  }
  return parseInt(raw, 10);
})();
const CONCURRENCY = parsePositiveIntArg('--concurrency=', 6, { min: 1, max: 8 });
const API_INTERVAL_MS = parsePositiveIntArg('--api-interval=', 1000, { min: 0, max: 10000 });

function normalizeArticleFileName(value) {
  return basename(String(value ?? '').replace(/\\/g, '/')).trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  let source = '';
  for (const ch of glob) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += escapeRegExp(ch);
  }
  return new RegExp(`^${source}$`);
}

function parseSlashRegExp(value) {
  const match = String(value).match(/^\/(.+)\/([dgimsuvy]*)$/);
  if (!match) return null;
  return new RegExp(match[1], match[2]);
}

function matchesFileFilter(file, rawFilter = FILE_FILTER) {
  if (!rawFilter) return true;

  const filter = normalizeArticleFileName(rawFilter);
  const fileName = normalizeArticleFileName(file);
  const fileStem = fileName.replace(/\.md$/, '');
  const filterStem = filter.replace(/\.md$/, '');

  const slashRegex = parseSlashRegExp(rawFilter);
  if (slashRegex) return slashRegex.test(fileName) || slashRegex.test(fileStem);

  if (/[*?]/.test(filter)) {
    const re = globToRegExp(filter);
    return re.test(fileName) || re.test(fileStem);
  }

  return fileName === filter || fileStem === filterStem;
}

function parsePositiveIntArg(prefix, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.argv.find(a => a.startsWith(prefix))?.split('=')[1];
  const parsed = raw == null ? fallback : parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatLogValue(value, type = 'text') {
  if (value === null || value === undefined || value === '') return '-';
  if (type === 'price' && typeof value === 'number') return `¥${value.toLocaleString()}`;
  if (type === 'count' && typeof value === 'number') return `${value.toLocaleString()}件`;
  return `"${String(value)}"`;
}

function formatCapacityTotal(total) {
  if (!total) return '-';
  return `${total.total.toLocaleString()}${total.unit}`;
}

function pushChangeLine(lines, label, before, after, type = 'text') {
  const normalizedBefore = before ?? null;
  const normalizedAfter = after ?? null;
  if (normalizedBefore === normalizedAfter) return false;
  lines.push(`${label}: ${formatLogValue(before, type)} -> ${formatLogValue(after, type)}`);
  return true;
}

function buildAfterSnapshot(before, updates) {
  return {
    name: updates.newName ?? before?.name ?? '',
    price: updates.price !== null ? updates.price : before?.price ?? null,
    rating: updates.rating !== null ? updates.rating : before?.rating ?? null,
    reviewCount: updates.reviewCount !== null ? updates.reviewCount : before?.reviewCount ?? null,
    rakutenUrl: updates.affiliateUrl || (before?.rakutenUrl ?? null),
    imageUrl: updates.imageUrl || (before?.imageUrl ?? null),
    capacity: updates.newCapacity ?? before?.capacity ?? null,
    pricePerUnit: updates.pricePerUnit != null ? updates.pricePerUnit : before?.pricePerUnit ?? null,
  };
}

function isSameComparableCapacity(a, b) {
  const aTotal = normalizeCapacityTotal(extractCapacityTotal(a ?? ''));
  const bTotal = normalizeCapacityTotal(extractCapacityTotal(b ?? ''));
  return Boolean(
    aTotal &&
    bTotal &&
    aTotal.total === bTotal.total &&
    aTotal.unit.toLowerCase() === bTotal.unit.toLowerCase()
  );
}

const GENERIC_PRODUCT_NAME_TOKENS = new Set([
  'ゴミ袋',
  'ポリ袋',
  '袋',
  '送料無料',
  'セット',
  'パック',
  'まとめ買い',
  '大容量',
]);

function getDistinctiveProductNameTokens(name) {
  return buildSearchKeyword(name)
    .replace(/[【】［］\[\]（）()]/g, ' ')
    .split(/[\s　・、。／/｜|]+/)
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length >= 2)
    .filter(token => !GENERIC_PRODUCT_NAME_TOKENS.has(token))
    .filter(token => !/^[\d.,]+(?:ml|mL|l|L|g|kg|枚|本|袋|個|パック|セット|mm)?$/i.test(token));
}

function isLikelySameProductName(currentName, apiName, { strict = false } = {}) {
  const tokens = getDistinctiveProductNameTokens(currentName);
  if (tokens.length === 0) return true;
  const normalizedApiName = apiName.toLowerCase();
  if (strict) {
    const matched = tokens.filter(token => normalizedApiName.includes(token)).length;
    // 2語以上あるなら2語要求、1語しかない商品名は従来通り1語一致で許容
    const required = tokens.length >= 2 ? 2 : 1;
    return matched >= required;
  }
  return tokens.some(token => normalizedApiName.includes(token));
}

function buildProductLogLines({ before, after, data, extractedCap, oldComparable, apiComparable, capacityNotes }) {
  const lines = [];
  lines.push(`capacity(API抽出): ${formatLogValue(extractedCap)} -> ${formatCapacityTotal(apiComparable)}`);
  pushChangeLine(lines, 'name', before?.name, after.name);
  pushChangeLine(lines, 'price', before?.price, after.price, 'price');
  pushChangeLine(lines, 'rating', before?.rating, after.rating);
  pushChangeLine(lines, 'reviewCount', before?.reviewCount, after.reviewCount, 'count');
  pushChangeLine(lines, 'capacity', before?.capacity, after.capacity);
  pushChangeLine(lines, 'pricePerUnit', before?.pricePerUnit, after.pricePerUnit);
  if (VERBOSE) {
    lines.push(`楽天商品名: ${formatLogValue(data.name)}`);
    lines.push(`capacity(既存比較値): ${formatCapacityTotal(oldComparable)}`);
    lines.push(`capacity(API比較値): ${formatCapacityTotal(apiComparable)}`);
    lines.push(`rakutenUrl(既存): ${formatLogValue(before?.rakutenUrl)}`);
    lines.push(`rakutenUrl(API): ${formatLogValue(data.affiliateUrl)}`);
    lines.push(`imageUrl(既存): ${formatLogValue(before?.imageUrl)}`);
    lines.push(`imageUrl(API): ${formatLogValue(data.imageUrl)}`);
  } else {
    if ((before?.rakutenUrl ?? null) !== (after.rakutenUrl ?? null)) lines.push('rakutenUrl: 変更あり');
    if ((before?.imageUrl ?? null) !== (after.imageUrl ?? null)) lines.push('imageUrl: 変更あり');
  }
  capacityNotes.forEach(note => lines.push(note));
  return lines;
}

// ─── 環境変数を読み込み（.env またはプロセス環境変数） ─────────────────────────
function isSameNormalizedTotal(a, b) {
  return Boolean(
    a &&
    b &&
    a.total === b.total &&
    a.unit.toLowerCase() === b.unit.toLowerCase()
  );
}

function shouldReviewCapacity({ method, capacity, capacityAnalysis, oldComparable, proposedComparable, shouldFreezePriceCapacity }) {
  const reasons = [];

  if (shouldFreezePriceCapacity) reasons.push('multiple capacity variant or manual/API conflict');
  if (capacityAnalysis.confidence !== 'high') reasons.push(...capacityAnalysis.reasons);
  if (oldComparable && proposedComparable && !isSameNormalizedTotal(oldComparable, proposedComparable)) {
    reasons.push('existing capacity and API extracted capacity differ');
  }
  if (!capacityAnalysis.capacity && capacity) {
    reasons.push('API item name has no parseable capacity; keep existing capacity');
  }

  return {
    needsReview: reasons.length > 0,
    reasons: [...new Set(reasons)],
  };
}

function buildCapacityReviewItem({ file, category, method, beforeSnapshot, data, capacityAnalysis, extractedCap, reviewReasons, action }) {
  return {
    articleFile: `src/content/articles/${file}`,
    category,
    method,
    current: {
      name: beforeSnapshot?.name ?? '',
      capacity: beforeSnapshot?.capacity ?? null,
      pricePerUnit: beforeSnapshot?.pricePerUnit ?? null,
    },
    api: {
      itemName: data.name ?? '',
      price: data.price ?? null,
      rating: data.rating ?? null,
      reviewCount: data.reviewCount ?? null,
      itemUrl: data.itemUrl ?? null,
      affiliateUrl: data.affiliateUrl ?? null,
      imageUrl: data.imageUrl ?? null,
    },
    ruleAnalysis: {
      extractedCapacity: extractedCap,
      confidence: capacityAnalysis.confidence,
      reasons: reviewReasons,
    },
    action,
  };
}

function formatCapacityReviewMarkdown(items, today) {
  const lines = [
    '# capacity review report',
    '',
    `Generated: ${today}`,
    `Items: ${items.length}`,
    '',
  ];

  for (const item of items) {
    lines.push(`## ${item.articleFile}`);
    lines.push('');
    lines.push(`### ${item.current.name || item.api.itemName || '(no name)'}`);
    lines.push(`- method: ${item.method}`);
    lines.push(`- current name: ${item.current.name || '-'}`);
    lines.push(`- current capacity: ${item.current.capacity ?? '-'}`);
    lines.push(`- current pricePerUnit: ${item.current.pricePerUnit ?? '-'}`);
    lines.push(`- API itemName: ${item.api.itemName || '-'}`);
    lines.push(`- API extracted capacity: ${item.ruleAnalysis.extractedCapacity ?? '-'}`);
    lines.push(`- confidence: ${item.ruleAnalysis.confidence}`);
    lines.push(`- action: ${item.action}`);
    lines.push(`- rakutenUrl: ${item.api.itemUrl || item.api.affiliateUrl || '-'}`);
    lines.push('- reasons:');
    for (const reason of item.ruleAnalysis.reasons) lines.push(`  - ${reason}`);
    lines.push('');
  }

  return lines.join('\n');
}

function writeCapacityReviewReports(items) {
  if (items.length === 0) return null;

  const today = new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const reportsDir = resolve(process.cwd(), 'reports');
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

  const mdPath = join(reportsDir, `capacity-review-${today}.md`);
  const jsonlPath = join(reportsDir, `ai-capacity-input-${today}.jsonl`);
  writeFileSync(mdPath, formatCapacityReviewMarkdown(items, today), 'utf-8');
  writeFileSync(jsonlPath, items.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf-8');
  return { mdPath, jsonlPath };
}

function writeProductMatchReport(items) {
  if (items.length === 0) return null;
  const inputDir = resolve(process.cwd(), 'reports/toAI/kura-product-match-ai');
  ensureDir(inputDir);
  const jsonlPath = join(inputDir, `product-match-input-${todayJst()}.jsonl`);
  writeFileSync(jsonlPath, items.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf-8');
  return jsonlPath;
}

function todayJst() {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const DELETED_PRODUCT_HISTORY_PATH = resolve(process.cwd(), 'data/deleted-products-history.jsonl');
const RECENT_DELETED_DAYS = 7;

function parseDateAsUtc(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isWithinRecentDays(date, today, days) {
  const target = parseDateAsUtc(date);
  const base = parseDateAsUtc(today);
  if (!target || !base) return false;
  const diffDays = (base.getTime() - target.getTime()) / 86400000;
  return diffDays >= 0 && diffDays <= days;
}

function readDeletedProductHistory() {
  if (!existsSync(DELETED_PRODUCT_HISTORY_PATH)) return [];
  return readFileSync(DELETED_PRODUCT_HISTORY_PATH, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function getRecentDeletedProductsForArticle(articleFile, today) {
  return readDeletedProductHistory()
    .filter(item => item.articleFile === articleFile)
    .filter(item => isWithinRecentDays(item.deletedAt, today, RECENT_DELETED_DAYS));
}

function findRecentDeletedProduct(directUrl, recentDeletedProducts) {
  if (!directUrl) return null;
  return recentDeletedProducts.find(item => item.directUrl === directUrl) ?? null;
}

function appendDeletedProductHistory(items) {
  if (items.length === 0) return null;
  ensureDir(dirname(DELETED_PRODUCT_HISTORY_PATH));
  appendFileSync(
    DELETED_PRODUCT_HISTORY_PATH,
    items.map(item => JSON.stringify(item)).join('\n') + '\n',
    'utf-8'
  );
  return DELETED_PRODUCT_HISTORY_PATH;
}

function buildDeletedProductHistoryItems({ file, category, products, maxRank }) {
  const deletedAt = todayJst();
  return products.map(product => ({
    deletedAt,
    articleFile: `src/content/articles/${file}`,
    category,
    reason: 'rank-limit',
    maxRank,
    rank: product.rank ?? null,
    name: product.name ?? '',
    capacity: product.capacity ?? null,
    reviewCount: product.reviewCount ?? null,
    rakutenUrl: product.rakutenUrl ?? '',
    directUrl: toDirectItemUrl(product.rakutenUrl) ?? product.rakutenUrl ?? '',
    identityKey: normalizeProductIdentity(product.name ?? ''),
  }));
}

function normalizePathForCompare(path) {
  return resolve(path).toLowerCase();
}

function isSafeArticleFile(articleFile) {
  if (typeof articleFile !== 'string' || !articleFile) return false;
  const articlesDir = resolve(process.cwd(), 'src/content/articles');
  const target = resolve(process.cwd(), articleFile);
  return normalizePathForCompare(target).startsWith(normalizePathForCompare(articlesDir) + '\\')
    || normalizePathForCompare(target).startsWith(normalizePathForCompare(articlesDir) + '/');
}

function parseJsonlFile(filePath) {
  const lines = readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return lines.map((line, index) => {
    try {
      return { ok: true, lineNo: index + 1, data: JSON.parse(line) };
    } catch (e) {
      return { ok: false, lineNo: index + 1, error: e.message };
    }
  });
}

function getAiMatchCurrentName(match) {
  return match.currentName
    ?? match.current?.name
    ?? match.current?.productName
    ?? null;
}

function getProductByRank(products, rank) {
  if (rank === null || rank === undefined) return null;
  const normalizedRank = typeof rank === 'number' ? rank : Number(rank);
  if (!Number.isFinite(normalizedRank)) return null;
  return products.find(product => product.rank === normalizedRank) ?? null;
}

function buildAiMatchUpdates(match) {
  return {
    price: typeof match.newPrice === 'number' ? match.newPrice : null,
    rating: typeof match.newRating === 'number' ? match.newRating : null,
    reviewCount: typeof match.newReviewCount === 'number' ? match.newReviewCount : null,
    affiliateUrl: typeof match.selectedAffiliateUrl === 'string' ? match.selectedAffiliateUrl : null,
    imageUrl: typeof match.selectedImageUrl === 'string' ? match.selectedImageUrl : null,
    pricePerUnit: match.newPricePerUnit ?? null,
    newName: typeof match.newName === 'string' && match.newName ? match.newName : undefined,
    newCapacity: typeof match.newCapacity === 'string' && match.newCapacity ? match.newCapacity : undefined,
  };
}

function validateUrlLike(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function applyAiMatchToContent(content, match) {
  if (match.action === 'review') {
    if (match.decision === 'delete') {
      const allProducts = extractAllProductsData(content);
      const rankProduct = getProductByRank(allProducts, match.rank);
      const currentName = getAiMatchCurrentName(match);
      if (!rankProduct || !currentName) {
        return { ok: false, message: 'review delete requires rank and current.name' };
      }
      if (rankProduct.name !== currentName) {
        return {
          ok: false,
          message: `rank/current.name mismatch: rank ${match.rank} is "${rankProduct.name}", JSONL current is "${currentName}"`,
        };
      }
      const duplicates = allProducts.filter(p => p.name === currentName);
      if (duplicates.length > 1) {
        return {
          ok: true, changed: false, review: true, deleted: false,
          deletedName: null, deletedProduct: null, content: null,
          message: `duplicate name "${currentName}": skipped deletion`,
        };
      }
      const nextContent = removeProductFromFrontmatter(content, currentName);
      if (nextContent === null) {
        return {
          ok: true, changed: false, review: true, deleted: false,
          deletedName: null, deletedProduct: null, content: null,
          message: `last product: cannot delete "${currentName}"`,
        };
      }
      return {
        ok: true, changed: true, review: true, deleted: true,
        deletedName: currentName, deletedProduct: rankProduct, content: nextContent,
        message: match.reason ?? '',
      };
    }
    return { ok: true, changed: false, review: true, deleted: false, message: match.reason ?? 'review' };
  }
  if (match.action !== 'replace') {
    return { ok: false, message: `unsupported action: ${match.action ?? '-'}` };
  }
  if (!validateUrlLike(match.selectedAffiliateUrl)) {
    return { ok: false, message: 'replace requires selectedAffiliateUrl' };
  }

  const rankProduct = getProductByRank(extractAllProductsData(content), match.rank);
  const currentName = getAiMatchCurrentName(match);
  if (!rankProduct || !currentName) {
    return { ok: false, message: 'rank and current.name are required for replace' };
  }
  if (rankProduct.name !== currentName) {
    return {
      ok: false,
      message: `rank/current.name mismatch: rank ${match.rank} is "${rankProduct.name}", JSONL current is "${currentName}"`,
    };
  }

  const before = extractProductSnapshot(content, rankProduct.name);
  const updates = buildAiMatchUpdates(match);
  const nextContent = updateProductInFrontmatter(content, rankProduct.name, updates);
  const after = extractProductSnapshot(nextContent, updates.newName ?? rankProduct.name);
  const changed = nextContent !== content;
  return { ok: true, changed, before, after, review: false, message: match.reason ?? '', content: nextContent };
}

function writeAiMatchReviewReport(reviewItems) {
  if (reviewItems.length === 0) return null;
  const reviewDir = resolve(process.cwd(), 'reports/ai-matches/review');
  ensureDir(reviewDir);
  const path = join(reviewDir, `product-match-review-${todayJst()}.jsonl`);
  writeFileSync(path, reviewItems.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf-8');
  return path;
}

function moveAiMatchFile(filePath, status) {
  const targetDir = resolve(process.cwd(), `reports/ai-matches/${status}`);
  ensureDir(targetDir);
  let targetPath = join(targetDir, basename(filePath));
  if (existsSync(targetPath)) {
    const extIdx = basename(filePath).lastIndexOf('.');
    const base = extIdx >= 0 ? basename(filePath).slice(0, extIdx) : basename(filePath);
    const ext = extIdx >= 0 ? basename(filePath).slice(extIdx) : '';
    targetPath = join(targetDir, `${base}-${Date.now()}${ext}`);
  }
  renameSync(filePath, targetPath);
  return targetPath;
}

function applyPendingAiMatches() {
  const pendingDir = resolve(process.cwd(), 'reports/ai-matches/pending');
  if (!existsSync(pendingDir)) return { processed: 0, failed: 0, reviews: 0, deletedArticles: new Set() };

  const pendingFiles = readdirSync(pendingDir)
    .filter(file => file.endsWith('.jsonl'))
    .map(file => join(pendingDir, file));
  if (pendingFiles.length === 0) return { processed: 0, failed: 0, reviews: 0, deletedArticles: new Set() };

  console.log(`\nAI match pending files: ${pendingFiles.length}`);
  const reviewItems = [];
  const deletedArticles = new Set();
  let processed = 0;
  let failed = 0;

  for (const pendingFile of pendingFiles) {
    console.log(`   apply: ${basename(pendingFile)}`);
    const parsedLines = parseJsonlFile(pendingFile);
    let hasFailure = parsedLines.some(line => !line.ok);
    const byArticle = new Map();

    for (const line of parsedLines) {
      if (!line.ok) {
        console.log(`      line ${line.lineNo}: JSON parse failed: ${line.error}`);
        continue;
      }
      const match = line.data;
      if (!isSafeArticleFile(match.articleFile)) {
        hasFailure = true;
        console.log(`      line ${line.lineNo}: invalid articleFile`);
        continue;
      }
      if (!matchesFileFilter(basename(match.articleFile))) {
        console.log(`      line ${line.lineNo}: skipped by --file`);
        continue;
      }
      const articlePath = resolve(process.cwd(), match.articleFile);
      if (!existsSync(articlePath)) {
        hasFailure = true;
        console.log(`      line ${line.lineNo}: article file not found`);
        continue;
      }
      const items = byArticle.get(articlePath) ?? [];
      items.push({ lineNo: line.lineNo, match });
      byArticle.set(articlePath, items);
    }

    for (const [articlePath, items] of byArticle.entries()) {
      const originalContent = readFileSync(articlePath, 'utf-8');
      let content = originalContent;
      const pendingDeletedHistoryItems = [];

      // replace を先に、review delete は rank 降順に処理してrank詰め直しのずれを防ぐ
      const replaceItems = items.filter(i => i.match.action === 'replace');
      const reviewItems2 = items
        .filter(i => i.match.action === 'review')
        .sort((a, b) => (b.match.rank ?? 0) - (a.match.rank ?? 0));
      const orderedItems = [...replaceItems, ...reviewItems2];

      for (const item of orderedItems) {
        const result = applyAiMatchToContent(content, item.match);
        if (!result.ok) {
          hasFailure = true;
          console.log(`      line ${item.lineNo}: ${result.message}`);
          continue;
        }
        if (result.review) {
          reviewItems.push({
            sourceFile: basename(pendingFile),
            articleFile: item.match.articleFile,
            rank: item.match.rank ?? null,
            currentName: getAiMatchCurrentName(item.match),
            reason: item.match.reason ?? null,
            decision: item.match.decision ?? 'manual',
            deleted: result.deleted ?? false,
          });
          if (result.deleted && result.content) {
            content = result.content;
            deletedArticles.add(basename(item.match.articleFile));
            const articleCategory = extractArticleCategory(content) ?? basename(articlePath).replace(/-comparison\.md$/, '');
            pendingDeletedHistoryItems.push({
              deletedAt: todayJst(),
              articleFile: item.match.articleFile,
              category: articleCategory,
              reason: 'ai-review',
              rank: result.deletedProduct.rank ?? null,
              name: result.deletedProduct.name ?? '',
              capacity: result.deletedProduct.capacity ?? null,
              reviewCount: result.deletedProduct.reviewCount ?? null,
              rakutenUrl: result.deletedProduct.rakutenUrl ?? '',
              directUrl: toDirectItemUrl(result.deletedProduct.rakutenUrl) ?? result.deletedProduct.rakutenUrl ?? '',
              identityKey: normalizeProductIdentity(result.deletedProduct.name ?? ''),
            });
            console.log(`      line ${item.lineNo}: review deleted "${result.deletedName}"`);
          } else {
            console.log(`      line ${item.lineNo}: review skipped (${result.message})`);
          }
          continue;
        }
        content = result.content;
        console.log(`      line ${item.lineNo}: replace ${result.changed ? 'applied' : 'no change'}`);
      }

      if (!DRY_RUN && content !== originalContent) {
        const today = todayJst();
        content = updateUpdatedAt(content, today);
        writeFileSync(articlePath + '.bak', originalContent, 'utf-8');
        writeFileSync(articlePath, content, 'utf-8');
        appendDeletedProductHistory(pendingDeletedHistoryItems);
        console.log(`      saved: ${basename(articlePath)} (updatedAt: ${today})`);
      } else if (DRY_RUN && content !== originalContent) {
        console.log(`      [dry-run] would save: ${basename(articlePath)}`);
        if (pendingDeletedHistoryItems.length > 0) {
          console.log(`      [dry-run] would record ${pendingDeletedHistoryItems.length} ai-review deletion(s) to history`);
        }
      }
    }

    if (!DRY_RUN) {
      const status = hasFailure ? 'failed' : 'processed';
      const movedTo = moveAiMatchFile(pendingFile, status);
      console.log(`      moved to ${status}: ${movedTo}`);
    } else {
      console.log(`      [dry-run] would move to ${hasFailure ? 'failed' : 'processed'}`);
    }

    if (hasFailure) failed++;
    else processed++;
  }

  const reviewPath = DRY_RUN ? null : writeAiMatchReviewReport(reviewItems);
  if (reviewPath) console.log(`AI match review report: ${reviewPath}`);
  if (DRY_RUN && reviewItems.length > 0) console.log(`AI match review report: [dry-run] ${reviewItems.length} items`);
  return { processed, failed, reviews: reviewItems.length, deletedArticles };
}

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
const CONSECUTIVE_ZERO_ABORT = 3; // 連続この件数以上の0件エラーで中断（API障害検知用）
let apiQueue = Promise.resolve();
let lastApiRequestAt = 0;

async function rateLimitedFetch(url, options) {
  const run = apiQueue.then(async () => {
    const waitMs = Math.max(0, API_INTERVAL_MS - (Date.now() - lastApiRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    lastApiRequestAt = Date.now();
    return fetch(url, options);
  });
  apiQueue = run.catch(() => {});
  return run;
}

/**
 * 楽天アフィリエイトURL または item.rakuten.co.jp 直接URL から
 * { shopCode, itemCode } を抽出する
 */
function parseRakutenItemUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'hb.afl.rakuten.co.jp') {
      const pc = parsed.searchParams.get('pc');
      if (!pc) return null;
      const inner = new URL(decodeURIComponent(pc));
      if (inner.hostname !== 'item.rakuten.co.jp') return null;
      const m = inner.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
      if (!m) return null;
      return { shopCode: m[1], itemCode: m[2] };
    }
    if (parsed.hostname === 'item.rakuten.co.jp') {
      const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
      if (!m) return null;
      return { shopCode: m[1], itemCode: m[2] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * shopCode でショップを絞り込んだ Search API 結果から itemCode が一致する商品を返す
 * 商品が見つからない（廃番・商品名変更で未ヒット）場合は null → キーワード検索へフォールバック
 */
async function fetchRakutenItem(shopCode, itemCode, productName) {
  const searchKeyword = buildSearchKeyword(productName);
  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    affiliateId: AFFILIATE_ID,
    keyword: searchKeyword,
    shopCode,
    hits: '10',
    imageFlag: '1',
    sort: '-reviewCount',
    formatVersion: '2',
    elements: [
      'itemName', 'itemPrice', 'itemUrl', 'affiliateUrl',
      'mediumImageUrls', 'reviewCount', 'reviewAverage',
      'shopName', 'shopUrl',
    ].join(','),
  });

  const url = `${RAKUTEN_API_ENDPOINT}?${params}`;
  const headers = {
    'accessKey': ACCESS_KEY,
    'Origin': 'https://yu0416ryfu-sys.github.io',
    'Referer': 'https://yu0416ryfu-sys.github.io/',
  };

  let res;
  try {
    res = await rateLimitedFetch(url, { headers });
  } catch {
    return null;
  }

  if (res.status === 429) {
    await sleep(5000);
    try {
      res = await rateLimitedFetch(url, { headers });
    } catch {
      return null;
    }
  }

  if (!res.ok) return null;

  let data;
  try { data = await res.json(); } catch { return null; }

  if (!data.Items || data.Items.length === 0) {
    return fetchRakutenItemFallback(shopCode, itemCode, productName);
  }

  // ふるさと納税除外（fetchRakutenSearch と同じ基準）
  const filtered = data.Items.filter(item => {
    if (/\/f\d{4,}-[a-z]/.test(item.shopUrl || '') || /\/f\d{4,}-[a-z]/.test(item.itemUrl || '')) return false;
    if (/ふるさと納税|ふるさと|寄付|寄附|返礼品/.test(item.itemName || '')) return false;
    if (/ふるさと納税|furusato/.test(item.shopName || '')) return false;
    return true;
  });

  // shopCode/itemCode で完全一致する商品を探す
  // itemUrl はアフィリエイトURL形式（pc= パラメータにURLエンコード）で返ることがあるため
  // decodeURIComponent してから比較する
  const matchesItem = (rawUrl) => {
    if (!rawUrl) return false;
    const decoded = decodeURIComponent(rawUrl);
    return decoded.includes(`/${shopCode}/${itemCode}/`) || decoded.endsWith(`/${shopCode}/${itemCode}`);
  };

  const target = filtered.find(item => matchesItem(item.itemUrl) || matchesItem(item.affiliateUrl));

  if (!target) {
    return fetchRakutenItemFallback(shopCode, itemCode, productName);
  }

  return {
    name: target.itemName,
    price: target.itemPrice ?? null,
    rating: target.reviewAverage ? Number(target.reviewAverage) : null,
    reviewCount: target.reviewCount ? Number(target.reviewCount) : null,
    itemUrl: target.itemUrl,
    imageUrl: target.mediumImageUrls?.[0] ?? null,
    affiliateUrl: target.affiliateUrl ?? null,
  };
}

/**
 * fetchRakutenItem が null を返した後のフォールバック検索。
 * 試行A: Search API の itemCode パラメータで直接絞り込み（最も確実）
 * 試行B: 容量除去キーワード × hits=30
 * 試行C: 固有語先頭2語 × hits=30（関連度ソート）
 */
async function fetchRakutenItemFallback(shopCode, itemCode, productName) {
  const strippedKeyword = stripCapacityForKeyword(productName).slice(0, 40);
  const brandKeyword = buildSearchKeyword(productName).split(/\s+/).filter(Boolean).slice(0, 2).join(' ');

  const strategies = [
    // 試行A: 容量除去キーワード × 上位30件（shopCode絞り）
    ...(strippedKeyword.length >= 2 ? [{ keyword: strippedKeyword, hits: 30, sort: '-reviewCount' }] : []),
    // 試行B: 固有語2語 × 上位30件（shopCode絞り・関連度ソート）
    ...(brandKeyword.length >= 2 && brandKeyword !== strippedKeyword
      ? [{ keyword: brandKeyword, hits: 30, sort: 'standard' }]
      : []),
    // 試行C: 固有語2語 × 上位30件（shopCode なし・全体検索）
    // ショップ内ランクに関係なく広く探す。matchesItem() で正確なURLを照合するため誤採用なし
    ...(brandKeyword.length >= 2
      ? [{ keyword: brandKeyword, hits: 30, sort: 'standard', noShopCode: true }]
      : []),
  ];

  const headers = {
    'accessKey': ACCESS_KEY,
    'Origin': 'https://yu0416ryfu-sys.github.io',
    'Referer': 'https://yu0416ryfu-sys.github.io/',
  };

  const matchesItem = (rawUrl) => {
    if (!rawUrl) return false;
    const decoded = decodeURIComponent(rawUrl);
    return decoded.includes(`/${shopCode}/${itemCode}/`) || decoded.endsWith(`/${shopCode}/${itemCode}`);
  };

  for (const { keyword, hits, sort, noShopCode = false } of strategies) {
    const paramObj = {
      applicationId: APPLICATION_ID,
      affiliateId: AFFILIATE_ID,
      ...(noShopCode ? {} : { shopCode }),
      hits: String(hits),
      imageFlag: '1',
      sort,
      formatVersion: '2',
      elements: [
        'itemName', 'itemPrice', 'itemUrl', 'affiliateUrl',
        'mediumImageUrls', 'reviewCount', 'reviewAverage',
        'shopName', 'shopUrl',
      ].join(','),
    };
    if (keyword) paramObj.keyword = keyword;

    const url = `${RAKUTEN_API_ENDPOINT}?${new URLSearchParams(paramObj)}`;
    let res;
    try {
      res = await rateLimitedFetch(url, { headers });
    } catch {
      continue;
    }
    if (res.status === 429) {
      await sleep(5000);
      try { res = await rateLimitedFetch(url, { headers }); } catch { continue; }
    }
    if (!res.ok) continue;

    let data;
    try { data = await res.json(); } catch { continue; }
    if (!data.Items || data.Items.length === 0) continue;

    const filtered = data.Items.filter(item => {
      if (/\/f\d{4,}-[a-z]/.test(item.shopUrl || '') || /\/f\d{4,}-[a-z]/.test(item.itemUrl || '')) return false;
      if (/ふるさと納税|ふるさと|寄付|寄附|返礼品/.test(item.itemName || '')) return false;
      if (/ふるさと納税|furusato/.test(item.shopName || '')) return false;
      return true;
    });

    const target = filtered.find(item => matchesItem(item.itemUrl) || matchesItem(item.affiliateUrl));
    if (!target) continue;

    return {
      name: target.itemName,
      price: target.itemPrice ?? null,
      rating: target.reviewAverage ? Number(target.reviewAverage) : null,
      reviewCount: target.reviewCount ? Number(target.reviewCount) : null,
      itemUrl: target.itemUrl,
      imageUrl: target.mediumImageUrls?.[0] ?? null,
      affiliateUrl: target.affiliateUrl ?? null,
      _viafallback: true,
    };
  }

  return null;
}

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
  let res = await rateLimitedFetch(url, {
    headers: {
      'accessKey': ACCESS_KEY,
      'Origin': 'https://yu0416ryfu-sys.github.io',
      'Referer': 'https://yu0416ryfu-sys.github.io/',
    },
  });

  if (res.status === 429) {
    // レート制限: 5秒待ってリトライ
    await sleep(5000);
    const res2 = await rateLimitedFetch(url, {
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

/**
 * 汎用ワード「日用品」で楽天APIが正常応答しているか確認するプローブ。
 * 1件以上ヒット → true（正常）、0件/エラー → false（障害の可能性）
 */
async function isApiHealthy() {
  try {
    const params = new URLSearchParams({
      applicationId: APPLICATION_ID,
      affiliateId: AFFILIATE_ID,
      keyword: '日用品',
      hits: '1',
      formatVersion: '2',
      elements: 'itemName',
    });
    const res = await rateLimitedFetch(`${RAKUTEN_API_ENDPOINT}?${params}`, {
      headers: {
        'accessKey': ACCESS_KEY,
        'Origin': 'https://yu0416ryfu-sys.github.io',
        'Referer': 'https://yu0416ryfu-sys.github.io/',
      },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.Items) && data.Items.length > 0;
  } catch {
    return false;
  }
}


// ─── 複数件取得（追加候補レポート用） ────────────────────────────────────────
/**
 * 検索キーワードで楽天APIを叩き、最大 hits 件（上限30）の商品リストを返す
 */
async function fetchRakutenSearchMany(keyword, hits = 30, page = 1) {
  const searchKeyword = buildSearchKeyword(keyword);
  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    affiliateId: AFFILIATE_ID,
    keyword: searchKeyword,
    hits: String(Math.min(hits, 30)),
    page: String(page),
    imageFlag: '1',
    sort: '-reviewCount',
    formatVersion: '2',
    elements: [
      'itemName', 'itemPrice', 'itemUrl', 'affiliateUrl',
      'mediumImageUrls', 'reviewCount', 'reviewAverage',
      'shopName', 'shopUrl',
    ].join(','),
  });

  const url = `${RAKUTEN_API_ENDPOINT}?${params}`;
  const reqHeaders = {
    'accessKey': ACCESS_KEY,
    'Origin': 'https://yu0416ryfu-sys.github.io',
    'Referer': 'https://yu0416ryfu-sys.github.io/',
  };

  let res = await rateLimitedFetch(url, { headers: reqHeaders });
  if (res.status === 429) {
    await sleep(5000);
    res = await rateLimitedFetch(url, { headers: reqHeaders });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.Items || data.Items.length === 0) return [];

  return data.Items
    .filter(item => {
      const shopUrl = item.shopUrl || '';
      const itemUrl = item.itemUrl || '';
      if (/\/f\d{4,}-[a-z]/.test(shopUrl) || /\/f\d{4,}-[a-z]/.test(itemUrl)) return false;
      if (/ふるさと納税|ふるさと|寄付|寄附|返礼品/.test(item.itemName || '')) return false;
      if (/ふるさと納税|furusato/.test(item.shopName || '')) return false;
      return true;
    })
    .map(item => ({
      name: item.itemName,
      price: item.itemPrice ?? null,
      rating: item.reviewAverage ? Number(item.reviewAverage) : null,
      reviewCount: item.reviewCount ? Number(item.reviewCount) : null,
      itemUrl: item.itemUrl,
      affiliateUrl: item.affiliateUrl ?? null,
      imageUrl: item.mediumImageUrls?.[0] ?? null,
    }));
}

function stripCapacityForKeyword(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/[【\[].+?[】\]]/g, ' ')
    .replace(/[（(].+?[）)]/g, ' ')
    .replace(/\d[\d,.]*\s*(?:mL|ml|ML|L|l|g|G|kg|KG|枚|個|本|袋|箱|パック|セット|ロール|巻|包|錠|m|M).*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSizeAndCapacityForKeyword(name) {
  return stripCapacityForKeyword(name)
    .split(/\s+/)
    .filter(token => !/^(?:SS|S|M|L|LL|XL|2L|3L|大|小|大容量|小容量)$/i.test(token))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildProductMatchSearchKeywords({ productName, articleTitle, category }) {
  const normalizedName = String(productName ?? '').normalize('NFKC').trim();
  const strippedName = stripCapacityForKeyword(normalizedName);
  const fallbackName = stripSizeAndCapacityForKeyword(normalizedName);
  const baseKeyword = buildSearchKeyword(normalizedName);
  const tokens = strippedName.split(/\s+/).filter(Boolean);
  const articleKeyword = articleTitle ? buildArticleSearchKeyword(articleTitle) : '';
  const categoryKeywords = CATEGORY_SEARCH_RULES[category]?.keywords ?? [];

  return uniqueStrings([
    baseKeyword,
    strippedName,
    tokens.slice(0, 4).join(' '),
    tokens.slice(0, 3).join(' '),
    fallbackName,
    ...categoryKeywords.slice(0, 2),
    articleKeyword,
  ])
    .filter(keyword => keyword.length >= 2)
    .slice(0, 6);
}

async function collectProductMatchCandidates(searchKeywords, maxCandidates = 10) {
  const candidates = [];
  const seenUrls = new Set();

  for (const keyword of searchKeywords) {
    let fetched = [];
    try {
      fetched = await fetchRakutenSearchMany(keyword, 10);
    } catch {
      continue;
    }

    for (const item of fetched) {
      const directItemUrl = toDirectItemUrl(item.itemUrl) ?? toDirectItemUrl(item.affiliateUrl) ?? item.itemUrl ?? null;
      const dedupeKey = directItemUrl ?? item.affiliateUrl ?? item.name;
      if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
      seenUrls.add(dedupeKey);
      candidates.push({
        itemName: item.name ?? '',
        itemUrl: item.itemUrl ?? directItemUrl,
        directItemUrl,
        affiliateUrl: item.affiliateUrl ?? null,
        price: item.price ?? null,
        rating: item.rating ?? null,
        reviewCount: item.reviewCount ?? null,
        imageUrl: item.imageUrl ?? null,
        capacityExtracted: item.name ? extractCapacityFromItemName(item.name) : null,
        sourceKeyword: keyword,
      });
      if (candidates.length >= maxCandidates) return candidates;
    }
  }

  return candidates;
}

function isPlaceholderProductUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('example.com') || url.includes('/placeholder/');
}

function getFailureStage(errorMessage, existingItemRef, existingUrl) {
  errorMessage = String(errorMessage ?? '');
  if (isPlaceholderProductUrl(existingUrl)) return 'placeholder-url';
  if (errorMessage.includes('keyword is not valid')) return 'search-keyword-invalid';
  if (errorMessage.includes('0件') || errorMessage.includes('通常商品が見つかりません')) return 'search-zero-result';
  if (errorMessage.includes('商品名が現在の商品と一致しません')) return 'item-name-mismatch';
  if (errorMessage.includes('APIで確認できません')) return 'item-get-failed';
  if (existingItemRef) return 'item-update-failed';
  return 'update-failed';
}

async function buildProductMatchReportItem({ file, category, articleTitle, content, productName, error, existingItemRef }) {
  const errorMessage = error instanceof Error ? error.message : String(error ?? '');
  const current = extractProductSnapshot(content, productName);
  const products = extractAllProductsData(content);
  const productBasic = products.find(product => product.name === productName);
  const existingUrl = current?.rakutenUrl ?? productBasic?.rakutenUrl ?? null;
  const searchKeywords = buildProductMatchSearchKeywords({ productName, articleTitle, category });
  const candidates = await collectProductMatchCandidates(searchKeywords);

  return {
    articleFile: `src/content/articles/${file}`,
    rank: productBasic?.rank ?? null,
    category,
    current: {
      name: current?.name ?? productName,
      capacity: current?.capacity ?? null,
      price: current?.price ?? null,
      pricePerUnit: current?.pricePerUnit ?? null,
      rating: current?.rating ?? null,
      reviewCount: current?.reviewCount ?? null,
      rakutenUrl: existingUrl,
      imageUrl: current?.imageUrl ?? null,
    },
    failure: {
      stage: getFailureStage(errorMessage, existingItemRef, existingUrl),
      error: errorMessage,
      existingItemRef,
    },
    searchKeywords,
    candidates,
  };
}

const CATEGORY_SEARCH_RULES = {
  'bath-mold-preventer': {
    keywords: ['お風呂 防カビ くん煙剤', '防カビくん煙剤 3個パック', '浴室 防カビ剤 まとめ買い'],
    include: ['防カビ', 'くん煙', 'くん煙剤', 'カビーヌ', '浴室用'],
    exclude: ['カビ取りスプレー', 'カビ取りジェル', '洗剤', 'ブラシ', 'スポンジ', '排水口', '洗濯槽', 'エアコン'],
    units: ['個', 'g'],
  },
  'drain-cleaner': {
    keywords: ['排水口クリーナー まとめ買い', 'パイプクリーナー ジェル', 'パイプ洗浄剤 大容量'],
    include: ['排水口', 'パイプクリーナー', 'パイプ洗浄', 'パイプユニッシュ', 'パイプハイター', 'パイプマン'],
    exclude: ['ブラシ', 'ワイヤー', '排水口ネット', '水切りネット', 'ヌメリ取り剤 置くだけ', '洗濯槽', '風呂釜'],
    units: ['ml', 'g', '本'],
  },
  'melamine-sponge': {
    keywords: ['メラミンスポンジ まとめ買い', 'メラミンスポンジ キューブ', '激落ちくん メラミンスポンジ'],
    include: ['メラミンスポンジ', 'メラミンフォーム', '激落ちくん', 'メラピッカ', 'ピカ王'],
    exclude: ['スポンジホルダー', 'ラック', '柄付き', 'ブラシ', 'バススポンジ', '洗車', '靴用', '交換用'],
    units: ['個'],
  },
  'air-conditioner-filter': {
    keywords: ['エアコンフィルター 家庭用', 'エアコンフィルター 不織布 枚', 'エアコンフィルター 粘着 貼る'],
    include: ['エアコンフィルター', 'エアコン用フィルター'],
    exclude: ['車両用', 'カーエアコン', '純正交換', 'ブラシ', 'クリーナー', '洗剤'],
    units: ['枚', '個'],
  },
  'body-soap': {
    keywords: ['ボディソープ', 'ボディウォッシュ', '全身シャンプー'],
    include: ['ボディソープ', 'ボディーソープ', 'ボディウォッシュ', '全身シャンプー', '全身', '石鹸', '石けん', 'せっけん'],
    exclude: ['洗顔', '顔ダニ', 'フェイス', 'クレンジング', 'スクラブ', 'シャンプー', 'ハンドソープ', 'ワイプ', 'シート'],
    units: ['ml', 'g', '個'],
  },
  'shampoo': {
    keywords: ['シャンプー', 'ヘアシャンプー', 'スカルプシャンプー'],
    include: ['シャンプー', 'スカルプ', 'ヘアケア'],
    exclude: ['トリートメント', 'コンディショナー', 'ボディソープ', 'ブラシ'],
    units: ['ml'],
  },
  'conditioner': {
    keywords: ['コンディショナー', 'リンス', 'ヘアコンディショナー'],
    include: ['コンディショナー', 'リンス', 'トリートメント'],
    exclude: ['シャンプーのみ', 'ブラシ', 'ヘッドスパ'],
    units: ['ml', 'g'],
  },
  'hand-soap': {
    keywords: ['ハンドソープ', '泡ハンドソープ', '薬用ハンドソープ'],
    include: ['ハンドソープ', '手洗い', '泡'],
    exclude: ['食器用', 'ボディソープ', '洗顔'],
    units: ['ml', '個'],
  },
  'cleansing': {
    keywords: ['クレンジング', 'メイク落とし', 'クレンジングオイル'],
    include: ['クレンジング', 'メイク落とし', 'メーク落とし', '化粧落とし'],
    exclude: ['洗顔ネット', '泡立てネット', '泡ネット', '洗顔料', '洗顔石鹸', '洗顔せっけん', '石鹸', '石けん', 'せっけん', '石鹸シャンプー', 'ホホバオイル', 'キャリアオイル', '美容オイル', 'マッサージ', 'ヘアオイル', '乳化ワックス', '乳化剤', '手作りコスメ', '手作り化粧品'],
    units: ['ml', 'g', '個'],
    minScore: 5,
  },
  'dish-detergent': {
    keywords: ['食器用洗剤', '台所用洗剤', 'キッチン洗剤'],
    include: ['食器用', '台所用', 'キッチン', '洗剤'],
    exclude: ['食洗機', '洗濯', 'ハンドソープ', 'ディスペンサー'],
    units: ['ml', 'g', '個'],
  },
  'laundry-detergent': {
    keywords: ['洗濯洗剤', '液体洗剤', '衣料用洗剤'],
    include: ['洗濯', '衣料用', '洗剤'],
    exclude: ['食器用', '柔軟剤', '漂白剤', '洗濯槽'],
    units: ['ml', 'g', '個'],
  },
  'toilet-paper': {
    keywords: ['トイレットペーパー', 'トイレットティシュー', 'トイレットロール'],
    include: ['トイレット', 'ロール'],
    exclude: ['ホルダー', '収納', 'ケース'],
    units: ['m', 'ロール'],
  },
  'tissue-paper': {
    keywords: ['ティッシュペーパー', '箱ティッシュ', 'ソフトパックティッシュ'],
    include: ['ティッシュ', 'ティシュー'],
    exclude: ['ケース', 'カバー', '保湿クリーム'],
    units: ['枚', '個', '箱'],
  },
  'garbage-bag': {
    keywords: ['ゴミ袋 まとめ買い', 'ごみ袋 100枚', 'ゴミ袋 45L 半透明'],
    include: ['ゴミ袋', 'ごみ袋', 'ポリ袋'],
    exclude: ['ゴミ箱', 'ごみ箱', 'ダストボックス', 'ケース', '宅配', 'パン袋', '水切りゴミ袋', '水切り袋', 'シンク用', '排水口'],
    units: ['枚', 'L'],
    requiredGroups: [['枚']],
  },
  'coffee-filter': {
    keywords: ['コーヒーフィルター', 'ペーパーフィルター', '円すい コーヒーフィルター'],
    include: ['コーヒーフィルター', 'ペーパーフィルター', 'フィルター'],
    exclude: ['ドリッパー', 'サーバー', '豆', '粉'],
    units: ['枚'],
  },
  'ballpoint-pen': {
    keywords: ['ボールペン', '油性ボールペン', 'ゲルインク ボールペン'],
    include: ['ボールペン', '油性', 'ゲルインク', 'ジェットストリーム', 'サラサ', 'フリクション'],
    exclude: ['替芯', 'リフィル', 'シャープペン', '万年筆', '鉛筆', 'ケース'],
    units: ['本'],
  },
  'gift': {
    keywords: ['父の日ギフト', '父の日 プレゼント', '父の日 贈り物'],
    include: ['父の日', 'ギフト', 'プレゼント', '贈り物', '名入れ', 'ラッピング', 'セット'],
    exclude: ['母の日', 'ホワイトデー', 'クリスマス', 'バレンタイン'],
    units: ['本', '足', '個', '枚', '組', 'セット'],
    minScore: 3,
  },
  'bath-additive': {
    keywords: ['入浴剤', 'バスクリン 入浴剤', 'バブ 入浴剤'],
    include: ['入浴剤', 'バスクリン', 'バブ', 'きき湯', 'バスロマン', 'バスソルト', '温泡'],
    exclude: ['ボディソープ', 'シャンプー', '洗剤', '追い焚き配管', '風呂釜'],
    units: ['包', '錠', '個', 'g'],
  },
  'bathroom-cleaner': {
    keywords: ['お風呂用洗剤', '浴室洗剤', 'カビ取り剤'],
    include: ['お風呂用', '浴室', 'バスクリーナー', 'バスマジックリン', 'カビキラー', 'カビ取り', '防カビ'],
    exclude: ['トイレ', 'キッチン', '洗濯槽', '排水口専用', 'スポンジ', 'ブラシ'],
    units: ['ml', 'g', '個'],
  },
  'cooking-pot': {
    keywords: ['IH対応 一人用鍋', '一人用鍋 16cm', '一人用鍋 18cm'],
    include: ['鍋', '片手鍋', '両手鍋', '土鍋', 'IH対応', '一人用', '16cm', '18cm'],
    exclude: ['鍋つかみ', '鍋敷き', 'ふたのみ', '蓋のみ', 'ラック', '収納'],
  },
  'deodorant': {
    keywords: ['制汗剤', 'デオドラント', '制汗スプレー'],
    include: ['制汗', 'デオドラント', 'ワキ', '脇', '汗', 'ニオイ', 'Ag', 'Ban'],
    exclude: ['消臭剤', '芳香剤', '衣類', '靴', 'ペット', '部屋', 'トイレ'],
    units: ['g', 'ml', '本', '個'],
  },
  'diaper': {
    keywords: ['紙おむつ テープ', 'おむつ テープ M', 'パンパース テープ'],
    include: ['おむつ', 'オムツ', '紙おむつ', 'テープ', 'パンパース', 'メリーズ', 'ムーニー', 'グーン'],
    exclude: ['パンツタイプ', 'パンツ型', 'おしりふき', '尿とりパッド', '大人用', 'ペット'],
    units: ['枚', '個'],
  },
  'dishwasher-detergent': {
    keywords: ['食洗機用洗剤', '食器洗い乾燥機 洗剤', '食洗機 タブレット'],
    include: ['食洗機', '食器洗い乾燥機', 'フィニッシュ', 'ジョイ ジェルタブ', 'クリスタ', 'キュキュット'],
    exclude: ['手洗い', '食器用洗剤', 'スポンジ', '庫内クリーナー', '洗濯'],
    units: ['g', 'ml', '個', '錠', '粒'],
  },
  'disposable-gloves': {
    keywords: ['使い捨て手袋', 'ニトリル手袋', 'ポリエチレン手袋'],
    include: ['使い捨て手袋', 'ニトリル', 'ビニール手袋', 'ポリエチレン手袋', 'PVC手袋', '手袋'],
    exclude: ['軍手', 'ゴム手袋 厚手', '作業用', '防寒', 'インナー', 'ホルダー'],
    units: ['枚'],
  },
  'fabric-softener': {
    keywords: ['柔軟剤', '無添加 柔軟剤', '赤ちゃん 柔軟剤'],
    include: ['柔軟剤', 'ソフラン', 'レノア', 'ハミング', 'さらさ', 'ファーファ', 'ランドリン'],
    exclude: ['洗剤', '漂白剤', 'ビーズ', '消臭スプレー', 'シート', '精油', 'エッセンシャルオイル', 'アロマオイル'],
    units: ['ml', '個'],
  },
  'face-wash': {
    keywords: ['洗顔料', '洗顔フォーム', '洗顔ジェル'],
    include: ['洗顔', '洗顔料', '洗顔フォーム', '洗顔ジェル', 'フェイスウォッシュ'],
    exclude: ['クレンジング', 'メイク落とし', 'ボディソープ', 'シャンプー', '泡立てネット', 'ブラシ'],
    units: ['g', 'ml', '個'],
  },
  'floor-cleaner': {
    keywords: ['フローリングシート', '床拭きシート', 'クイックルワイパー シート'],
    include: ['フローリングシート', '床拭き', 'ワイパーシート', 'クイックル', 'ウェットシート', 'ドライシート'],
    exclude: ['本体', 'ワイパー本体', 'モップ本体', 'トイレ', '車'],
    units: ['枚'],
  },
  'hair-treatment': {
    keywords: ['ヘアトリートメント', '洗い流すトリートメント', 'ヘアマスク'],
    include: ['トリートメント', 'ヘアマスク', 'ヘアパック', 'コンディショナー', 'リンス'],
    exclude: ['シャンプーのみ', 'ボディソープ', '洗顔', 'ブラシ', 'カラー剤'],
    units: ['ml', 'g', '個'],
  },
  'hand-cream': {
    keywords: ['ハンドクリーム', '薬用 ハンドクリーム', '保湿 ハンドクリーム'],
    include: ['ハンドクリーム', 'ハンドケア', '手荒れ', '保湿クリーム'],
    exclude: ['フェイス', 'ボディ', 'リップ', '日焼け止め', '除菌ジェル'],
    units: ['g', 'ml', '個'],
  },
  'kitchen-bleach': {
    keywords: ['キッチン漂白剤', 'キッチンハイター', '台所用漂白剤'],
    include: ['キッチンハイター', 'キッチン漂白', '台所用漂白', '漂白剤', '除菌漂白'],
    exclude: ['洗濯', '衣料', 'トイレ', 'カビ取り', '風呂', '洗濯槽'],
    units: ['ml', 'g', '個'],
  },
  'cooking-sheet': {
    keywords: ['クッキングシート ロール', 'オーブンシート ロール', 'クッキングシート 業務用'],
    include: ['クッキングシート', 'オーブンシート', 'ベーキングシート', 'クッキングペーパー'],
    exclude: ['ホルダー', 'ケース', 'スタンド', '収納', 'マット', '繰り返し', '洗える', 'せいろ', 'エアフライヤー', '天板', 'mm'],
    units: ['m'],
    requiredGroups: [['m']],
  },
  'kitchen-paper': {
    keywords: ['キッチンペーパー', 'キッチンタオル', 'ペーパータオル キッチン'],
    include: ['キッチンペーパー', 'キッチンタオル', 'ペーパータオル', 'クッキングペーパー'],
    exclude: ['ホルダー', 'ケース', 'ティッシュ', 'トイレット', '布巾', 'ふきん'],
    units: ['枚', 'ロール', '個'],
  },
  'kitchen-sponge': {
    keywords: ['食器用スポンジ', 'キッチンスポンジ', 'スポンジ 食器洗い'],
    include: ['食器用スポンジ', 'キッチンスポンジ', 'スポンジ', 'スコッチブライト', 'キクロン'],
    exclude: ['メイク', '洗車', '風呂', 'トイレ', 'ホルダー', 'ラック'],
    units: ['個'],
  },
  'lint-roller': {
    keywords: ['粘着クリーナー', 'コロコロ スペアテープ', '粘着ローラー'],
    include: ['粘着クリーナー', '粘着ローラー', 'コロコロ', 'スペアテープ', 'カーペットクリーナー'],
    exclude: ['本体のみ', 'ケース', '収納', '掃除機', '洋服ブラシ'],
    units: ['巻', '個', '本'],
  },
  'mask': {
    keywords: ['使い捨てマスク', '不織布マスク', 'マスク 50枚'],
    include: ['マスク', '不織布', '使い捨て', 'サージカル'],
    exclude: ['シートマスク', 'フェイスマスク', '美容', 'ケース', 'ストラップ', '洗える'],
    units: ['枚'],
  },
  'moisture-absorber': {
    keywords: ['除湿剤', '湿気取り', '水とりぞうさん'],
    include: ['除湿剤', '湿気取り', '除湿', '水とりぞうさん', 'ドライペット'],
    exclude: ['除湿機', '乾燥機', '衣類乾燥', '炭八', 'ケース'],
    units: ['ml', 'g', '個'],
  },
  'moth-repellent': {
    keywords: ['衣類防虫剤', '防虫剤 クローゼット', 'ムシューダ'],
    include: ['防虫剤', '衣類防虫', 'ムシューダ', 'ミセスロイド', 'クローゼット', 'タンス'],
    exclude: ['虫よけ', '蚊', 'ゴキブリ', '園芸', '殺虫剤'],
    units: ['個', '包'],
  },
  'mouthwash': {
    keywords: ['マウスウォッシュ', '洗口液', '液体歯磨き'],
    include: ['マウスウォッシュ', '洗口液', '液体歯磨き', 'リステリン', 'モンダミン', 'GUM'],
    exclude: ['歯磨き粉', '歯ブラシ', 'デンタルフロス', '口腔洗浄器'],
    units: ['ml', '個'],
  },
  'rice': {
    keywords: ['米 5kg', '無洗米 5kg', 'コシヒカリ 5kg'],
    include: ['米', '無洗米', '白米', '玄米', 'コシヒカリ', 'あきたこまち', 'ひとめぼれ'],
    exclude: ['米びつ', 'パックご飯', 'レトルト', '米粉', '雑穀のみ'],
    units: ['kg', 'g'],
  },
  'room-deodorizer': {
    keywords: ['消臭剤 部屋', '置き型 消臭剤', '芳香消臭剤'],
    include: ['消臭剤', '芳香剤', '消臭', '脱臭', '置き型', 'お部屋'],
    exclude: ['制汗剤', '衣類スプレー', 'トイレ用', '車用', '靴用', 'ペット専用'],
    units: ['ml', 'g', '個'],
  },
  'sanitary-napkin': {
    keywords: ['生理用ナプキン', 'ナプキン 羽つき', '夜用 ナプキン'],
    include: ['ナプキン', '生理用', '羽つき', '羽なし', 'ロリエ', 'ソフィ', 'エリス'],
    exclude: ['布ナプキン', '尿もれ', 'おりものシート', 'ライナー', '収納'],
    units: ['枚', '個'],
  },
  'sanitizing-spray': {
    keywords: ['除菌スプレー', '消臭スプレー 衣類', '布用 消臭スプレー'],
    include: ['除菌スプレー', '消臭スプレー', 'ファブリーズ', 'リセッシュ', '除菌', '消臭', '布用', '衣類'],
    exclude: ['制汗', '芳香剤', 'トイレ用', '車用', '虫よけ', 'マスクスプレー'],
    units: ['ml', '個'],
  },
  'sunscreen': {
    keywords: ['日焼け止め', 'UVジェル', 'UVミルク'],
    include: ['日焼け止め', 'UV', 'SPF', 'PA', 'サンスクリーン'],
    exclude: ['ファンデーション', '化粧下地のみ', '帽子', 'アームカバー', 'サングラス'],
    units: ['ml', 'g', '個'],
  },
  'toilet-cleaner': {
    keywords: ['トイレ用洗剤', 'トイレ洗剤', 'トイレクリーナー'],
    include: ['トイレ用', 'トイレ洗剤', 'トイレクリーナー', 'スクラビングバブル', 'ドメスト'],
    exclude: ['お風呂', 'キッチン', '洗濯', 'ブラシ', 'シート', '便座カバー'],
    units: ['ml', 'g', '個'],
  },
  'toothpaste': {
    keywords: ['歯磨き粉', '歯ブラシ', '子ども 歯磨き粉'],
    include: ['歯磨き粉', '歯みがき粉', '歯ブラシ', 'こども歯磨き', '子ども歯磨き', 'フッ素', 'ハミガキ'],
    exclude: ['マウスウォッシュ', 'デンタルフロス', '歯間ブラシ', 'ホルダー', 'スタンド'],
    units: ['g', '本', '個'],
  },
  'washing-machine-cleaner': {
    keywords: ['洗濯槽クリーナー', '洗濯槽洗浄剤', '洗たく槽クリーナー'],
    include: ['洗濯槽クリーナー', '洗濯槽', '洗たく槽', '槽洗浄', 'カビ取り'],
    exclude: ['洗濯洗剤', '柔軟剤', '衣料用漂白剤', '排水口', '風呂釜'],
    units: ['g', 'ml', '個'],
  },
  'wrap-foil': {
    keywords: ['クレラップ 50m', 'サランラップ 50m', 'アルミホイル 25m'],
    include: ['クレラップ', 'サランラップ', 'ポリラップ', '食品ラップ', 'キッチンラップ', 'ラップフィルム', 'アルミホイル', 'キッチンホイル'],
    exclude: [
      'ホルダー',
      'ケース',
      'カッター',
      '収納',
      'ラック',
      'ストッカー',
      'ティッシュ',
      'バッグ',
      'ストックバッグ',
      'フリーザーバッグ',
      'ジッパーバッグ',
      'ポリ袋',
      '鞄',
      'かばん',
      'ネイル',
      'ジェル',
      'リムーバー',
      'コットン',
    ],
    units: ['m'],
  },
  'contact-lens': {
    keywords: ['コンタクトレンズ洗浄液', 'コンタクト 洗浄液', 'コンタクト 保存液'],
    include: ['コンタクト', '洗浄液', '保存液'],
    exclude: ['カラコン', 'レンズ 1day', 'ケースのみ'],
    units: ['ml'],
  },
  'cotton': {
    keywords: ['化粧用コットン', 'コットンパッド', 'スキンケア コットン'],
    include: [
      '化粧用',
      'コットンパッド',
      'コットン パッド',
      'コットンパフ',
      'カット綿',
      'カットメン',
      'フェイシャルコットン',
      'ビューティーアップコットン',
      'ナチュラルパフ',
      'スキンケア',
      '化粧水',
      'ふきとり',
      '拭き取り',
      'ふくだけコットン',
      'シルコット',
      'ビオレ',
    ],
    exclude: [
      'ショーツ',
      '下着',
      'インナー',
      'パンツ',
      'トランクス',
      'タンクトップ',
      '布ナプキン',
      'ナプキン',
      'ライナー',
      'おりもの',
      'サニタリー',
      'タオル',
      '布団',
      'ガーゼケット',
      'ヘアバンド',
      'ヘッドバンド',
      'ヘアターバン',
      'ターバン',
      'ヘアアクセ',
      '白髪隠し',
      '汗止め',
      'マフラー',
      'ストール',
      '腹巻',
      'ブラ',
      'キャミ',
      '敷き布団',
      '掛け布団',
      '枕',
    ],
    units: ['枚'],
    minScore: 5,
  },
  'tea-bag': {
    keywords: ['麦茶 ティーバッグ まとめ買い', '麦茶 パック 大容量', '緑茶 ティーバッグ まとめ買い'],
    include: ['麦茶', 'むぎ茶', '緑茶', 'ティーバッグ', 'ティーパック', 'お茶 パック'],
    exclude: ['ペットボトル', '缶', 'インスタント', '粉末', 'スティック', '急須', 'ポット', 'ケトル', '茶葉 缶', 'ティーバッグケース'],
    units: ['袋', '個', 'パック'],
  },
  // ドライドッグフード本体のみを対象。おやつ・サプリ・ウェットフード・猫用を除外する
  // ブランド名商品（アイムス・ロイヤルカナン等）は "ドッグフード" を含まない名前が多いため requireInclude: false
  // units 制限なし: まとめ買いセットは "3袋" 等の単位で抽出されるため g/kg のみでは候補が全滅する
  'dog-food': {
    keywords: ['ドッグフード ドライ 成犬用 まとめ買い', 'ドッグフード 大容量 全犬種', 'ドライドッグフード 成犬 総合栄養食'],
    include: ['ドッグフード', 'ドックフード', '犬のえさ', '犬の餌', '犬用フード', 'ドライフード', 'ペットフード'],
    exclude: ['キャット', '猫', 'ウェット', '缶詰', 'パウチ', 'おやつ', 'スナック', 'トリーツ', 'サプリ', '療法食', 'スープ', 'おもちゃ', 'シャンプー', '首輪'],
    requireInclude: false,
  },
  // 乾電池・充電池本体のみを対象。「乾電池式」「電池使用」と記載した周辺機器を除外する
  'battery': {
    keywords: ['アルカリ乾電池 単3 まとめ買い', '単4 アルカリ乾電池 セット', 'ニッケル水素 充電池 単3'],
    include: ['乾電池', 'アルカリ電池', '充電池', 'ニッケル水素', 'マンガン電池', 'リチウム電池'],
    exclude: [
      // 乾電池を使う機器本体（電池ではなく電池使用デバイス）
      'ラジオ', 'ヘッドライト', 'ヘッドランプ', '懐中電灯', 'ランタン',
      'クリーナー', '掃除機', 'ミル', 'スピーカー', 'カメラ',
      'おもちゃ', 'ゲーム機', '充電器', 'チャージャー',
      // 機器の電源種別を示す修飾語
      '乾電池式', '電池式', '乾電池使用',
      // 電池ではない充電関連製品
      'ソーラー',
    ],
    units: ['本'],
    // 電池タイプ語のいずれかが必須（「電池使用」デバイスの名前にも出現するが、excludeで先に除外する）
    requiredGroups: [['乾電池', '充電池', 'アルカリ電池', 'ニッケル水素', 'マンガン電池']],
  },
  'drain-net': {
    keywords: ['水切りネット 排水口', '排水口ネット まとめ買い', 'ストッキング水切り袋 浅型'],
    include: ['水切りネット', '排水口ネット', '水切り袋', 'ストッキングネット', '生ごみネット', '生ゴミネット'],
    exclude: ['水切りかご', '水切りラック', '水切りプレート', '水切りスタンド', '排水口カバー', '排水口フィルター 洗濯機', 'ゴミ箱', '三角コーナー本体', 'シンクラック'],
    units: ['枚'],
    requiredGroups: [['水切りネット', '水切り袋', '排水口ネット', 'ストッキングネット', '生ごみネット', '生ゴミネット']],
  },
  'laundry-net': {
    keywords: ['洗濯ネット まとめ買い', '洗濯ネット セット 大中小', 'ランドリーネット コスパ', '洗濯ネット 角型 細目', '洗濯ネット ブラジャー 専用', '洗濯ネット おしゃれ着 セット'],
    include: ['洗濯ネット', 'ランドリーネット', '洗濯袋'],
    exclude: ['洗濯槽クリーナー', '洗濯ばさみ', '洗濯板', 'ランドリーバスケット', 'ランドリーボックス', 'ランドリーラック', '洗濯洗剤', '洗濯ハンガー', '物干し', '水切りネット', '水切り袋', '靴用', '靴洗い', 'シューズ'],
    units: ['枚', '個'],
    requiredGroups: [['洗濯ネット', 'ランドリーネット', '洗濯袋']],
  },
  'pet-sheet': {
    keywords: ['ペットシーツ まとめ買い', 'ペットシート 大容量', 'トイレシート 犬 猫'],
    include: ['ペットシーツ', 'ペットシート', 'トイレシート', 'トイレシーツ'],
    exclude: ['トイレトレー', 'トイレマット', 'シーツカバー', 'ホルダー'],
    units: ['枚'],
  },
};

const DEFAULT_EXCLUDE_TERMS = ['ケースのみ', 'ホルダー', 'スタンド', '収納', '詰め替え容器', 'ディスペンサー'];
const DIAPER_ACCESSORY_EXCLUDE_TERMS = [
  'おむつカバー',
  'オムツカバー',
  '布おむつ',
  '布オムツ',
  'カバー',
  'マジックテープ',
  'トレーニングパンツ',
  'トレパン',
  'おねしょ',
  '防水',
  'ロンパース',
  '服',
  '試供品',
  '試着',
  'お試し',
  'お試しセット',
  '初回購入限定',
];

function getArticleSpecificAdditionRule(category, baseKeyword) {
  if (category === 'toilet-cleaner' && /掃除シート|クリーナーシート|お掃除シート/.test(baseKeyword)) {
    return {
      keywords: ['トイレ掃除シート', '流せる トイレクリーナー シート', 'ミチガエル トイレクリーナー'],
      include: ['トイレ掃除', 'トイレクリーナー', 'トイレ用', 'トイレクイックル', 'ミチガエル', 'クリンぱ'],
      requiredGroups: [['シート']],
      exclude: ['ペット', '犬', '猫', 'おしりふき', '尿とり', '介護', '便座カバー', 'ブラシ', 'スプレー', '液体', '洗剤'],
      units: ['枚', '個', 'パック'],
      minScore: 4,
    };
  }

  if (category === 'toilet-paper' && /シングル/.test(baseKeyword)) {
    return {
      keywords: ['トイレットペーパー シングル', 'トイレットロール シングル', 'シングル 長尺 トイレットペーパー'],
      include: ['トイレット', 'トイレットペーパー', 'トイレットティシュー', 'トイレットロール', 'ロール'],
      requiredGroups: [['シングル']],
      exclude: ['ダブル', '2枚重ね', '二枚重ね', 'ホルダー', '収納', 'ケース', 'カバー', '芯棒'],
      units: ['m', 'ロール'],
      minScore: 4,
    };
  }

  if (category === 'toilet-paper' && /ダブル/.test(baseKeyword)) {
    return {
      keywords: ['トイレットペーパー ダブル', 'トイレットロール ダブル', 'ダブル 長尺 トイレットペーパー'],
      include: ['トイレット', 'トイレットペーパー', 'トイレットティシュー', 'トイレットロール', 'ロール'],
      requiredGroups: [['ダブル']],
      exclude: ['シングル', '1枚重ね', '一枚重ね', 'ホルダー', '収納', 'ケース', 'カバー', '芯棒'],
      units: ['m', 'ロール'],
      minScore: 4,
    };
  }

  if (category === 'conditioner') {
    return {
      keywords: ['コンディショナー', 'リンス', 'ヘアコンディショナー'],
      include: ['コンディショナー', 'リンス', 'トリートメント'],
      exclude: [
        'シャンプー&', 'シャンプー＋', 'シャンプーと', 'シャンプーに混ぜる',
        'シャンプー', 'ボディソープ', 'ボディウォッシュ', 'ディスペンサー',
        'ブラシ', 'ヘッドスパ', '美容液', 'ヘアブースター', 'ヘアマスク',
        'セット', '詰め合わせ', 'トライアル', 'サンプル', 'お試し', '試供品',
        'リンス不要', '混ぜる',
      ],
      units: ['ml', 'g'],
      minScore: 4,
    };
  }

  if (category === 'diaper' && /新生児/.test(baseKeyword)) {
    return {
      keywords: ['新生児 おむつ テープ', '紙おむつ 新生児', 'パンパース 新生児 テープ'],
      include: ['おむつ', 'オムツ', '紙おむつ', 'テープ', 'パンパース', 'メリーズ', 'ムーニー', 'グーン'],
      requiredGroups: [['新生児', 'nb', '5kg', '5000g'], ['テープ']],
      exclude: [...DIAPER_ACCESSORY_EXCLUDE_TERMS, 'Sサイズ', 'Mサイズ', 'Lサイズ', 'BIG', 'ビッグ', 'パンツタイプ', 'パンツ型', 'おしりふき', '尿とりパッド', '大人用', '介護', 'ペット'],
      units: ['枚', '個'],
      minScore: 3,
    };
  }

  if (category === 'diaper' && /Sサイズ|S サイズ/.test(baseKeyword)) {
    return {
      keywords: ['Sサイズ おむつ テープ', '紙おむつ S テープ', 'パンパース S テープ'],
      include: ['おむつ', 'オムツ', '紙おむつ', 'テープ', 'パンパース', 'メリーズ', 'ムーニー', 'グーン'],
      requiredGroups: [['Sサイズ', 'S サイズ', 'テープ S', 'S テープ'], ['テープ']],
      exclude: [...DIAPER_ACCESSORY_EXCLUDE_TERMS, '新生児', 'NB', 'Mサイズ', 'Lサイズ', 'BIG', 'ビッグ', 'パンツタイプ', 'パンツ型', 'おしりふき', '尿とりパッド', '大人用', '介護', 'ペット'],
      units: ['枚', '個'],
      minScore: 3,
    };
  }

  if (category === 'diaper' && /Mサイズ|M サイズ/.test(baseKeyword)) {
    return {
      keywords: ['Mサイズ おむつ テープ', '紙おむつ M テープ', 'パンパース M テープ'],
      include: ['おむつ', 'オムツ', '紙おむつ', 'テープ', 'パンパース', 'メリーズ', 'ムーニー', 'グーン'],
      requiredGroups: [['Mサイズ', 'M サイズ', 'テープ M', 'M テープ'], ['テープ']],
      exclude: [...DIAPER_ACCESSORY_EXCLUDE_TERMS, '新生児', 'NB', 'Sサイズ', 'Lサイズ', 'BIG', 'ビッグ', 'パンツタイプ', 'パンツ型', 'おしりふき', '尿とりパッド', '大人用', '介護', 'ペット'],
      units: ['枚', '個'],
      minScore: 3,
    };
  }

  if (category === 'diaper' && /パンツ/.test(baseKeyword)) {
    return {
      keywords: ['パンツ おむつ M', 'パンツ おむつ L', 'パンツ おむつ BIG'],
      include: ['おむつ', 'オムツ', '紙おむつ', 'パンツ', 'パンツタイプ', 'パンツ型', 'パンパース', 'メリーズ', 'ムーニー', 'グーン'],
      requiredGroups: [['パンツ', 'パンツタイプ', 'パンツ型']],
      exclude: [...DIAPER_ACCESSORY_EXCLUDE_TERMS, 'テープ', 'テープタイプ', '新生児', 'おしりふき', '尿とりパッド', '大人用', '介護', 'ペット'],
      units: ['枚', '個'],
      minScore: 3,
    };
  }

  if (category === 'diaper' && /BIG|ビッグ|スーパービッグ/.test(baseKeyword)) {
    return {
      keywords: ['BIG おむつ', 'ビッグ おむつ', 'スーパービッグ おむつ'],
      include: ['おむつ', 'オムツ', '紙おむつ', 'BIG', 'ビッグ', 'スーパービッグ', 'パンパース', 'メリーズ', 'ムーニー', 'グーン'],
      requiredGroups: [['BIG', 'ビッグ', 'スーパービッグ']],
      exclude: [...DIAPER_ACCESSORY_EXCLUDE_TERMS, '新生児', 'Sサイズ', 'Mサイズ', 'おしりふき', '尿とりパッド', '大人用', '介護', 'ペット'],
      units: ['枚', '個'],
      minScore: 3,
    };
  }

  if (category === 'wrap-foil' && /保存袋|フリーザーバッグ|ストックバッグ|ジッパーバッグ/.test(baseKeyword)) {
    return {
      keywords: ['フリーザーバッグ', '保存袋', 'ジッパーバッグ'],
      include: ['フリーザーバッグ', '保存袋', 'ストックバッグ', 'ジッパーバッグ', 'ジップロック', 'ポリ袋', '食品保存袋'],
      exclude: ['ラップホルダー', 'ラップケース', 'アルミホイル', 'クッキングシート', 'ゴミ袋', 'レジ袋', '衣類圧縮'],
      units: ['枚', '個'],
      minScore: 4,
    };
  }

  if (category === 'tissue-paper' && /ウェットティッシュ|ウエットティッシュ|除菌シート|手口ふき/.test(baseKeyword)) {
    return {
      keywords: ['ウェットティッシュ まとめ買い', '除菌ウェットティッシュ', 'ノンアルコール ウェットティッシュ'],
      include: ['ウェットティッシュ', 'ウエットティッシュ', '除菌シート', '手口ふき', 'おしりふき', 'ウェットシート'],
      exclude: ['ティッシュペーパー', '箱ティッシュ', 'ソフトパックティッシュ', 'ボックスティッシュ'],
      units: ['枚', '個', 'パック'],
      minScore: 3,
    };
  }

  if (category === 'pet-sheet' && /レギュラー/.test(baseKeyword)) {
    return {
      keywords: ['ペットシーツ レギュラー まとめ買い', 'ペットシート レギュラー 大容量', 'トイレシート レギュラー 犬 猫'],
      include: ['ペットシーツ', 'ペットシート', 'トイレシート', 'トイレシーツ'],
      requiredGroups: [['レギュラー']],
      exclude: ['ワイドのみ', 'スーパーワイドのみ', 'ダブルワイドのみ', 'トイレトレー', 'トイレマット', 'シーツカバー', 'ホルダー'],
      units: ['枚'],
      minScore: 4,
    };
  }

  if (category === 'toothpaste' && /デンタルフロス|フロス|歯間ブラシ|糸ようじ/.test(baseKeyword)) {
    return {
      keywords: ['デンタルフロス', 'フロスピック 100本', 'ウルトラフロス 30本'],
      include: [
        'デンタルフロス',
        'フロス',
        'フロスピック',
        '糸ようじ',
        '糸ピックス',
        '歯間ブラシ',
        '歯間清掃',
        'ウルトラフロス',
        'フロアフロス',
        'fluorfloss',
      ],
      exclude: [
        '歯ブラシ',
        '歯磨き粉',
        '歯みがき粉',
        'ジェットウォッシャー',
        '口腔洗浄器',
        '口腔洗浄機',
        'マウスウォッシャー',
        'ウォーターフロス',
        '電動フロス',
        'スタンド',
        'ケース',
        '収納',
      ],
      units: ['本', 'm', '個'],
      minScore: 4,
    };
  }

  // 敏感肌・赤ちゃん向け柔軟剤記事の専用ルール
  // fabric-softener カテゴリのうち「敏感肌/低刺激/赤ちゃん」をテーマにした記事向け。
  // デフォルトの fabric-softener ルールでは精油・アロマオイルや一般柔軟剤（ダウニー等）が
  // 混入するため、include/exclude をより厳格にする。
  if (category === 'fabric-softener' && /敏感肌|低刺激|赤ちゃん/.test(baseKeyword)) {
    return {
      keywords: ['無添加 柔軟剤', '敏感肌 柔軟剤', '赤ちゃん 柔軟剤'],
      include: ['柔軟剤', 'ファーファ', 'ランドリン', 'さらさ', '無添加', '低刺激', '赤ちゃん', 'ベビー', '敏感肌'],
      exclude: [
        '洗剤', '漂白剤', 'ビーズ', '消臭スプレー', 'シート',
        '精油', 'エッセンシャルオイル', 'アロマオイル',
        'ダウニー',
      ],
      units: ['ml', '個'],
      minScore: 4,
    };
  }

  return null;
}

function uniqueStrings(values) {
  return [...new Set(values.map(v => String(v ?? '').trim()).filter(Boolean))];
}

function getAdditionSearchRule(category, baseKeyword) {
  const rule = getArticleSpecificAdditionRule(category, baseKeyword) ?? CATEGORY_SEARCH_RULES[category] ?? {};
  const keywords = uniqueStrings([
    ...(rule.keywords ?? []),
    baseKeyword,
    `${baseKeyword} 大容量`,
    `${baseKeyword} まとめ買い`,
  ]).slice(0, 3);

  return {
    keywords,
    include: rule.include ?? [baseKeyword],
    exclude: [...DEFAULT_EXCLUDE_TERMS, ...(rule.exclude ?? [])],
    units: rule.units ?? null,
    minScore: rule.minScore ?? 4,
    requireInclude: rule.requireInclude ?? true,
    requiredGroups: rule.requiredGroups ?? [],
  };
}

function isAllowedCapacityUnit(capacity, rule) {
  if (!rule.units) return true;
  const parsed = extractCapacityTotal(capacity);
  if (!parsed) return false;
  return rule.units.some(unit => unit.toLowerCase() === parsed.unit.toLowerCase());
}

function candidateText(candidate) {
  return String(candidate.name ?? '').normalize('NFKC').toLowerCase();
}

function normalizedTerm(term) {
  return String(term ?? '').normalize('NFKC').toLowerCase();
}

function findTermHits(text, terms) {
  return terms.filter(term => text.includes(normalizedTerm(term)));
}

function findRequiredGroupHits(text, groups = []) {
  return groups.map(group => ({
    group,
    hits: findTermHits(text, group),
  }));
}

function checkAdditionCandidateCategory(candidate, rule) {
  const text = candidateText(candidate);
  const includeHits = findTermHits(text, rule.include);
  const excludeHits = findTermHits(text, rule.exclude);
  const requiredGroupHits = findRequiredGroupHits(text, rule.requiredGroups);

  if (excludeHits.length > 0) {
    return { ok: false, reason: `除外語: ${excludeHits.slice(0, 3).join(', ')}` };
  }
  const missingRequired = requiredGroupHits.find(group => group.hits.length === 0);
  if (missingRequired) {
    return { ok: false, reason: `必須語なし: ${missingRequired.group.slice(0, 3).join('/')}` };
  }
  if (rule.requireInclude && includeHits.length === 0) {
    return { ok: false, reason: 'カテゴリ語なし' };
  }

  return { ok: true, reason: null };
}

function getAdditionCandidateDiagnostics(candidate, rule) {
  const text = candidateText(candidate);
  return {
    includeHits: findTermHits(text, rule.include),
    excludeHits: findTermHits(text, rule.exclude),
    requiredGroupHits: findRequiredGroupHits(text, rule.requiredGroups),
  };
}

function formatTermHits(label, hits) {
  return `${label}: ${hits.length > 0 ? hits.slice(0, 5).join(', ') : 'なし'}`;
}

function formatRequiredGroupHits(groups = []) {
  if (groups.length === 0) return '必須語: なし';
  return `必須語: ${groups.map(group => group.hits.length > 0 ? group.hits.slice(0, 2).join('|') : `未一致(${group.group.slice(0, 2).join('/')})`).join(' / ')}`;
}

function scoreAdditionCandidate(candidate, rule) {
  const text = candidateText(candidate);
  const reasons = [];
  let score = 0;

  const includeHits = findTermHits(text, rule.include);
  if (includeHits.length > 0) {
    score += 3 + Math.min(includeHits.length - 1, 2);
    reasons.push(`カテゴリ語: ${includeHits.slice(0, 3).join(', ')}`);
  }
  const requiredGroupHits = findRequiredGroupHits(text, rule.requiredGroups);
  for (const group of requiredGroupHits) {
    if (group.hits.length > 0) {
      score += 2;
      reasons.push(`必須語: ${group.hits.slice(0, 2).join(', ')}`);
    }
  }

  const excludeHits = findTermHits(text, rule.exclude);
  if (excludeHits.length > 0) {
    score -= 4 * excludeHits.length;
    reasons.push(`除外語: ${excludeHits.slice(0, 3).join(', ')}`);
  }

  if (candidate.price !== null) {
    score += 1;
    reasons.push('価格あり');
  }
  if ((candidate.reviewCount ?? 0) >= 1000) score += 3;
  else if ((candidate.reviewCount ?? 0) >= 300) score += 2;
  else if ((candidate.reviewCount ?? 0) >= 50) score += 1;

  if ((candidate.rating ?? 0) >= 4.5) score += 2;
  else if ((candidate.rating ?? 0) >= 4.0) score += 1;

  return { score, reasons };
}

function buildExcludedCandidatesSection(excludedCandidates) {
  if (excludedCandidates.length === 0) return '';

  let section = `\n#### 除外候補サンプル（ロジック見直し用）\n`;
  for (const item of excludedCandidates) {
    section += `- 理由: ${item.reason} / 検索: ${item.sourceKeyword}`;
    if (item.capacity) section += ` / 容量: ${item.capacity}`;
    if (item.score !== null) section += ` / スコア: ${item.score}`;
    section += `\n`;
    if (item.includeHits || item.excludeHits || item.requiredGroupHits) {
      section += `  - 判定: ${formatTermHits('カテゴリ語', item.includeHits ?? [])} / ${formatTermHits('除外語', item.excludeHits ?? [])} / ${formatRequiredGroupHits(item.requiredGroupHits ?? [])}\n`;
    }
    section += `  - URL: ${item.url}\n`;
    section += `  - 商品名: ${item.name}\n`;
  }
  return section;
}

function normalizeProductIdentity(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　"'“”‘’`´【】\[\]（）()「」『』・･&＆/／\\|｜\-ー―＿_:：,，.。+＋]/g, '')
    .replace(/(送料無料|公式|正規品|楽天|ランキング|総合1位|期間限定|限定|訳あり|わけあり|大容量|詰め替え|詰替え|セット|まとめ買い|お徳用|お得用|セール|ポイント\d+倍|p\d+倍|off|円|税込|メール便|クーポン)/g, '')
    .replace(/\d+[,.]?\d*(ml|ｍｌ|g|ｇ|kg|ｋｇ|l|ｌ|個|本|袋|枚|包|錠|ロール|パック|セット)/g, '');
}

function extractProductWidthCm(name) {
  const match = String(name ?? '').normalize('NFKC').match(/(\d+(?:\.\d+)?)\s*cm/i);
  return match ? Number(match[1]) : null;
}

const PRODUCT_IDENTITY_STOP_TERMS = [
  'クレンジングオイル', 'クレンジングジェル', 'クレンジングバーム', 'クレンジングウォーター', 'クレンジングミルク', 'クレンジングクリーム',
  'クレンジング', 'メイク落とし', 'メーク落とし', '化粧落とし',
  'オイル', 'ジェル', 'バーム', 'ウォーター', 'ミルク', 'クリーム',
  'ボディソープ', 'ボディウォッシュ', 'シャンプー', 'コンディショナー', 'ハンドソープ',
  '洗剤', 'ティッシュ', 'トイレットペーパー', 'ロール',
];
const PRODUCT_IDENTITY_STOP_RE = new RegExp(
  PRODUCT_IDENTITY_STOP_TERMS
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g'
);

function productDistinctKey(key) {
  return key.replace(PRODUCT_IDENTITY_STOP_RE, '');
}

function productNameLooksSame(candidateKey, existingKey) {
  if (!candidateKey || !existingKey) return false;
  const candidateDistinctKey = productDistinctKey(candidateKey);
  const existingDistinctKey = productDistinctKey(existingKey);
  if (candidateDistinctKey.length < 4 || existingDistinctKey.length < 4) return false;
  if (candidateDistinctKey.includes(existingDistinctKey) || existingDistinctKey.includes(candidateDistinctKey)) return true;

  const grams = new Set();
  for (let i = 0; i <= existingDistinctKey.length - 4; i++) {
    grams.add(existingDistinctKey.slice(i, i + 4));
  }
  const hits = [...grams].filter(gram => candidateDistinctKey.includes(gram));
  const hitChars = hits.length * 4;
  return hits.length >= 2 && hitChars / existingDistinctKey.length >= 0.4;
}

function isSameProductDifferentUrl(candidateName, candidateCapacity, existingProducts) {
  const candidateKey = normalizeProductIdentity(candidateName);
  const candidateTotal = candidateCapacity ? extractCapacityTotal(candidateCapacity) : null;
  if (!candidateKey) return false;

  return existingProducts.some(product => {
    const existingKey = normalizeProductIdentity(product.name);
    if (!existingKey) return false;
    if (!productNameLooksSame(candidateKey, existingKey)) return false;

    const existingCapacity = product.capacity && product.capacity !== '-'
      ? product.capacity
      : extractCapacityFromItemName(product.name);
    const existingTotal = existingCapacity ? extractCapacityTotal(existingCapacity) : null;
    if (!candidateTotal || !existingTotal) return true;
    const candidateWidth = extractProductWidthCm(candidateName);
    const existingWidth = extractProductWidthCm(product.name);
    if (candidateWidth !== null && existingWidth !== null && candidateWidth !== existingWidth) return false;
    if (existingTotal.unit.toLowerCase() === candidateTotal.unit.toLowerCase() && existingTotal.total === candidateTotal.total) return true;

    return false;
  });
}

// ─── 商品追加候補レポート ─────────────────────────────────────────────────────
async function checkAdditions() {
  const articlesDir = resolve(process.cwd(), 'src/content/articles');
  const files = readdirSync(articlesDir)
    .filter(f => f.endsWith('.md'))
    .filter(f => matchesFileFilter(f));

  const today = new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const filterNote = CHECK_TARGET_COUNT !== null ? `、現在${CHECK_TARGET_COUNT}商品以下のみ対象` : '';
  console.log(`📊 商品追加候補チェック（目標: ${TARGET_COUNT}商品/記事${filterNote}）\n`);

  const sections = [];
  const urlSections = [];
  const noCandidateSections = [];
  const errorSections = [];
  let reachedTarget = 0;
  let needsAdditions = 0;
  let skippedByFilter = 0;

  for (const file of files) {
    const filePath = join(articlesDir, file);
    const content = readFileSync(filePath, 'utf-8');
    const products = extractAllProductsData(content);
    const title = extractArticleTitle(content);
    const category = extractArticleCategory(content) ?? file.replace(/-comparison\.md$/, '');
    const preferUnit = getArticleTargetUnit(basename(file, '.md'));

    if (products.length >= TARGET_COUNT) {
      reachedTarget++;
      console.log(`✅ ${file}: ${products.length}商品（スキップ）`);
      continue;
    }
    if (CHECK_TARGET_COUNT !== null && products.length > CHECK_TARGET_COUNT) {
      skippedByFilter++;
      console.log(`⏭ ${file}: ${products.length}商品（フィルタスキップ: ${CHECK_TARGET_COUNT}以下対象）`);
      continue;
    }

    needsAdditions++;
    const needed = TARGET_COUNT - products.length;
    const baseKeyword = buildArticleSearchKeyword(title ?? products[0]?.name ?? file);
    const searchRule = getAdditionSearchRule(category, baseKeyword);
    const articleFile = `src/content/articles/${file}`;
    const recentDeletedProducts = getRecentDeletedProductsForArticle(articleFile, today);
    console.log(`\n📄 ${file}: ${products.length}商品 → あと${needed}件必要（検索: "${searchRule.keywords.join('", "')}"）`);
    if (recentDeletedProducts.length > 0) {
      console.log(`   🧹 直近${RECENT_DELETED_DAYS}日以内の削除履歴: ${recentDeletedProducts.length}件`);
    }

    // 既存商品のURLセット（重複除外用）
    const existingUrls = new Set(
      products.map(p => toDirectItemUrl(p.rakutenUrl)).filter(Boolean)
    );

    try {
      const candidates = [];
      const seenCandidateUrls = new Set();
      for (const keyword of searchRule.keywords) {
        let fetched = [];
        try {
          fetched = await fetchRakutenSearchMany(keyword, 30);
        } catch (e) {
          console.log(`   ⚠ 検索失敗: "${keyword}" - ${e.message}`);
          continue;
        }
        for (const item of fetched) {
          const url = toDirectItemUrl(item.itemUrl) ?? toDirectItemUrl(item.affiliateUrl);
          const dedupeKey = url ?? normalizeProductIdentity(item.name);
          if (!dedupeKey || seenCandidateUrls.has(dedupeKey)) continue;
          seenCandidateUrls.add(dedupeKey);
          candidates.push({ ...item, sourceKeyword: keyword });
        }
        await new Promise(r => setTimeout(r, 500));
      }

      if (candidates.length === 0) {
        throw new Error('全検索キーワードで候補を取得できませんでした');
      }

      const stats = {
        fetched: candidates.length,
        duplicate: 0,
        sameProduct: 0,
        noUrl: 0,
        noCapacity: 0,
        noCapacityUsed: 0,
        badCapacityUnit: 0,
        recentDeleted: 0,
        lowScore: 0,
      };

      // 既存商品・URL不明を除外し、容量不明は必要件数に足りない場合だけ補完候補にする
      const validCandidates = [];
      const noCapacityCandidates = [];
      const excludedCandidates = [];
      const recordExcluded = (reason, candidate, extra = {}) => {
        if (excludedCandidates.length >= 20) return;
        const directUrl = extra.directUrl ?? toDirectItemUrl(candidate.itemUrl) ?? toDirectItemUrl(candidate.affiliateUrl) ?? candidate.itemUrl ?? candidate.affiliateUrl ?? '（URL取得不可）';
        const diagnostics = getAdditionCandidateDiagnostics(candidate, searchRule);
        excludedCandidates.push({
          reason,
          name: candidate.name,
          url: directUrl,
          capacity: extra.capacity ?? null,
          score: extra.score ?? null,
          sourceKeyword: candidate.sourceKeyword ?? '-',
          includeHits: diagnostics.includeHits,
          excludeHits: diagnostics.excludeHits,
          requiredGroupHits: diagnostics.requiredGroupHits,
        });
      };

      for (const c of candidates) {
        const directUrl = toDirectItemUrl(c.itemUrl) ?? toDirectItemUrl(c.affiliateUrl);
        if (!directUrl) {
          stats.noUrl++;
          recordExcluded('URL取得不可', c);
          continue;
        }
        if (existingUrls.has(directUrl)) {
          stats.duplicate++;
          recordExcluded('既存URL重複', c, { directUrl });
          continue;
        }
        const recentDeleted = findRecentDeletedProduct(directUrl, recentDeletedProducts);
        if (recentDeleted) {
          stats.recentDeleted++;
          recordExcluded(`直近削除履歴（${recentDeleted.deletedAt}にrank上限で削除）`, c, { directUrl });
          continue;
        }

        const categoryCheck = checkAdditionCandidateCategory(c, searchRule);
        if (!categoryCheck.ok) {
          stats.lowScore++;
          recordExcluded(`カテゴリ外（${categoryCheck.reason}）`, c, { directUrl });
          continue;
        }
        const capacity = extractCapacityFromItemName(c.name);
        if (capacity && !isAllowedCapacityUnit(capacity, searchRule)) {
          stats.badCapacityUnit++;
          recordExcluded('比較対象外の容量単位', c, { directUrl, capacity });
          continue;
        }
        if (isSameProductDifferentUrl(c.name, capacity, products)) {
          stats.sameProduct++;
          recordExcluded('URL違い同一商品', c, { directUrl, capacity });
          continue;
        }

        const scored = scoreAdditionCandidate(c, searchRule);
        if (scored.score < searchRule.minScore) {
          stats.lowScore++;
          recordExcluded('スコア不足', c, { directUrl, capacity, score: scored.score });
          continue;
        }

        if (!capacity) {
          stats.noCapacity++;
          noCapacityCandidates.push({
            ...c,
            directUrl,
            capacity: null,
            pricePerUnit: null,
            score: scored.score,
            scoreReasons: [...scored.reasons, '容量抽出不可の補完候補'],
            usedAsNoCapacityFallback: true,
          });
          continue;
        }

        const pricePerUnit = c.price !== null ? calcPricePerUnit(c.price, capacity, preferUnit) : null;
        validCandidates.push({ ...c, directUrl, capacity, pricePerUnit, score: scored.score, scoreReasons: scored.reasons });
      }

      const sortCandidates = (a, b) =>
        b.score - a.score ||
        (b.reviewCount ?? 0) - (a.reviewCount ?? 0) ||
        (b.rating ?? 0) - (a.rating ?? 0);
      validCandidates.sort(sortCandidates);
      noCapacityCandidates.sort(sortCandidates);
      const suggestions = validCandidates.slice(0, needed);
      if (suggestions.length < needed) {
        const fallbackSuggestions = noCapacityCandidates.slice(0, needed - suggestions.length);
        stats.noCapacityUsed = fallbackSuggestions.length;
        suggestions.push(...fallbackSuggestions);
      }

      if (suggestions.length === 0) {
        console.log(`   ⚠ 有効な新規候補が見つかりませんでした（容量不明候補: ${stats.noCapacity}件）`);
        noCandidateSections.push(
          `## ${file}\n\n` +
          `現在: ${products.length}商品 / あと${needed}件必要\n\n` +
          `検索キーワード: ${searchRule.keywords.map(k => `\`${k}\``).join(' / ')}\n\n` +
          `- 取得候補: ${stats.fetched}件\n` +
          `- 既存URL重複で除外: ${stats.duplicate}件\n` +
          `- URL違い同一商品で除外: ${stats.sameProduct}件\n` +
          `- URL取得不可で除外: ${stats.noUrl}件\n` +
          `- 容量抽出不可候補: ${stats.noCapacity}件\n` +
          `- 容量抽出不可で補完採用: ${stats.noCapacityUsed}件\n` +
          `- 比較対象外の容量単位で除外: ${stats.badCapacityUnit}件\n` +
          `- 直近削除履歴で除外: ${stats.recentDeleted}件\n` +
          `- スコア不足で除外: ${stats.lowScore}件\n` +
          `- 有効候補: ${validCandidates.length}件 / 容量抽出不可の補完候補: ${noCapacityCandidates.length}件\n` +
          buildExcludedCandidatesSection(excludedCandidates)
        );
        continue;
      }

      console.log(`   → ${suggestions.length}件の候補を取得（容量不明補完: ${stats.noCapacityUsed}件）`);

      let section = `## ${file}（現在: ${products.length}商品 → あと${needed}件必要）\n\n`;
      section += `検索キーワード: ${searchRule.keywords.map(k => `\`${k}\``).join(' / ')}\n\n`;
      section += `- 取得候補: ${stats.fetched}件\n`;
      section += `- 既存URL重複で除外: ${stats.duplicate}件\n`;
      section += `- URL違い同一商品で除外: ${stats.sameProduct}件\n`;
      section += `- URL取得不可で除外: ${stats.noUrl}件\n`;
      section += `- 容量抽出不可候補: ${stats.noCapacity}件\n`;
      section += `- 容量抽出不可で補完採用: ${stats.noCapacityUsed}件\n`;
      section += `- 比較対象外の容量単位で除外: ${stats.badCapacityUnit}件\n`;
      section += `- 直近削除履歴で除外: ${stats.recentDeleted}件\n`;
      section += `- スコア不足で除外: ${stats.lowScore}件\n`;
      section += `- 有効候補: ${validCandidates.length}件 / 容量抽出不可の補完候補: ${noCapacityCandidates.length}件\n\n`;

      for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        section += `### 候補${i + 1}: ${s.name}\n`;
        section += `- URL: ${s.directUrl}\n`;
        section += `- 価格: ¥${s.price?.toLocaleString() ?? '不明'}\n`;
        section += `- 抽出容量: ${s.capacity}\n`;
        section += `- 推定単価: ${s.pricePerUnit ?? '-'}\n`;
        section += `- 評価: ${s.rating ?? '-'}（${(s.reviewCount ?? 0).toLocaleString()}件）\n`;
        section += `- スコア: ${s.score}（検索: ${s.sourceKeyword}${s.scoreReasons.length ? ` / ${s.scoreReasons.join(' / ')}` : ''}）\n`;
        if (s.usedAsNoCapacityFallback) section += `- 容量抽出不可の補完採用\n`;
        const diagnostics = getAdditionCandidateDiagnostics(s, searchRule);
        section += `- 判定: ${formatTermHits('カテゴリ語', diagnostics.includeHits)} / ${formatTermHits('除外語', diagnostics.excludeHits)} / ${formatRequiredGroupHits(diagnostics.requiredGroupHits)}\n`;
        section += `\n`;
      }
      section += buildExcludedCandidatesSection(excludedCandidates);
      sections.push(section);

      let urlSection = `## src/content/articles/${file}（現在: ${products.length}商品 → あと${needed}件必要）\n`;
      for (const s of suggestions) {
        urlSection += `- ${s.directUrl} — ${s.name}\n`;
      }
      urlSections.push(urlSection);
    } catch (e) {
      console.log(`❌ ${e.message}`);
      errorSections.push(
        `## ${file}\n\n` +
        `現在: ${products.length}商品 / あと${needed}件必要\n\n` +
        `検索キーワード: ${searchRule.keywords.map(k => `\`${k}\``).join(' / ')}\n\n` +
        `- エラー: ${e.message}\n`
      );
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  // Markdown レポート出力
  const reportsDir = resolve(process.cwd(), 'reports/toAI/kura-article-add');
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

  const ts = Date.now();
  const outPath = join(reportsDir, `addition-candidates-${today}-${ts}.md`);
  const urlsOutPath = join(reportsDir, `addition-urls-${today}-${ts}.md`);
  const summary = sections.length > 0
    ? `追加候補あり記事: ${sections.length} 件`
    : needsAdditions === 0
      ? skippedByFilter > 0
        ? `> フィルタ（現在${CHECK_TARGET_COUNT}商品以下）に一致する記事はありませんでした。`
        : '> すべての記事が目標商品数に達しています。'
      : '> 目標未達の記事はありますが、有効な追加候補は見つかりませんでした。';
  const header = [
    `# 商品追加候補レポート`,
    ``,
    `生成日: ${today}`,
    `目標商品数: ${TARGET_COUNT}商品/記事`,
    ...(CHECK_TARGET_COUNT !== null ? [`チェック対象: 現在${CHECK_TARGET_COUNT}商品以下`] : []),
    `対象記事: ${files.length}件`,
    `目標達成済み: ${reachedTarget}件`,
    ...(CHECK_TARGET_COUNT !== null ? [`フィルタスキップ: ${skippedByFilter}件`] : []),
    `目標未達: ${needsAdditions}件`,
    `追加候補あり: ${sections.length}件`,
    `候補なし: ${noCandidateSections.length}件`,
    `取得失敗: ${errorSections.length}件`,
    ``,
    summary,
    ``,
    `---`,
    ``,
  ].join('\n');

  const reportSections = [
    sections.length > 0 ? `# 追加候補あり\n\n${sections.join('\n---\n\n')}` : '',
    noCandidateSections.length > 0 ? `# 候補なし\n\n${noCandidateSections.join('\n---\n\n')}` : '',
    errorSections.length > 0 ? `# 取得失敗\n\n${errorSections.join('\n---\n\n')}` : '',
  ].filter(Boolean);

  writeFileSync(outPath, header + reportSections.join('\n\n---\n\n'), 'utf-8');
  const urlHeader = [
    `# 商品追加用URLリスト`,
    ``,
    `生成日: ${today}`,
    `目標商品数: ${TARGET_COUNT}商品/記事`,
    ...(CHECK_TARGET_COUNT !== null ? [`チェック対象: 現在${CHECK_TARGET_COUNT}商品以下`] : []),
    ``,
    urlSections.length === 0
      ? '> 追加候補URLはありません。'
      : `追加候補あり記事: ${urlSections.length} 件`,
    ``,
    `---`,
    ``,
  ].join('\n');
  writeFileSync(urlsOutPath, urlHeader + urlSections.join('\n\n'), 'utf-8');
  console.log(`\n✅ レポート出力: ${outPath}`);
  console.log(`✅ 商品追加用URLリスト出力: ${urlsOutPath}`);
  console.log(`   追加候補あり記事: ${sections.length} 件`);
  console.log(`   候補なし: ${noCandidateSections.length} 件 / 取得失敗: ${errorSections.length} 件`);
}

// ─── 入れ替え候補レポート ───────────────────────────────────────────────────
/**
 * affiliateUrl / item.rakuten.co.jp URL を正規化して
 * https://item.rakuten.co.jp/{shopCode}/{itemCode}/ 形式で返す
 */
function toDirectItemUrl(url) {
  if (!url) return null;
  const parsed = parseRakutenItemUrl(url);
  if (parsed) return `https://item.rakuten.co.jp/${parsed.shopCode}/${parsed.itemCode}/`;
  // すでに item.rakuten.co.jp 形式ならそのまま
  try {
    const u = new URL(url);
    if (u.hostname === 'item.rakuten.co.jp') return url;
  } catch { /* ignore */ }
  return null;
}

async function checkReplacements() {
  const articlesDir = resolve(process.cwd(), 'src/content/articles');
  const files = readdirSync(articlesDir)
    .filter(f => f.endsWith('.md'))
    .filter(f => matchesFileFilter(f));

  const today = new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
  console.log(`📊 入れ替え候補チェック（閾値: ${THRESHOLD}倍以上）\n`);

  const sections = [];

  for (const file of files) {
    const filePath = join(articlesDir, file);
    const content = readFileSync(filePath, 'utf-8');
    const products = extractAllProductsData(content);

    if (products.length === 0) continue;

    console.log(`\n📄 ${file} (${products.length}商品)`);

    const candidates = [];

    for (const product of products) {
      const shortName = product.name.slice(0, 40);
      process.stdout.write(`   [${shortName}...] `);
      try {
        const data = await fetchRakutenSearch(product.name);

        const currentCount = product.reviewCount ?? 0;
        const candidateCount = data.reviewCount ?? 0;
        const ratio = currentCount > 0 ? candidateCount / currentCount : (candidateCount > 0 ? Infinity : 0);

        const isSameItem = (() => {
          const currentDirect = toDirectItemUrl(product.rakutenUrl);
          const candidateDirect = toDirectItemUrl(data.itemUrl);
          return currentDirect && candidateDirect && currentDirect === candidateDirect;
        })();

        if (!isSameItem && ratio >= THRESHOLD) {
          candidates.push({ current: product, candidate: data, ratio });
          console.log(`🔔 候補あり: ${candidateCount.toLocaleString()}件 (${ratio === Infinity ? '∞' : ratio.toFixed(1)}倍)`);
        } else {
          console.log(`  現在: ${currentCount.toLocaleString()}件 / 候補: ${candidateCount.toLocaleString()}件`);
        }
      } catch (e) {
        console.log(`❌ ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (candidates.length > 0) {
      let section = `## ${file}\n`;
      for (const { current, candidate, ratio } of candidates) {
        const currentUrl = toDirectItemUrl(current.rakutenUrl) ?? current.rakutenUrl;
        const candidateUrl = toDirectItemUrl(candidate.itemUrl) ?? candidate.itemUrl ?? '（URL取得不可）';
        const ratioStr = ratio === Infinity ? '∞' : `${ratio.toFixed(1)}倍`;
        section += `\n### ランク${current.rank}: ${current.name}\n`;
        section += `- 現在のレビュー数: ${(current.reviewCount ?? 0).toLocaleString()}件\n`;
        section += `- 現行URL: ${currentUrl}\n`;
        section += `\n**候補商品:** ${candidate.name}\n`;
        section += `- 候補のレビュー数: ${(candidate.reviewCount ?? 0).toLocaleString()}件（${ratioStr}）\n`;
        section += `- 候補URL: ${candidateUrl}\n`;
      }
      sections.push(section);
    }
  }

  // Markdown レポート出力
  const reportsDir = resolve(process.cwd(), 'reports');
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

  const outPath = join(reportsDir, `replacement-candidates-${today}.md`);
  const header = [
    `# 商品入れ替え候補レポート`,
    ``,
    `生成日: ${today}`,
    `閾値: 現在のレビュー数の ${THRESHOLD} 倍以上`,
    ``,
    sections.length === 0 ? '> 入れ替え候補はありませんでした。' : `候補あり記事: ${sections.length} 件`,
    ``,
    `---`,
    ``,
  ].join('\n');

  writeFileSync(outPath, header + sections.join('\n---\n\n'), 'utf-8');
  console.log(`\n✅ レポート出力: ${outPath}`);
  console.log(`   候補あり記事: ${sections.length} 件`);
}

function createArticleResult(file) {
  return {
    file,
    logs: [],
    capacityReviewItems: [],
    productMatchItems: [],
    refillNeeded: false,
    stats: {
      success: 0,
      fail: 0,
      changed: 0,
      unchanged: 0,
      capacityChanged: 0,
      capacityMissing: 0,
      deleted: 0,
      failed: 0,
    },
  };
}

async function asyncPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

async function processArticle(file, articlesDir, zeroState) {
  const result = createArticleResult(file);
  const log = line => result.logs.push(line);
  const filePath = join(articlesDir, file);
  const content = readFileSync(filePath, 'utf-8');
  const productNames = extractProductNames(content);
  const articleCategory = extractArticleCategory(content) ?? file.replace(/-comparison\.md$/, '');
  const articleTitle = extractArticleTitle(content) ?? '';
  const preferUnit = getArticleTargetUnit(basename(file, '.md'));

  log(`\n📄 ${file} (${productNames.length}商品)`);

  if (productNames.length === 0) {
    log('   → 商品なし。スキップ');
    return result;
  }

  let updatedContent = content;
  const zeroSearchDeletedHistoryItems = [];

  for (const name of productNames) {
    const shortName = name.slice(0, 45);
    let existingItemRef = null;
    try {
      // ── Step 1: Item/Get で直接取得を試みる ────────────────────────
      let data = null;
      let method = '[Search]';

      const existingUrl = extractProductRakutenUrl(updatedContent, name);
      const parsed = parseRakutenItemUrl(existingUrl);
      existingItemRef = parsed;

      if (parsed) {
        const itemData = await fetchRakutenItem(parsed.shopCode, parsed.itemCode, name);
        if (itemData) {
          const viaFallback = itemData._viafallback === true;
          if (!isLikelySameProductName(name, itemData.name ?? '')) {
            throw new Error(`既存rakutenUrlの商品名が現在の商品と一致しません（API商品名: ${itemData.name ?? '-'}）。更新をスキップ`);
          }
          const { _viafallback: _, ...cleanItemData } = itemData;
          data = cleanItemData;
          method = '[Item/Get]';
        } else {
          throw new Error(`既存rakutenUrlの商品をAPIで確認できません（${parsed.shopCode}/${parsed.itemCode}）。削除・置換をスキップ`);
        }
      }

      // ── Step 2: フォールバック（キーワード検索） ──────────────────
      if (!data) {
        data = await fetchRakutenSearch(name);
      }

      log(`   [${shortName}...] ${method}`);
      const beforeSnapshot = extractProductSnapshot(updatedContent, name);
      const capacityNotes = [];
      const extractedCap = data.name ? extractCapacityFromItemName(data.name) : null;
      const capacityAnalysis = data.name ? analyzeCapacityFromItemName(data.name) : {
        capacity: null,
        total: null,
        normalizedTotal: null,
        confidence: 'low',
        reasons: ['API item name is empty'],
        shouldAutoUpdate: false,
      };
      const oldCapacityTotalForLog = extractCapacityTotal(extractProductCapacity(updatedContent, name) ?? '');
      const oldComparableForLog = normalizeCapacityTotal(oldCapacityTotalForLog);
      const apiTotal = extractedCap ? extractCapacityTotal(extractedCap) : null;
      const apiComparable = normalizeCapacityTotal(apiTotal);

      // ── Step 3: pricePerUnit 再計算・更新（既存ロジック） ─────────
      const capacity = extractProductCapacity(updatedContent, name);
      const embeddedProductCapacity = extractCapacityFromItemName(name);
      const isManualCapacityApiConflict = Boolean(
        method === '[Item/Get]' &&
        capacity &&
        embeddedProductCapacity &&
        extractedCap &&
        isSameComparableCapacity(capacity, embeddedProductCapacity) &&
        !isSameComparableCapacity(capacity, extractedCap)
      );
      const shouldFreezePriceCapacity = Boolean(
        (data.name && isMultiMeasureVariantItemName(data.name)) ||
        isManualCapacityApiConflict
      );
      const hasKnownApiPrice = typeof data.price === 'number' && data.price > 0;
      const newPricePerUnit = (!shouldFreezePriceCapacity && capacity && hasKnownApiPrice)
        ? calcPricePerUnit(data.price, capacity, preferUnit)
        : null;

      const updates = {
        price: data.price,
        rating: data.rating,
        reviewCount: data.reviewCount,
        affiliateUrl: data.affiliateUrl,
        imageUrl: data.imageUrl,
        pricePerUnit: newPricePerUnit,
      };

      // 機能3: 容量差異の自動修正
      // Item/Get は同一商品確定のため差異があれば即更新、Search は誤ヒット防止のため5%超のみ更新
      if (data.name) {
        if (shouldFreezePriceCapacity) {
          capacityNotes.push(`capacity判定: 複数容量バリエーションのため要確認。capacity/pricePerUnitは自動更新しない`);
        } else if (capacity && extractedCap) {
          const oldTotal = extractCapacityTotal(capacity);
          const newTotal = extractCapacityTotal(extractedCap);
          const oldComparable = normalizeCapacityTotal(oldTotal);
          const newComparable = normalizeCapacityTotal(newTotal);
          // 単位比較は大文字小文字を無視（"mL" と "ml" を同一視）
          // さらに同系単位（"kg" と "g", "L" と "mL"）も基準単位に揃えて比較する
          const mergedCapacity = method === '[Item/Get]'
            ? mergeExistingMeasureWithSalesQuantity(capacity, extractedCap)
            : null;
          if (mergedCapacity) {
            if (mergedCapacity !== capacity) {
              updates.newCapacity = mergedCapacity;
              updates.pricePerUnit = hasKnownApiPrice
                ? calcPricePerUnit(data.price, mergedCapacity, preferUnit)
                : newPricePerUnit;
              capacityNotes.push(`capacity判定: 既存の実容量を維持し、API販売数量だけ更新`);
            } else {
              capacityNotes.push(`capacity判定: API抽出の販売数量は既存 capacity に含まれるため維持`);
            }
          } else if (
            method === '[Item/Get]' &&
            isSameMeasureBaseWithExistingQuantity(capacity, extractedCap)
          ) {
            capacityNotes.push(`capacity判定: API抽出は既存 capacity の単品容量と一致するため維持`);
          } else if (
            method === '[Item/Get]' &&
            isSalesQuantityCapacity(capacity) &&
            isSalesQuantityCapacity(extractedCap) &&
            oldComparable &&
            newComparable &&
            oldComparable.unit.toLowerCase() === newComparable.unit.toLowerCase()
          ) {
            const diff = Math.abs(newComparable.total - oldComparable.total) / oldComparable.total;
            if (diff > 0) {
              updates.newCapacity = extractedCap;
              updates.pricePerUnit = hasKnownApiPrice
                ? calcPricePerUnit(data.price, extractedCap, preferUnit)
                : newPricePerUnit;
              capacityNotes.push(`capacity判定: 販売数量のみ同士のため API 値に更新`);
            }
          } else if (
            method === '[Item/Get]' &&
            hasMeasureCapacity(capacity) &&
            isSalesQuantityCapacity(extractedCap)
          ) {
            capacityNotes.push(`capacity判定: 既存 capacity に実容量があるため API販売数量のみでは更新しない`);
          } else if (method === '[Item/Get]' && isLikelySalesQuantityCapacityMisread(data.name, extractedCap)) {
            updates.newCapacity = '-';
            updates.pricePerUnit = '-';
            capacityNotes.push(`capacity判定: 販売数量の可能性があるため capacity を "-" に変更`);
          } else if (
            method === '[Item/Get]' &&
            oldComparable &&
            newComparable &&
            oldComparable.unit.toLowerCase() === newComparable.unit.toLowerCase()
          ) {
            const diff = Math.abs(newComparable.total - oldComparable.total) / oldComparable.total;
            const threshold = method === '[Item/Get]' ? 0 : 0.05;
            if (diff > threshold) {
              // 同一単位の表記ゆれ（ml→mL など）のみ既存表記に統一し、kg/g などの実単位は楽天表記を保持
              const normalizedCap = oldTotal && newTotal && oldTotal.unit.toLowerCase() === newTotal.unit.toLowerCase()
                ? extractedCap.replace(new RegExp(newTotal.unit, 'g'), oldTotal.unit)
                : extractedCap;
              updates.newCapacity = normalizedCap;
              updates.pricePerUnit = hasKnownApiPrice
                ? calcPricePerUnit(data.price, normalizedCap, preferUnit)
                : newPricePerUnit;
              capacityNotes.push(`capacity判定: 差異検出により capacity を更新`);
            }
          } else if (!capacity && !oldTotal && newTotal && method === '[Item/Get]') {
            // 既存 capacity が未認識単位等でパース不能な場合、Item/Get 確定商品なら API 値で置換
            updates.newCapacity = extractedCap;
            updates.pricePerUnit = hasKnownApiPrice
              ? calcPricePerUnit(data.price, extractedCap, preferUnit)
              : newPricePerUnit;
            capacityNotes.push(`capacity判定: 既存値を解析できないため API 抽出値に置換`);
          }
        } else if (!extractedCap && method === '[Item/Get]') {
          capacityNotes.push(`capacity判定: API商品名から容量取得不可のため既存 capacity を維持`);
        }
      }

      const proposedCapacity = updates.newCapacity ?? null;
      const proposedTotal = proposedCapacity ? extractCapacityTotal(proposedCapacity) : null;
      const proposedComparable = normalizeCapacityTotal(proposedTotal);
      const capacityReview = shouldReviewCapacity({
        method,
        capacity,
        capacityAnalysis,
        oldComparable: oldComparableForLog,
        proposedComparable: proposedComparable ?? apiComparable,
        shouldFreezePriceCapacity,
      });

      if (capacityReview.needsReview) {
        const hadProposedCapacityUpdate = updates.newCapacity != null;
        if (hadProposedCapacityUpdate) {
          delete updates.newCapacity;
        }

        const existingCapacityPricePerUnit = capacity && hasKnownApiPrice
          ? calcPricePerUnit(data.price, capacity, preferUnit)
          : null;
        updates.pricePerUnit = existingCapacityPricePerUnit ?? beforeSnapshot?.pricePerUnit ?? null;

        const action = hadProposedCapacityUpdate
          ? 'blocked capacity auto-update; kept existing capacity'
          : 'kept existing capacity; review recommended';
        capacityNotes.push(`capacity safety: ${action}`);
        capacityReview.reasons.forEach(reason => capacityNotes.push(`capacity review: ${reason}`));
        result.capacityReviewItems.push(buildCapacityReviewItem({
          file,
          category: articleCategory,
          method,
          beforeSnapshot,
          data,
          capacityAnalysis,
          extractedCap,
          reviewReasons: capacityReview.reasons,
          action,
        }));
      }

      const afterSnapshot = buildAfterSnapshot(beforeSnapshot, updates);
      const changed = [
        ['name', beforeSnapshot?.name, afterSnapshot.name],
        ['price', beforeSnapshot?.price, afterSnapshot.price],
        ['rating', beforeSnapshot?.rating, afterSnapshot.rating],
        ['reviewCount', beforeSnapshot?.reviewCount, afterSnapshot.reviewCount],
        ['rakutenUrl', beforeSnapshot?.rakutenUrl, afterSnapshot.rakutenUrl],
        ['imageUrl', beforeSnapshot?.imageUrl, afterSnapshot.imageUrl],
        ['capacity', beforeSnapshot?.capacity, afterSnapshot.capacity],
        ['pricePerUnit', beforeSnapshot?.pricePerUnit, afterSnapshot.pricePerUnit],
      ].some(([, beforeValue, afterValue]) => (beforeValue ?? null) !== (afterValue ?? null));
      const capacityChanged = (beforeSnapshot?.capacity ?? null) !== (afterSnapshot.capacity ?? null);
      const capacityMissing = !extractedCap && method === '[Item/Get]';

      updatedContent = updateProductInFrontmatter(updatedContent, name, updates);

      // 商品差し替え条件: name/capacity/rakutenUrl の direct item URL が変わった場合はYahoo offerをreview化
      if (!DRY_RUN) {
        const nameActuallyChanged = Boolean(updates.newName) && (beforeSnapshot?.name ?? null) !== (afterSnapshot.name ?? null);
        const capacityActuallyChanged = Boolean(updates.newCapacity) && (beforeSnapshot?.capacity ?? null) !== (afterSnapshot.capacity ?? null);
        const beforeParsed = parseRakutenItemUrl(beforeSnapshot?.rakutenUrl ?? '');
        const afterParsed = parseRakutenItemUrl(afterSnapshot.rakutenUrl ?? '');
        const rakutenItemUrlChanged = Boolean(beforeParsed && afterParsed) &&
          (beforeParsed.shopCode !== afterParsed.shopCode || beforeParsed.itemCode !== afterParsed.itemCode);

        if (nameActuallyChanged || capacityActuallyChanged || rakutenItemUrlChanged) {
          const changeReasons = [];
          if (nameActuallyChanged) changeReasons.push(`商品名変更: "${beforeSnapshot?.name}" → "${afterSnapshot.name}"`);
          if (capacityActuallyChanged) changeReasons.push(`容量変更: "${beforeSnapshot?.capacity}" → "${afterSnapshot.capacity}"`);
          if (rakutenItemUrlChanged) changeReasons.push(`楽天商品URL変更`);
          // updateProductInFrontmatter で newName が適用済みのため新名称で検索する
          const reviewLookupName = updates.newName ?? name;
          const reviewResult = markProviderOffersForReview(
            updatedContent,
            reviewLookupName,
            'yahoo',
            `楽天基準商品の変更によりYahoo再確認が必要: ${changeReasons.join(', ')}`
          );
          if (reviewResult.changed) {
            updatedContent = reviewResult.content;
            log(`      Yahoo offer → review（${changeReasons.join(', ')}）`);
          }
        }
      }

      const logLines = buildProductLogLines({
        before: beforeSnapshot,
        after: afterSnapshot,
        data,
        extractedCap,
        oldComparable: oldComparableForLog,
        apiComparable,
        capacityNotes,
      });
      logLines.forEach(line => log(`      ${line}`));
      if (!changed) log('      変更なし');
      if (changed) {
        result.stats.changed++;
      } else {
        result.stats.unchanged++;
      }
      if (capacityChanged) {
        result.stats.capacityChanged++;
      }
      if (capacityMissing) {
        result.stats.capacityMissing++;
      }
      result.stats.success++;
      zeroState.count = 0; // 成功したらリセット
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e ?? '');
      let queuedProductMatch = false;
      try {
        const matchItem = await buildProductMatchReportItem({
          file,
          category: articleCategory,
          articleTitle,
          content: updatedContent,
          productName: name,
          error: e,
          existingItemRef,
        });
        result.productMatchItems.push(matchItem);
        queuedProductMatch = true;
        log(`      product match候補: ${matchItem.candidates.length}件（${matchItem.failure.stage}）`);
      } catch (reportError) {
        log(`      product match候補生成失敗: ${reportError.message}`);
      }

      // 機能2: 検索0件エラー時は商品ブロックを自動削除
      const isZeroResult = errorMessage.includes('0件') || errorMessage.includes('通常商品が見つかりません');
      if (isZeroResult && queuedProductMatch) {
        log(`❌ ${errorMessage} ⚠ AI商品照合候補に追加したため削除スキップ`);
      } else if (isZeroResult) {
        if (existingItemRef) {
          log(`❌ ${errorMessage} ⚠ 削除スキップ（既存 rakutenUrl あり: ${existingItemRef.shopCode}/${existingItemRef.itemCode}）`);
          result.stats.failed++;
          result.stats.fail++;
          await sleep(2000);
          continue;
        }

        zeroState.count++;

        // ② 連続N件で中断（API障害と判断）
        if (zeroState.count >= CONSECUTIVE_ZERO_ABORT) {
          throw new Error(`連続${zeroState.count}件の検索0件エラーが発生しました。API障害の可能性があるため処理を中断します。`);
        }

        // ① プローブクエリ：APIが正常かを確認してから削除判断
        log('   🔍 API疎通確認中...');
        const healthy = await isApiHealthy();
        if (!healthy) {
          throw new Error(`API障害を検知しました（プローブ失敗）。"${name.slice(0, 30)}" の削除をスキップして処理を中断します。`);
        }
        log('   🔍 API疎通確認 OK（正常）');

        // API正常 → 廃番と判断して削除
        const productBeforeDelete = extractAllProductsData(updatedContent).find(p => p.name === name);
        const removed = removeProductFromFrontmatter(updatedContent, name);
        if (removed === null) {
          log(`❌ ${errorMessage} ⚠ 削除スキップ（最後の1商品）`);
        } else if (!DRY_RUN) {
          updatedContent = removed;
          result.stats.deleted++;
          result.refillNeeded = true;
          if (productBeforeDelete) {
            zeroSearchDeletedHistoryItems.push({
              deletedAt: todayJst(),
              articleFile: `src/content/articles/${file}`,
              category: articleCategory,
              reason: 'zero-search',
              rank: productBeforeDelete.rank ?? null,
              name: productBeforeDelete.name ?? '',
              capacity: productBeforeDelete.capacity ?? null,
              reviewCount: productBeforeDelete.reviewCount ?? null,
              rakutenUrl: productBeforeDelete.rakutenUrl ?? '',
              directUrl: toDirectItemUrl(productBeforeDelete.rakutenUrl) ?? productBeforeDelete.rakutenUrl ?? '',
              identityKey: normalizeProductIdentity(productBeforeDelete.name ?? ''),
            });
          }
          log(`🗑 削除: "${name}"`);
        } else {
          result.stats.deleted++;
          result.refillNeeded = true;
          log(`🗑 [dry-run] 削除予定: "${name}"`);
        }
      } else {
        log(`❌ ${errorMessage}`);
      }
      result.stats.failed++;
      result.stats.fail++;
    }
  }

  // 機能1: コスパ順並び替え（全商品処理後）
  const reorderResult = reorderProductsByPricePerUnit(updatedContent);
  if (reorderResult.changed) {
    updatedContent = reorderResult.content;
    reorderResult.log.forEach(l => log(`   🔀 ${l}`));
  } else if (reorderResult.log.length > 0) {
    reorderResult.log.forEach(l => log(`   ⚠ ${l}`));
  }

  // 機能5: 並び替え後、rank 11位以下の商品を削除
  let rankLimitDeletedHistoryItems = [];
  const limitResult = limitProductsByRank(updatedContent, 10);
  if (limitResult.changed) {
    updatedContent = limitResult.content;
    result.stats.deleted += limitResult.removed;
    rankLimitDeletedHistoryItems = buildDeletedProductHistoryItems({
      file,
      category: articleCategory,
      products: limitResult.removedProducts,
      maxRank: 10,
    });
    limitResult.log.forEach(l => log(`   🗑 ${DRY_RUN ? '[dry-run] ' : ''}${l}`));
  }

  // 機能6: title・description の「N選」を実際の商品数に同期
  const titleCountResult = syncTitleProductCount(updatedContent);
  if (titleCountResult.changed) {
    updatedContent = titleCountResult.content;
    if (titleCountResult.before !== titleCountResult.after) {
      log(`   📝 title商品数: "${titleCountResult.before}" -> "${titleCountResult.after}"`);
    }
    if (titleCountResult.descBefore !== titleCountResult.descAfter) {
      log(`   📝 description商品数: "${titleCountResult.descBefore}" -> "${titleCountResult.descAfter}"`);
    }
  }

  // 機能4: name に埋め込まれた容量と capacity フィールドの食い違いを修正
  const nameCapResult = fixNameCapacityConflicts(updatedContent);
  if (nameCapResult.changed) {
    updatedContent = nameCapResult.content;
    nameCapResult.log.forEach(l => log(`   🔧 ${l}`));
  }

  if (!DRY_RUN && updatedContent !== content) {
    // updatedAt を当日の JST 日付で更新（sv ロケールは YYYY-MM-DD 形式）
    const today = new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
    updatedContent = updateUpdatedAt(updatedContent, today);
    // バックアップ作成（元ファイルを保存）
    writeFileSync(filePath + '.bak', content, 'utf-8');
    // ファイル更新
    writeFileSync(filePath, updatedContent, 'utf-8');
    const historyPath = appendDeletedProductHistory([...zeroSearchDeletedHistoryItems, ...rankLimitDeletedHistoryItems]);
    if (historyPath) {
      log(`   🧾 削除履歴を記録: ${historyPath}`);
    }
    log(`   💾 更新完了（updatedAt: ${today}、バックアップ: ${basename(filePath)}.bak）`);
  }
  log(`   📊 記事集計: 更新 ${result.stats.changed}件 / 変更なし ${result.stats.unchanged}件 / capacity修正 ${result.stats.capacityChanged}件 / capacity取得不可 ${result.stats.capacityMissing}件 / 削除 ${result.stats.deleted}件 / 失敗 ${result.stats.failed}件`);

  return result;
}

// ─── メイン処理 ────────────────────────────────────────────────────────────
async function main() {
  const aiMatchResult = applyPendingAiMatches();
  if (aiMatchResult.processed || aiMatchResult.failed || aiMatchResult.reviews) {
    console.log(`AI match summary: processed ${aiMatchResult.processed}, failed ${aiMatchResult.failed}, review ${aiMatchResult.reviews}`);
  }

  const articlesDir = resolve(process.cwd(), 'src/content/articles');
  const files = readdirSync(articlesDir)
    .filter(f => f.endsWith('.md'))
    .filter(f => matchesFileFilter(f));

  console.log(`📂 対象ファイル: ${files.length}件`);
  console.log(`⚙ 並列数: ${CONCURRENCY} / API間隔: ${API_INTERVAL_MS}ms\n`);
  if (DRY_RUN) console.log('⚠ --dry-run モード: ファイルは書き換えません\n');

  const zeroState = { count: 0 };
  const articleResults = await asyncPool(files, CONCURRENCY, file => processArticle(file, articlesDir, zeroState));

  for (const result of articleResults) {
    result.logs.forEach(line => console.log(line));
  }

  const totals = articleResults.reduce((acc, result) => {
    acc.success += result.stats.success;
    acc.fail += result.stats.fail;
    acc.changed += result.stats.changed;
    acc.unchanged += result.stats.unchanged;
    acc.capacityChanged += result.stats.capacityChanged;
    acc.capacityMissing += result.stats.capacityMissing;
    acc.deleted += result.stats.deleted;
    acc.capacityReviewItems.push(...result.capacityReviewItems);
    acc.productMatchItems.push(...result.productMatchItems);
    return acc;
  }, {
    success: 0,
    fail: 0,
    changed: 0,
    unchanged: 0,
    capacityChanged: 0,
    capacityMissing: 0,
    deleted: 0,
    capacityReviewItems: [],
    productMatchItems: [],
  });

  console.log('\n' + '═'.repeat(60));
  console.log(`✅ 成功: ${totals.success}件  ❌ 失敗: ${totals.fail}件`);
  console.log(`📊 変更あり: ${totals.changed}件 / 変更なし: ${totals.unchanged}件 / capacity修正: ${totals.capacityChanged}件 / capacity取得不可: ${totals.capacityMissing}件 / 削除: ${totals.deleted}件`);
  const capacityReport = writeCapacityReviewReports(totals.capacityReviewItems);
  if (capacityReport) {
    console.log(`capacity review report: ${capacityReport.mdPath}`);
    console.log(`AI capacity input: ${capacityReport.jsonlPath}`);
  }
  const productMatchReport = writeProductMatchReport(totals.productMatchItems);
  if (productMatchReport) {
    console.log(`product match input: ${productMatchReport}`);
    console.log(`product match items: ${totals.productMatchItems.length}`);
  }
  if (!DRY_RUN && totals.success > 0) {
    console.log('各ファイルの .bak でいつでも元に戻せます。');
  }

  // 補充が必要な記事に check-additions を自動実行
  const deletedArticlesForRefill = aiMatchResult.deletedArticles ?? new Set();
  for (const result of articleResults) {
    if (result.refillNeeded) deletedArticlesForRefill.add(result.file);
  }

  if (deletedArticlesForRefill.size > 0) {
    console.log(`\ncheck-additions 自動実行（補充対象: ${deletedArticlesForRefill.size}件）`);
    for (const articleFile of deletedArticlesForRefill) {
      if (!DRY_RUN) {
        const spawnResult = spawnSync(
          process.execPath,
          [
            'scripts/update-products.mjs',
            '--check-additions',
            `--file=${articleFile}`,
            '--target=11',
          ],
          { stdio: 'inherit', cwd: process.cwd() }
        );
        if (spawnResult.status !== 0) {
          console.log(`   check-additions 失敗: ${articleFile}`);
        }
      } else {
        console.log(`   [dry-run] would run check-additions --file=${articleFile} --target=11`);
      }
    }
  }
}

(CHECK_REPLACEMENTS ? checkReplacements() : CHECK_ADDITIONS ? checkAdditions() : main()).catch(err => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
