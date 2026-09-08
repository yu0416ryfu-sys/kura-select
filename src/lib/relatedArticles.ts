/**
 * 関連記事（記事下部の3枠）の選定ロジック。
 *
 * 選定は3段構え:
 *   1. 同一カテゴリ（公開日の新しい順）
 *   2. tag の共通数が多い記事（カテゴリ横断）
 *   3. それでも3枠に足りない分を補う fallback
 *
 * 3段目はもともと「公開日の新しい順」だったため、fallback の枠（実測53枠）が
 * **最新記事の数本に独占**され、公開が古く同一カテゴリ記事も tag 共通もない記事は
 * 関連枠から永久に選ばれなかった（cotton-swab の被リンク0本の原因・docs/TODO.md §3）。
 *
 * そこで 3段目は「その時点で関連枠の被リンクが最も少ない記事」を選ぶ貪欲法にした。
 * 全記事を id 昇順で1回だけ走査してグラフを作るため、どのページから呼んでも結果は同じ。
 * 実測: 関連枠の被リンク0本が 65記事 → 12記事、最新3本への集中（20/19/14枠）が解消する。
 */

/** 選定に必要な最小限の形。astro:content に依存させず Vitest から直接テストできるようにする。 */
export interface RelatedArticleInput {
  id: string;
  data: {
    category: { id: string };
    publishedAt: Date;
    tags?: string[];
    draft?: boolean;
  };
}

/** 関連記事として表示する件数 */
export const RELATED_ARTICLE_COUNT = 3;

/** FNV-1a。fallback の同数タイブレークを「記事ごとに違うが決定的」にするためだけに使う。 */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function publishedTime(article: RelatedArticleInput): number {
  return article.data.publishedAt.getTime();
}

/** 1段目: 同一カテゴリを公開日の新しい順に（従来の挙動を維持） */
function sameCategoryTier<T extends RelatedArticleInput>(article: T, candidates: T[]): T[] {
  return candidates
    .filter((a) => a.data.category.id === article.data.category.id)
    .sort((a, b) => publishedTime(b) - publishedTime(a));
}

/** 2段目: tag の共通数が多い順（同数は公開日の新しい順。従来の挙動を維持） */
function tagOverlapTier<T extends RelatedArticleInput>(article: T, candidates: T[]): T[] {
  const currentTags = new Set(article.data.tags ?? []);
  return candidates
    .filter((a) => a.data.category.id !== article.data.category.id)
    .map((a) => ({
      article: a,
      overlap: (a.data.tags ?? []).filter((t) => currentTags.has(t)).length,
    }))
    .filter((x) => x.overlap > 0)
    .sort(
      (x, y) =>
        y.overlap - x.overlap || publishedTime(y.article) - publishedTime(x.article)
    )
    .map((x) => x.article);
}

/**
 * 全記事分の関連記事を一度に決める。
 * 貪欲法なので個別に計算できず、必ずこの関数でグラフごと組み立てる。
 */
export function buildRelatedArticleMap<T extends RelatedArticleInput>(
  articles: T[]
): Map<string, T[]> {
  const pool = articles.filter((a) => !a.data.draft);

  // pass 1: 1段目・2段目だけで確定する被リンク数（3段目の初期スコア）
  const inboundCount = new Map<string, number>(pool.map((a) => [a.id, 0]));
  for (const article of pool) {
    const candidates = pool.filter((a) => a.id !== article.id);
    const decided = dedupe([
      ...sameCategoryTier(article, candidates),
      ...tagOverlapTier(article, candidates),
    ]).slice(0, RELATED_ARTICLE_COUNT);
    for (const picked of decided) {
      inboundCount.set(picked.id, (inboundCount.get(picked.id) ?? 0) + 1);
    }
  }

  // pass 2: 3段目を「被リンクが少ない順」で埋める。
  // 走査順を id 昇順に固定しているので、ページのビルド順に依らず結果は同じ。
  const related = new Map<string, T[]>();
  for (const article of [...pool].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const candidates = pool.filter((a) => a.id !== article.id);
    const sameCategory = sameCategoryTier(article, candidates);
    const byTagOverlap = tagOverlapTier(article, candidates);
    const priorIds = new Set([...sameCategory, ...byTagOverlap].map((a) => a.id));

    const fallback = candidates
      .filter((a) => a.data.category.id !== article.data.category.id)
      .sort(
        (x, y) =>
          (inboundCount.get(x.id) ?? 0) - (inboundCount.get(y.id) ?? 0) ||
          hashString(`${x.id}:${article.id}`) - hashString(`${y.id}:${article.id}`) ||
          (x.id < y.id ? -1 : 1)
      );

    const picked = dedupe([...sameCategory, ...byTagOverlap, ...fallback]).slice(
      0,
      RELATED_ARTICLE_COUNT
    );
    related.set(article.id, picked);

    // 3段目で拾った分だけスコアに反映する（1段目・2段目は pass 1 で計上済み）
    for (const target of picked) {
      if (!priorIds.has(target.id)) {
        inboundCount.set(target.id, (inboundCount.get(target.id) ?? 0) + 1);
      }
    }
  }
  return related;
}

/** 優先順位を保ったまま id の重複を除く */
function dedupe<T extends RelatedArticleInput>(articles: T[]): T[] {
  return [...new Map(articles.map((a) => [a.id, a])).values()];
}

// ページごとに全記事を走査し直すと 117 回同じ計算をするのでメモ化する。
const mapCache = new Map<string, Map<string, RelatedArticleInput[]>>();

function cacheKey(articles: RelatedArticleInput[]): string {
  return articles
    .map((a) => a.id)
    .sort()
    .join("|");
}

/** 記事ページから呼ぶ入口。同じ記事集合なら1回だけグラフを組み立てる。 */
export function getRelatedArticles<T extends RelatedArticleInput>(
  article: T,
  articles: T[]
): T[] {
  const key = cacheKey(articles);
  let built = mapCache.get(key) as Map<string, T[]> | undefined;
  if (!built) {
    built = buildRelatedArticleMap(articles);
    mapCache.set(key, built as Map<string, RelatedArticleInput[]>);
  }
  return built.get(article.id) ?? [];
}
