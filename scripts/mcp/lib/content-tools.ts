import { readFileSync, readdirSync, existsSync, statSync, type Dirent } from 'fs';
import { join, resolve, relative } from 'path';
import yaml from 'js-yaml';
import {
  extractCapacityTotal,
  normalizeCapacityTotal,
  calcPricePerUnit,
} from '../../lib/frontmatter.ts';

const PROJECT_ROOT = resolve(process.cwd());
const ARTICLES_DIR = join(PROJECT_ROOT, 'src/content/articles');
const RAG_DIR = join(PROJECT_ROOT, 'data/rag');
const REPORTS_DIR = join(PROJECT_ROOT, 'reports');

// ─── 型定義 ────────────────────────────────────────────────────────────────────

export interface ListArticlesOptions {
  category?: string;
  productCountLt?: number;
  hasYahooOffer?: boolean;
}

export interface ArticleSummary {
  articleFile: string;
  title: string;
  category: string;
  productCount: number;
  updatedAt?: string;
}

export interface ProductSummary {
  rank: number;
  name: string;
  brand?: string;
  price: number | null;
  capacity?: string | null;
  pricePerUnit?: string | null;
  rakutenUrl?: string | null;
  offerCount: number;
  needsReview: boolean;
}

export interface ProductContextInput {
  articleFile: string;
  rank?: number;
  name?: string;
}

export interface RagDecisionRecord {
  articleFile: string;
  rank: number | null;
  currentName: string;
  action: string;
  confidence: string | null;
  selectedItemUrl: string | null;
  reason: string | null;
  status: string;
}

export interface ProductContext {
  product: ProductSummary | null;
  ragHistory: RagDecisionRecord[];
}

export interface ParseCapacityInput {
  name: string;
  capacity?: string;
  price?: number;
}

export interface CapacityParseResult {
  source: string;
  extracted: { total: number; unit: string } | null;
  normalized: { total: number; unit: string } | null;
  pricePerUnit: string | null;
}

export interface LatestReportsInput {
  kind: 'capacity-review' | 'product-match' | 'addition-candidates' | 'all';
  limit?: number;
}

export interface ReportSummary {
  file: string;
  kind: string;
  date: string;
  size: number;
}

export interface SearchRagInput {
  query: string;
  type?: string;
  limit?: number;
}

export interface RagSearchResult {
  file: string;
  line: number;
  record: unknown;
}

// ─── 内部: フロントマター解析 ─────────────────────────────────────────────────

interface RawFrontmatter {
  title?: string;
  category?: string;
  updatedAt?: string;
  products?: RawProduct[];
}

interface RawProduct {
  rank?: number;
  name?: string;
  brand?: string;
  price?: number;
  capacity?: string;
  pricePerUnit?: string;
  rakutenUrl?: string;
  offers?: Array<{ provider?: string; matchStatus?: string }>;
}

function parseArticleFrontmatter(filePath: string): RawFrontmatter | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
    if (!match) return null;
    return (yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) as RawFrontmatter) ?? null;
  } catch {
    return null;
  }
}

function toProductSummary(p: RawProduct, idx: number): ProductSummary {
  const offerCount = Array.isArray(p.offers) ? p.offers.length : 0;
  const needsReview = Array.isArray(p.offers)
    ? p.offers.some(o => o.matchStatus === 'review' || o.matchStatus === 'pending')
    : false;
  return {
    rank: typeof p.rank === 'number' ? p.rank : idx + 1,
    name: p.name ?? '',
    brand: p.brand,
    price: typeof p.price === 'number' ? p.price : null,
    capacity: p.capacity ?? null,
    pricePerUnit: p.pricePerUnit ?? null,
    rakutenUrl: p.rakutenUrl ?? null,
    offerCount,
    needsReview,
  };
}

// ─── listArticles ────────────────────────────────────────────────────────────

export function listArticles(options: ListArticlesOptions = {}): ArticleSummary[] {
  if (!existsSync(ARTICLES_DIR)) return [];

  const files = readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.md') && !f.endsWith('.bak'));
  const results: ArticleSummary[] = [];

  for (const file of files) {
    const filePath = join(ARTICLES_DIR, file);
    const fm = parseArticleFrontmatter(filePath);
    if (!fm) continue;

    const category = fm.category ?? '';
    const products = Array.isArray(fm.products) ? fm.products : [];
    const productCount = products.length;

    if (options.category && category !== options.category) continue;
    if (options.productCountLt !== undefined && productCount >= options.productCountLt) continue;
    if (options.hasYahooOffer !== undefined) {
      const hasOffer = products.some(p => Array.isArray(p.offers) && p.offers.length > 0);
      if (options.hasYahooOffer !== hasOffer) continue;
    }

    results.push({
      articleFile: `src/content/articles/${file}`,
      title: fm.title ?? '',
      category,
      productCount,
      updatedAt: fm.updatedAt,
    });
  }

  return results.sort((a, b) => a.articleFile.localeCompare(b.articleFile));
}

// ─── getArticleProducts ───────────────────────────────────────────────────────

export function getArticleProducts(articleFile: string): ProductSummary[] {
  const filePath = resolve(join(PROJECT_ROOT, articleFile));
  if (!filePath.startsWith(ARTICLES_DIR + '/') && !filePath.startsWith(ARTICLES_DIR + '\\')) {
    return [];
  }
  const fm = parseArticleFrontmatter(filePath);
  if (!fm || !Array.isArray(fm.products)) return [];
  return fm.products.map((p, idx) => toProductSummary(p, idx));
}

// ─── getProductContext ────────────────────────────────────────────────────────

export function getProductContext(input: ProductContextInput): ProductContext {
  const products = getArticleProducts(input.articleFile);
  let product: ProductSummary | null = null;

  if (input.rank !== undefined) {
    product = products.find(p => p.rank === input.rank) ?? null;
  } else if (input.name) {
    product = products.find(p => p.name === input.name) ?? null;
  }

  const ragHistory = readRagMatchDecisions(input.articleFile, product);
  return { product, ragHistory };
}

function readRagMatchDecisions(articleFile: string, product: ProductSummary | null): RagDecisionRecord[] {
  const ragFile = join(RAG_DIR, 'match-decisions.jsonl');
  if (!existsSync(ragFile)) return [];

  const lines = readFileSync(ragFile, 'utf-8').split('\n').filter(Boolean);
  const results: RagDecisionRecord[] = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec.articleFile !== articleFile) continue;
      if (product !== null) {
        const sameRank = product.rank !== undefined && rec.rank === product.rank;
        const sameName = typeof rec.currentName === 'string' && rec.currentName === product.name;
        if (!sameRank && !sameName) continue;
      }
      results.push({
        articleFile: rec.articleFile as string,
        rank: rec.rank as number | null,
        currentName: rec.currentName as string,
        action: rec.action as string,
        confidence: (rec.confidence ?? null) as string | null,
        selectedItemUrl: (rec.selectedItemUrl ?? null) as string | null,
        reason: (rec.reason ?? null) as string | null,
        status: rec.status as string,
      });
    } catch {
      // 不正行はスキップ
    }
  }

  return results;
}

// ─── parseCapacityInput ───────────────────────────────────────────────────────

export function parseCapacityInput(input: ParseCapacityInput): CapacityParseResult {
  const source = input.capacity ?? input.name;
  const extracted = extractCapacityTotal(source);
  const normalized = normalizeCapacityTotal(extracted);
  const pricePerUnit = (typeof input.price === 'number' && extracted)
    ? calcPricePerUnit(input.price, source)
    : null;
  return { source, extracted, normalized, pricePerUnit };
}

// ─── readLatestReports ────────────────────────────────────────────────────────

const KIND_PATTERNS: Array<[string, RegExp]> = [
  ['capacity-review', /^(?:capacity-review|ai-capacity-input)-/],
  ['product-match', /^product-match-(?:input|output)-/],
  ['addition-candidates', /^addition-candidates-/],
];

function detectKind(filename: string): string | null {
  for (const [kind, re] of KIND_PATTERNS) {
    if (re.test(filename)) return kind;
  }
  return null;
}

function scanReportsDir(dir: string, targetKind: string, results: ReportSummary[]): void {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanReportsDir(fullPath, targetKind, results);
      continue;
    }
    if (!entry.isFile()) continue;

    const kind = detectKind(entry.name);
    if (!kind) continue;
    if (targetKind !== 'all' && kind !== targetKind) continue;

    const dateMatch = entry.name.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : '0000-00-00';

    let size = 0;
    try {
      size = statSync(fullPath).size;
    } catch {
      // サイズ取得失敗は無視
    }

    results.push({
      file: relative(PROJECT_ROOT, fullPath).replace(/\\/g, '/'),
      kind,
      date,
      size,
    });
  }
}

export function readLatestReports(input: LatestReportsInput): ReportSummary[] {
  if (!existsSync(REPORTS_DIR)) return [];
  const limit = input.limit ?? 5;
  const results: ReportSummary[] = [];
  scanReportsDir(REPORTS_DIR, input.kind, results);
  return results
    .sort((a, b) => b.date.localeCompare(a.date) || b.file.localeCompare(a.file))
    .slice(0, limit);
}

// ─── searchRag ────────────────────────────────────────────────────────────────

const RAG_FILE_MAP: Record<string, string> = {
  'product': 'products.jsonl',
  'capacity-pattern': 'capacity-patterns.jsonl',
  'match-decision': 'match-decisions.jsonl',
  'category-rule': 'category-rules.jsonl',
};

export function searchRag(input: SearchRagInput): RagSearchResult[] {
  if (!existsSync(RAG_DIR)) return [];

  const limit = input.limit ?? 20;
  const queryLower = input.query.toLowerCase();
  const results: RagSearchResult[] = [];

  const filenames = input.type
    ? (RAG_FILE_MAP[input.type] ? [RAG_FILE_MAP[input.type]] : [])
    : Object.values(RAG_FILE_MAP);

  outer: for (const filename of filenames) {
    const filePath = join(RAG_DIR, filename);
    if (!existsSync(filePath)) continue;

    const lines = readFileSync(filePath, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || !line.toLowerCase().includes(queryLower)) continue;
      try {
        results.push({ file: `data/rag/${filename}`, line: i + 1, record: JSON.parse(line) });
        if (results.length >= limit) break outer;
      } catch {
        // 不正行はスキップ
      }
    }
  }

  return results;
}
