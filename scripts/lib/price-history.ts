/**
 * 価格履歴（data/price-history/<articleId>.jsonl）の I/O とパース。
 *
 * 統計・同一性キーの実体は src/lib/price-history.ts に置き、ここでは再エクスポートする
 * （scripts/lib/frontmatter.ts が src/lib/capacity.ts を再エクスポートしているのと同じ形）。
 * ⚠ Node ESM（--experimental-strip-types で実行）解決のため相対 import は拡張子 .ts を必須にする。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { parseFrontmatter } from './frontmatter.ts';
import {
  buildProductKey,
  extractRakutenItemCode,
  type PriceHistoryProvider,
  type PriceHistoryRecord,
} from '../../src/lib/price-history.ts';

export {
  extractRakutenItemCode,
  buildProductKey,
  summarizePriceHistory,
  summarizeByProduct,
  MIN_SAMPLES,
  type PriceHistoryProvider,
  type PriceHistoryRecord,
  type PriceStats,
  type SummarizeOptions,
} from '../../src/lib/price-history.ts';

const PROVIDERS: readonly PriceHistoryProvider[] = ['rakuten', 'yahoo', 'amazon'];

function toPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 記事1本の frontmatter から、その時点のレコード配列を作る。
 * price が無い / 0 の行は出さない（価格として意味を持たないため）。
 * offers[] の rakuten は top-level price と重複するので採らない。
 */
export function buildRecordsFromArticle(
  articleId: string,
  content: string,
  capturedAt: string,
  commit: string | null
): PriceHistoryRecord[] {
  const parsed = parseFrontmatter(content);
  if (!parsed) return [];
  const products = parsed.data.products;
  if (!Array.isArray(products)) return [];

  const records: PriceHistoryRecord[] = [];
  for (const raw of products) {
    if (!raw || typeof raw !== 'object') continue;
    const product = raw as Record<string, unknown>;
    const name = typeof product.name === 'string' ? product.name : null;
    if (!name) continue;

    const rakutenUrl = toNullableString(product.rakutenUrl);
    const productKey = buildProductKey(rakutenUrl, name);
    const itemCode = extractRakutenItemCode(rakutenUrl);
    const rank = toPositiveInt(product.rank) ?? 0;
    const capacity = toNullableString(product.capacity);

    const base = { articleId, capturedAt, commit, productKey, itemCode, name, rank, capacity };

    const price = toPositiveInt(product.price);
    if (price !== null) records.push({ ...base, provider: 'rakuten', price });

    const offers = product.offers;
    if (!Array.isArray(offers)) continue;
    for (const rawOffer of offers) {
      if (!rawOffer || typeof rawOffer !== 'object') continue;
      const offer = rawOffer as Record<string, unknown>;
      const provider = offer.provider;
      if (typeof provider !== 'string' || !PROVIDERS.includes(provider as PriceHistoryProvider)) continue;
      // rakuten は top-level price が正。offers 側の同 provider は採らない
      if (provider === 'rakuten') continue;
      const offerPrice = toPositiveInt(offer.price);
      if (offerPrice === null) continue;
      records.push({ ...base, provider: provider as PriceHistoryProvider, price: offerPrice });
    }
  }
  return records;
}

/** JSONL 文字列 → レコード配列（壊れた行はスキップして warn） */
export function parseJsonl(text: string): PriceHistoryRecord[] {
  const records: PriceHistoryRecord[] = [];
  let broken = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as PriceHistoryRecord;
      if (!record || typeof record.productKey !== 'string' || typeof record.capturedAt !== 'string') {
        broken += 1;
        continue;
      }
      records.push(record);
    } catch {
      broken += 1;
    }
  }
  if (broken > 0) console.warn(`  [WARN] 価格履歴の壊れた行をスキップ: ${broken}行`);
  return records;
}

/**
 * レコード配列 → JSONL 文字列。
 * ソートキーに rank を使わない（毎回並べ替わるため、同一データでも差分が出る）。
 */
export function serializeJsonl(records: readonly PriceHistoryRecord[]): string {
  const sorted = [...records].sort((a, b) =>
    a.capturedAt.localeCompare(b.capturedAt) ||
    a.productKey.localeCompare(b.productKey) ||
    a.provider.localeCompare(b.provider)
  );
  return sorted.map(r => JSON.stringify(r)).join('\n') + (sorted.length > 0 ? '\n' : '');
}

/** (productKey, provider, capturedAt) で重複排除。後勝ち */
export function mergeRecords(
  existing: readonly PriceHistoryRecord[],
  incoming: readonly PriceHistoryRecord[]
): PriceHistoryRecord[] {
  const byKey = new Map<string, PriceHistoryRecord>();
  for (const record of [...existing, ...incoming]) {
    byKey.set(JSON.stringify([record.productKey, record.provider, record.capturedAt]), record);
  }
  return [...byKey.values()];
}

// ─── ファイル I/O ────────────────────────────────────────────────────────────

/** 記事ファイルの相対パス（例 reviews/foo.md）→ articleId（例 reviews/foo） */
export function toArticleId(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/\.mdx?$/, '');
}

/** 記事ディレクトリを再帰走査する。.md.bak は対象外 */
export function collectArticleFiles(dir: string, base: string = dir): Array<{ relPath: string; fullPath: string }> {
  const results: Array<{ relPath: string; fullPath: string }> = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectArticleFiles(fullPath, base));
    } else if (
      (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) &&
      !entry.name.endsWith('.md.bak')
    ) {
      results.push({ relPath: relative(base, fullPath).replace(/\\/g, '/'), fullPath });
    }
  }
  return results;
}

export function priceHistoryDir(root: string): string {
  return join(root, 'data', 'price-history');
}

export function priceHistoryPath(root: string, articleId: string): string {
  return join(priceHistoryDir(root), `${articleId}.jsonl`);
}

/** 既存の履歴を読む。ファイルが無ければ空配列 */
export function readArticleHistory(root: string, articleId: string): PriceHistoryRecord[] {
  const path = priceHistoryPath(root, articleId);
  if (!existsSync(path)) return [];
  return parseJsonl(readFileSync(path, 'utf8'));
}

/** 履歴を書き出す（reviews/ 配下のためディレクトリを再帰作成する） */
export function writeArticleHistory(root: string, articleId: string, records: readonly PriceHistoryRecord[]): void {
  const path = priceHistoryPath(root, articleId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeJsonl(records), 'utf8');
}

export interface AppendResult {
  /** レコードを生成できた記事数 */
  articles: number;
  /** 既存に無かった（= 実際に増えた）行数 */
  newRows: number;
  /** 既存行を上書きした行数（同日再実行など） */
  updatedRows: number;
}

/**
 * 現在のワークツリーの記事から1時点分のスナップショットを追記する。
 * dryRun のときはファイルを書かず件数だけ返す。
 */
export function appendPriceHistorySnapshot(options: {
  root: string;
  capturedAt: string;
  dryRun?: boolean;
}): AppendResult {
  const { root, capturedAt, dryRun = false } = options;
  const articlesDir = join(root, 'src', 'content', 'articles');
  const result: AppendResult = { articles: 0, newRows: 0, updatedRows: 0 };

  for (const { relPath, fullPath } of collectArticleFiles(articlesDir)) {
    const articleId = toArticleId(relPath);
    const incoming = buildRecordsFromArticle(articleId, readFileSync(fullPath, 'utf8'), capturedAt, null);
    if (incoming.length === 0) continue;

    const existing = readArticleHistory(root, articleId);
    const existingKeys = new Set(
      existing.map(r => JSON.stringify([r.productKey, r.provider, r.capturedAt]))
    );
    for (const record of incoming) {
      const key = JSON.stringify([record.productKey, record.provider, record.capturedAt]);
      if (existingKeys.has(key)) result.updatedRows += 1;
      else result.newRows += 1;
    }

    result.articles += 1;
    if (!dryRun) writeArticleHistory(root, articleId, mergeRecords(existing, incoming));
  }
  return result;
}
