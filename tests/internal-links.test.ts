import { describe, it, expect } from "vitest";
import {
  hrefToSlug,
  extractPageLinks,
  buildLinkGraph,
  summarizeLinks,
  suggestLinkSources,
  findGenericTags,
  isComparisonSlug,
  type PageLinks,
} from "../scripts/lib/internal-links.ts";

/**
 * 内部リンクグラフ（低順位記事の底上げ Phase 2）のテスト。
 *
 * v1（本文リンクのみ）と v2（fallback 除外）はどちらも「孤立」を過小評価した。
 * v4 の方式が壊れていないことを HTML フィクスチャで固定する。
 */

/** 実際のビルド成果物と同じ形（<article> が複数・<aside> は1個） */
function page({
  body = "",
  auto = null,
}: { body?: string; auto?: string | null } = {}) {
  const aside = auto === null ? "" : `<aside class="related"><h2>関連記事</h2>${auto}</aside>`;
  return `<header><nav><a href="/articles/">記事一覧</a></nav></header>
<main><article class="post"><article class="card">${body}</article><article class="card"></article></main>
${aside}
<footer><a href="/articles/">記事一覧</a></footer>`;
}

const link = (slug: string) => `<a href="/articles/${slug}/">${slug}</a>`;

describe("internal-links: href の解釈", () => {
  it("記事URLから slug を取る", () => {
    expect(hrefToSlug("/articles/toilet-paper-comparison/")).toBe("toilet-paper-comparison");
    expect(hrefToSlug("/articles/reviews/shampoo-review/")).toBe("reviews/shampoo-review");
  });

  it("記事一覧ちょうどは数えない（header の nav 由来）", () => {
    expect(hrefToSlug("/articles/")).toBeNull();
    expect(hrefToSlug("/articles")).toBeNull();
  });

  it("記事以外のパスは数えない", () => {
    expect(hrefToSlug("/category/toilet-paper/")).toBeNull();
    expect(hrefToSlug("/about/")).toBeNull();
  });

  it("クエリ・アンカーを落とす", () => {
    expect(hrefToSlug("/articles/foo-comparison/#比較表")).toBe("foo-comparison");
    expect(hrefToSlug("/articles/foo-comparison/?utm=1")).toBe("foo-comparison");
  });
});

describe("internal-links: 本文と自動関連の判別", () => {
  it("最初の <aside> より前が本文、以降が自動関連", () => {
    const html = page({ body: link("a-comparison") + link("b-comparison"), auto: link("c-comparison") });
    const links = extractPageLinks("self-comparison", html);
    expect(links.body).toEqual(["a-comparison", "b-comparison"]);
    expect(links.auto).toEqual(["c-comparison"]);
    expect(links.hasAside).toBe(true);
  });

  it("<article> は境界にならない（1ページに複数ある）", () => {
    const html = page({ body: link("a-comparison"), auto: link("b-comparison") });
    expect((html.match(/<article/g) ?? []).length).toBeGreaterThan(1);
    expect((html.match(/<aside/g) ?? []).length).toBe(1);
    const links = extractPageLinks("self-comparison", html);
    expect(links.body).toEqual(["a-comparison"]);
  });

  it("<aside> が無ければ全体を本文として数える", () => {
    const html = page({ body: link("a-comparison"), auto: null });
    const links = extractPageLinks("self-comparison", html);
    expect(links.hasAside).toBe(false);
    expect(links.body).toEqual(["a-comparison"]);
    expect(links.auto).toEqual([]);
  });

  it("自己リンクは数えない", () => {
    const html = page({ body: link("self-comparison") + link("a-comparison"), auto: link("self-comparison") });
    const links = extractPageLinks("self-comparison", html);
    expect(links.body).toEqual(["a-comparison"]);
    expect(links.auto).toEqual([]);
  });

  it("header / footer の記事一覧リンクを数えない", () => {
    const html = page({ body: "", auto: "" });
    const links = extractPageLinks("self-comparison", html);
    expect(links.body).toEqual([]);
    expect(links.auto).toEqual([]);
  });
});

describe("internal-links: グラフの集計", () => {
  const pages: PageLinks[] = [
    { slug: "hub-comparison", body: ["target-comparison", "target-comparison", "mid-comparison"], auto: ["mid-comparison"], hasAside: true },
    { slug: "target-comparison", body: [], auto: ["hub-comparison"], hasAside: true },
    { slug: "mid-comparison", body: ["hub-comparison"], auto: [], hasAside: true },
    { slug: "lonely-comparison", body: ["hub-comparison"], auto: [], hasAside: true },
    { slug: "auto-only-comparison", body: [], auto: [], hasAside: true },
  ];
  // auto-only は誰からも張られていないが、自動関連から1本もらう形にする
  pages[0].auto.push("auto-only-comparison");

  const graph = buildLinkGraph(pages);
  const bySlug = (slug: string) => graph.stats.find(s => s.slug === slug)!;

  it("被リンクはリンク元ページ数で数える（同じページからの重複は1）", () => {
    expect(bySlug("target-comparison").inboundBody).toBe(1);
    expect(bySlug("target-comparison").inboundBodyFrom).toEqual(["hub-comparison"]);
  });

  it("本文も自動関連も被リンク0なら優先1（孤立）", () => {
    expect(bySlug("lonely-comparison").priority).toBe(1);
    expect(bySlug("lonely-comparison").inboundBody).toBe(0);
    expect(bySlug("lonely-comparison").inboundAuto).toBe(0);
  });

  it("自動関連からだけ張られていれば優先2", () => {
    expect(bySlug("auto-only-comparison").priority).toBe(2);
    expect(bySlug("auto-only-comparison").inboundAuto).toBe(1);
  });

  it("被リンクはあるが本文から出リンクが無ければ優先3", () => {
    expect(bySlug("target-comparison").priority).toBe(3);
    expect(bySlug("target-comparison").outboundBody).toBe(0);
  });

  it("被リンクも出リンクもあれば優先なし", () => {
    expect(bySlug("hub-comparison").priority).toBeNull();
  });

  it("孤立率は comparison 記事に対して出す", () => {
    const summary = summarizeLinks(graph);
    expect(summary.comparisonPages).toBe(5);
    expect(summary.isolated).toBe(1);
    expect(summary.isolatedRate).toBeCloseTo(0.2);
  });

  it("comparison 以外のページを comparison の母数に混ぜない", () => {
    const withReview = buildLinkGraph([
      ...pages,
      { slug: "reviews/shampoo-review", body: [], auto: [], hasAside: true },
    ]);
    const summary = summarizeLinks(withReview);
    expect(summary.pages).toBe(6);
    expect(summary.comparisonPages).toBe(5);
    expect(isComparisonSlug("reviews/shampoo-review")).toBe(false);
  });
});

describe("internal-links: リンク追加候補", () => {
  const pages: PageLinks[] = [
    { slug: "lonely-comparison", body: [], auto: [], hasAside: true },
    { slug: "sibling-a-comparison", body: [], auto: [], hasAside: true },
    { slug: "sibling-frozen-comparison", body: [], auto: [], hasAside: true },
    { slug: "other-category-comparison", body: [], auto: [], hasAside: true },
  ];
  const graph = buildLinkGraph(pages);
  const categories = new Map([
    ["lonely-comparison", { category: "toilet-paper", tags: ["トイレットペーパー"] }],
    ["sibling-a-comparison", { category: "toilet-paper", tags: ["トイレットペーパー"] }],
    ["sibling-frozen-comparison", { category: "toilet-paper", tags: [] }],
    ["other-category-comparison", { category: "shampoo", tags: [] }],
  ]);

  it("同一カテゴリの記事だけを推奨リンク元にする", () => {
    const suggestions = suggestLinkSources(graph.stats, categories, { frozenSlugs: new Set(), available: true });
    const lonely = suggestions.find(s => s.target === "lonely-comparison")!;
    expect(lonely.sources).toEqual(["sibling-a-comparison", "sibling-frozen-comparison"]);
    expect(lonely.sources).not.toContain("other-category-comparison");
  });

  it("凍結中の記事はリンク元にしない（リンク元の本文を編集するため）", () => {
    const suggestions = suggestLinkSources(graph.stats, categories, {
      frozenSlugs: new Set(["sibling-frozen-comparison"]),
      available: true,
    });
    const lonely = suggestions.find(s => s.target === "lonely-comparison")!;
    expect(lonely.sources).toEqual(["sibling-a-comparison"]);
  });

  it("候補が無ければ理由を書く", () => {
    const suggestions = suggestLinkSources(graph.stats, categories, {
      frozenSlugs: new Set(["sibling-a-comparison", "sibling-frozen-comparison"]),
      available: true,
    });
    const lonely = suggestions.find(s => s.target === "lonely-comparison")!;
    expect(lonely.sources).toEqual([]);
    expect(lonely.note).toContain("凍結中");
  });

  it("すでに本文から張られているリンク元は候補にしない", () => {
    const linked = buildLinkGraph([
      { slug: "lonely-comparison", body: [], auto: [], hasAside: true },
      { slug: "sibling-a-comparison", body: ["lonely-comparison"], auto: [], hasAside: true },
      { slug: "sibling-frozen-comparison", body: [], auto: [], hasAside: true },
    ]);
    const suggestions = suggestLinkSources(
      linked.stats,
      categories,
      { frozenSlugs: new Set(), available: true }
    );
    // lonely は本文被リンクを得たので優先2以下ではなくなる（候補対象から外れる）
    expect(suggestions.find(s => s.target === "lonely-comparison")).toBeUndefined();
    const frozen = suggestions.find(s => s.target === "sibling-frozen-comparison")!;
    expect(frozen.sources).toContain("sibling-a-comparison");
  });
});

describe("internal-links: 汎用タグの除外", () => {
  it("多数の記事に付いているタグを主題タグとして扱わない", () => {
    // 実測の分布: まとめ買い50記事 / コスパ39 / 日用品30 / 節約26 に対し次点は6記事
    const metas = new Map(
      Array.from({ length: 10 }, (_, i) => [
        `a${i}-comparison`,
        { category: `cat-${i}`, tags: i < 8 ? ["まとめ買い", `固有${i}`] : ["まとめ買い"] },
      ])
    );
    const generic = findGenericTags(metas, 0.1);
    expect(generic.has("まとめ買い")).toBe(true);
    expect(generic.has("固有0")).toBe(false);
  });

  it("汎用タグしか共有しない記事は候補にならない", () => {
    const pages: PageLinks[] = [
      { slug: "lonely-comparison", body: [], auto: [], hasAside: true },
      { slug: "unrelated-comparison", body: [], auto: [], hasAside: true },
      { slug: "related-comparison", body: [], auto: [], hasAside: true },
      { slug: "filler-comparison", body: [], auto: [], hasAside: true },
    ];
    const metas = new Map([
      ["lonely-comparison", { category: "cat-litter", tags: ["コスパ", "猫砂"] }],
      ["unrelated-comparison", { category: "acne-patch", tags: ["コスパ"] }],
      ["related-comparison", { category: "cat-food", tags: ["コスパ", "猫砂"] }],
      ["filler-comparison", { category: "rice", tags: ["コスパ"] }],
    ]);
    // 既定の 0.1 は記事115本を前提にした値。4本のフィクスチャでは
    // どのタグも汎用になってしまうので、しきい値を明示する
    const suggestions = suggestLinkSources(
      buildLinkGraph(pages).stats,
      metas,
      { frozenSlugs: new Set(), available: true },
      { genericTagRatio: 0.9 }
    );
    const lonely = suggestions.find(s => s.target === "lonely-comparison")!;
    // 「コスパ」は4記事中4記事＝汎用。猫砂タグを共有する related だけが残る
    expect(lonely.sources).toEqual(["related-comparison"]);
    expect(lonely.sources).not.toContain("unrelated-comparison");
  });

  it("カテゴリが引けない記事を全記事と同一カテゴリ扱いにしない", () => {
    // metaBySlug のキーが dist の slug と食い違うと全件 undefined になり、
    // undefined === undefined で全記事が同一カテゴリ扱いされていた
    const pages: PageLinks[] = [
      { slug: "lonely-comparison", body: [], auto: [], hasAside: true },
      { slug: "other-comparison", body: [], auto: [], hasAside: true },
    ];
    const suggestions = suggestLinkSources(
      buildLinkGraph(pages).stats,
      new Map(),
      { frozenSlugs: new Set(), available: true }
    );
    for (const suggestion of suggestions) {
      expect(suggestion.sources).toEqual([]);
      expect(suggestion.note).not.toBeNull();
    }
  });
});
