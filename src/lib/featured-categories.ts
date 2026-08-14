// トップページのカテゴリタイルと Header のカテゴリメニューで共有する「注目カテゴリ」の選定ロジック。
//
// 記事数の多い順に上位 N 件だけを出す。order 昇順で切ると記事1本のカテゴリが多数入り込み
// （82件中67件が1本以下、order top18 のうち8件が該当）、AdSense の「有用性の低いコンテンツ」
// 対策で noindex にしたページへ人間の導線だけが残ってしまうため、記事数を主キーにしている。
// 同数のときは既存の並び（order 昇順）を保つ。
//
// astro:content に依存しないので Vitest から直接テストできる。呼び出し側（Header.astro /
// index.astro）が getCollection の結果をそのまま渡す。両者が別実装になるとタイルとメニューで
// 並びがずれるため、選定はこの1か所に集約する。

export const FEATURED_CATEGORY_LIMIT = 18;

interface CategoryLike {
  id: string;
  data: { order: number };
}

interface ArticleLike {
  data: { draft?: boolean; category: { id: string } };
}

// カテゴリ ID -> 公開記事数。draft の除外は category/[slug].astro の getStaticPaths
// （= noindex 判定の母数）と同じ基準にそろえる。
export function countArticlesByCategory(articles: ArticleLike[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const article of articles) {
    if (article.data.draft) continue;
    const id = article.data.category.id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// 記事数の多い順（同数は order 昇順）に上位 limit 件を返す。入力配列は破壊しない。
export function pickFeaturedCategories<C extends CategoryLike>(
  categories: C[],
  articles: ArticleLike[],
  limit: number = FEATURED_CATEGORY_LIMIT,
): C[] {
  const counts = countArticlesByCategory(articles);
  return [...categories]
    .sort(
      (a, b) =>
        (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.data.order - b.data.order,
    )
    .slice(0, limit);
}
