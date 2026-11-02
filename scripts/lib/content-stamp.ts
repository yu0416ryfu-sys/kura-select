// 記事の「内容の更新日」台帳（data/content-dates.json）を扱う関数（前半は純粋関数・末尾にファイル読み書き）。計画書5 §3（Part A）。
//
// sitemap の lastmod を「読者に見える内容が変わった日」にするため、記事ごとに内容ハッシュと更新日を持つ。
// 価格・順位・updatedAt・products[] の変化（cron の価格同期など）では lastmod を動かさない。
// ハッシュの定義はこのファイルの computeContentHash だけが正（テスト・CLI・backfill が共有する）。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ARTICLES_DIR, listContentFiles } from './thin-categories.mjs';
import { CONTENT_DATES_PATH } from './sitemap-lastmod.mjs';
import { parseFrontmatter, PRODUCT_COUNT_RE } from './frontmatter.ts';

export interface ContentDateEntry {
  hash: string;
  contentUpdatedAt: string; // YYYY-MM-DD（JST）
}

export type ContentDatesLedger = Record<string, ContentDateEntry>;

export interface StampArticle {
  slug: string; // article.id と同じ形（reviews/ 接頭辞を含む・拡張子なし）
  hash: string;
  publishedAt: string;
}

/**
 * title / description の「N選・N商品・N製品」の数字を # に置き換える。
 * syncTitleProductCount が商品の増減に合わせて書き換える部分なので、内容の変更として数えない。
 */
export function normalizeTitleCount(text: string): string {
  return text.replace(PRODUCT_COUNT_RE, (_m, unit) => `#${unit}`);
}

/** 本文の改行を LF に揃え、先頭と末尾の空白・空行を除く */
function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').trim();
}

/**
 * 記事ファイルの内容ハッシュ = sha256(JSON.stringify([本文, title, description, faqs]))。
 * YAML の生テキストではなく parse 後の値から計算する（update-products が frontmatter を丸ごと
 * 再出力するので、引用符や改行の形は内容が同じでも変わるため）。products[] は含めない。
 * frontmatter を parse できないときは null。
 */
export function computeContentHash(fileContent: string): string | null {
  const parsed = parseFrontmatter(fileContent.replace(/\r\n?/g, '\n'));
  if (!parsed) return null;
  const { data, body } = parsed;
  const title = typeof data.title === 'string' ? normalizeTitleCount(data.title) : '';
  const description = typeof data.description === 'string' ? normalizeTitleCount(data.description) : '';
  const faqs = Array.isArray(data.faqs)
    ? (data.faqs as Array<{ question?: unknown; answer?: unknown }>).map((f) => [f?.question ?? null, f?.answer ?? null])
    : [];
  const payload = JSON.stringify([normalizeBody(body), title, description, faqs]);
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 台帳を記事の現状に合わせた新しい台帳を返す（元の台帳は変更しない）。
 * - 台帳に無い記事: 日付は publishedAt
 * - ハッシュが変わった記事: 日付は today（keepDates なら据え置き・ハッシュだけ更新）
 * - 変わっていない記事: そのまま
 * - 記事一覧に無い（削除・draft 化された）記事: 台帳から消す
 * キーは slug 順に並べる（差分を読みやすくするため）。
 */
export function stampContentDates(
  ledger: ContentDatesLedger,
  articles: StampArticle[],
  today: string,
  options: { keepDates?: boolean } = {}
): { ledger: ContentDatesLedger; added: string[]; changed: string[]; removed: string[] } {
  const next: ContentDatesLedger = {};
  const added: string[] = [];
  const changed: string[] = [];
  for (const article of [...articles].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const prev = ledger[article.slug];
    if (!prev) {
      next[article.slug] = { hash: article.hash, contentUpdatedAt: article.publishedAt };
      added.push(article.slug);
    } else if (prev.hash !== article.hash) {
      next[article.slug] = { hash: article.hash, contentUpdatedAt: options.keepDates ? prev.contentUpdatedAt : today };
      changed.push(article.slug);
    } else {
      next[article.slug] = prev;
    }
  }
  const removed = Object.keys(ledger).filter((slug) => !(slug in next));
  return { ledger: next, added, changed, removed };
}

/** 台帳と記事のハッシュが食い違う slug（台帳に無い記事・台帳にだけある記事を含む） */
export function findStaleEntries(ledger: ContentDatesLedger, articles: StampArticle[]): string[] {
  const stale = articles.filter((a) => ledger[a.slug]?.hash !== a.hash).map((a) => a.slug);
  const slugs = new Set(articles.map((a) => a.slug));
  for (const slug of Object.keys(ledger)) if (!slugs.has(slug)) stale.push(slug);
  return stale.sort();
}

/** Date を JST の YYYY-MM-DD にする */
export function toJstDate(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// ファイル読み込み（CLI・テストの統合チェックが共有する。上の純粋関数とは分けておく）
// ---------------------------------------------------------------------------

/** 記事ファイルのパスを slug（article.id の形）にする */
export function slugFromArticlePath(filePath: string, articlesDir: string): string {
  return path.relative(articlesDir, filePath).replace(/\\/g, '/').replace(/\.mdx?$/, '');
}

/** 公開記事（draft: true を除く・reviews/ を含む）を StampArticle の配列で返す */
export function collectStampArticles(articlesDir: string = ARTICLES_DIR): StampArticle[] {
  const articles: StampArticle[] = [];
  for (const file of listContentFiles(articlesDir) as string[]) {
    const content = fs.readFileSync(file, 'utf8');
    const parsed = parseFrontmatter(content.replace(/\r\n?/g, '\n'));
    if (!parsed || parsed.data.draft === true) continue;
    const hash = computeContentHash(content);
    if (!hash) continue;
    articles.push({
      slug: slugFromArticlePath(file, articlesDir),
      hash,
      publishedAt: String(parsed.data.publishedAt ?? ''),
    });
  }
  return articles;
}

export { CONTENT_DATES_PATH };

/** 台帳を読む。ファイルが無ければ null */
export function readContentDates(filePath: string = CONTENT_DATES_PATH): ContentDatesLedger | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ContentDatesLedger;
}

/** 台帳を書く（2スペース・末尾改行） */
export function writeContentDates(ledger: ContentDatesLedger, filePath: string = CONTENT_DATES_PATH): void {
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}
