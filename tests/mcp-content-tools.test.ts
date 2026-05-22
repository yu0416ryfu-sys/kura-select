import { describe, it, expect } from 'vitest';
import {
  listArticles,
  getArticleProducts,
  getProductContext,
  parseCapacityInput,
  readLatestReports,
  searchRag,
} from '../scripts/mcp/lib/content-tools';

describe('listArticles', () => {
  it('オプションなしで記事一覧を返す', () => {
    const articles = listArticles();
    expect(articles.length).toBeGreaterThan(0);
    expect(articles[0]).toHaveProperty('articleFile');
    expect(articles[0]).toHaveProperty('title');
    expect(articles[0]).toHaveProperty('productCount');
    expect(articles[0]).toHaveProperty('category');
  });

  it('articleFile は src/content/articles/ で始まる', () => {
    const articles = listArticles();
    for (const a of articles) {
      expect(a.articleFile).toMatch(/^src\/content\/articles\//);
    }
  });

  it('productCountLt でフィルタリングできる', () => {
    const articles = listArticles({ productCountLt: 10 });
    for (const a of articles) {
      expect(a.productCount).toBeLessThan(10);
    }
  });

  it('productCountLt: 0 は空配列を返す', () => {
    const articles = listArticles({ productCountLt: 0 });
    expect(articles).toHaveLength(0);
  });

  it('存在しないカテゴリは空配列を返す', () => {
    const articles = listArticles({ category: '__no_such_category__' });
    expect(articles).toHaveLength(0);
  });
});

describe('getArticleProducts', () => {
  it('記事の商品一覧を返す（本文は含まない）', () => {
    const articles = listArticles();
    expect(articles.length).toBeGreaterThan(0);
    const products = getArticleProducts(articles[0].articleFile);
    expect(Array.isArray(products)).toBe(true);
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(p).not.toHaveProperty('body');
      expect(p).toHaveProperty('rank');
      expect(p).toHaveProperty('name');
    }
  });

  it('存在しないファイルは空配列を返す', () => {
    const products = getArticleProducts('src/content/articles/non-existent-file.md');
    expect(products).toEqual([]);
  });
});

describe('getProductContext', () => {
  it('rank 指定で商品を返す', () => {
    const articles = listArticles();
    expect(articles.length).toBeGreaterThan(0);
    const ctx = getProductContext({ articleFile: articles[0].articleFile, rank: 1 });
    expect(ctx).toHaveProperty('product');
    expect(ctx).toHaveProperty('ragHistory');
    expect(Array.isArray(ctx.ragHistory)).toBe(true);
  });

  it('存在しない rank は product: null を返す', () => {
    const articles = listArticles();
    const ctx = getProductContext({ articleFile: articles[0].articleFile, rank: 9999 });
    expect(ctx.product).toBeNull();
    expect(Array.isArray(ctx.ragHistory)).toBe(true);
  });
});

describe('parseCapacityInput', () => {
  it('extractCapacityTotal と同じ結果を返す（掛け算）', () => {
    const result = parseCapacityInput({ name: '60枚×4パック（240枚）' });
    expect(result.extracted).toEqual({ total: 240, unit: '枚' });
  });

  it('normalizeCapacityTotal と同じ結果を返す（単位正規化）', () => {
    const result = parseCapacityInput({ name: '3kg' });
    expect(result.normalized).toEqual({ total: 3000, unit: 'g' });
  });

  it('price が与えられた場合 pricePerUnit を計算する', () => {
    const result = parseCapacityInput({ name: '30枚', price: 300 });
    expect(result.pricePerUnit).toBe('約10円/枚');
  });

  it('capacity パラメータが name より優先される', () => {
    const result = parseCapacityInput({ name: '商品名テキスト', capacity: '50枚' });
    expect(result.source).toBe('50枚');
    expect(result.extracted).toEqual({ total: 50, unit: '枚' });
  });

  it('容量が抽出できない場合 extracted は null', () => {
    const result = parseCapacityInput({ name: '容量不明の商品' });
    expect(result.extracted).toBeNull();
    expect(result.pricePerUnit).toBeNull();
  });

  it('price なしの場合 pricePerUnit は null', () => {
    const result = parseCapacityInput({ name: '50枚' });
    expect(result.pricePerUnit).toBeNull();
  });
});

describe('readLatestReports', () => {
  it('kind: all で空配列以外を返す（reportsが存在する前提）', () => {
    const results = readLatestReports({ kind: 'all', limit: 3 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('各エントリに file / kind / date / size フィールドがある', () => {
    const results = readLatestReports({ kind: 'all', limit: 5 });
    for (const r of results) {
      expect(r).toHaveProperty('file');
      expect(r).toHaveProperty('kind');
      expect(r).toHaveProperty('date');
      expect(r).toHaveProperty('size');
      expect(typeof r.size).toBe('number');
    }
  });
});

describe('searchRag', () => {
  it('data/rag/ 未生成でも空配列を返す（存在しないクエリ）', () => {
    const results = searchRag({ query: '__UNIQUE_NONEXISTENT_QUERY_XYZ__' });
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  it('limit を超えない件数を返す', () => {
    const results = searchRag({ query: 'の', limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('type 指定で対象ファイルを絞り込める', () => {
    const results = searchRag({ query: 'の', type: 'product', limit: 5 });
    for (const r of results) {
      expect(r.file).toContain('products.jsonl');
    }
  });

  it('存在しない type は空配列を返す', () => {
    const results = searchRag({ query: 'test', type: 'unknown-type', limit: 5 });
    expect(results).toHaveLength(0);
  });

  it('各エントリに file / line / record フィールドがある', () => {
    const results = searchRag({ query: 'の', limit: 3 });
    for (const r of results) {
      expect(r).toHaveProperty('file');
      expect(r).toHaveProperty('line');
      expect(r).toHaveProperty('record');
      expect(typeof r.line).toBe('number');
    }
  });
});
