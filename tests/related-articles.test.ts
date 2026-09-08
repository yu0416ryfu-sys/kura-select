import { describe, it, expect } from "vitest";
import {
  buildRelatedArticleMap,
  getRelatedArticles,
  RELATED_ARTICLE_COUNT,
  type RelatedArticleInput,
} from "../src/lib/relatedArticles.ts";

// docs/TODO.md §3「関連記事の fallback ロジック修正」に対応する。
// 3段目 fallback が最新記事を独占し、古い記事が関連枠から永久に選ばれない欠陥の再発防止。

interface Fixture extends RelatedArticleInput {}

function article(
  id: string,
  category: string,
  publishedAt: string,
  tags: string[] = [],
  draft = false
): Fixture {
  return { id, data: { category: { id: category }, publishedAt: new Date(publishedAt), tags, draft } };
}

/** 同一カテゴリも tag 共通もない孤立記事ばかりの集合（＝3段目 fallback だけで埋まる） */
function isolatedArticles(count: number): Fixture[] {
  return Array.from({ length: count }, (_, i) =>
    article(`a${String(i).padStart(2, "0")}`, `cat${i}`, `2026-0${(i % 9) + 1}-01`, [`tag${i}`])
  );
}

function inboundCounts(map: Map<string, Fixture[]>, articles: Fixture[]): Map<string, number> {
  const counts = new Map(articles.map((a) => [a.id, 0]));
  for (const picked of map.values()) {
    for (const target of picked) counts.set(target.id, (counts.get(target.id) ?? 0) + 1);
  }
  return counts;
}

describe("buildRelatedArticleMap / 基本の3段構え", () => {
  it("同一カテゴリを公開日の新しい順に優先する", () => {
    const articles = [
      article("self", "cat1", "2026-01-01"),
      article("old", "cat1", "2026-02-01"),
      article("new", "cat1", "2026-03-01"),
      article("other", "cat2", "2026-04-01"),
    ];
    const picked = buildRelatedArticleMap(articles).get("self")!.map((a) => a.id);
    expect(picked.slice(0, 2)).toEqual(["new", "old"]);
  });

  it("同一カテゴリで足りない分は tag の共通数が多い記事で補う", () => {
    const articles = [
      article("self", "cat1", "2026-01-01", ["掃除", "消耗品"]),
      article("overlap2", "cat2", "2026-01-02", ["掃除", "消耗品"]),
      article("overlap1", "cat3", "2026-01-03", ["掃除"]),
      article("overlap0", "cat4", "2026-06-01", ["食品"]),
    ];
    const picked = buildRelatedArticleMap(articles).get("self")!.map((a) => a.id);
    expect(picked.slice(0, 2)).toEqual(["overlap2", "overlap1"]);
  });

  it("draft はどの段でも候補にならない", () => {
    const articles = [
      article("self", "cat1", "2026-01-01"),
      article("hidden", "cat1", "2026-05-01", [], true),
      article("shown", "cat1", "2026-02-01"),
    ];
    const map = buildRelatedArticleMap(articles);
    expect(map.has("hidden")).toBe(false);
    expect(map.get("self")!.map((a) => a.id)).toEqual(["shown"]);
  });

  it("候補が足りなくても3件に満たないまま返す（重複で埋めない）", () => {
    const articles = [article("self", "cat1", "2026-01-01"), article("only", "cat2", "2026-01-02")];
    expect(buildRelatedArticleMap(articles).get("self")!.map((a) => a.id)).toEqual(["only"]);
  });

  it("候補が十分あれば必ず3件返す", () => {
    const articles = isolatedArticles(10);
    for (const a of articles) {
      expect(buildRelatedArticleMap(articles).get(a.id)!).toHaveLength(RELATED_ARTICLE_COUNT);
    }
  });
});

describe("buildRelatedArticleMap / 3段目 fallback の分散（本修正の主目的）", () => {
  it("公開日が最も新しい数本に fallback 枠が集中しない", () => {
    const articles = isolatedArticles(20);
    const counts = inboundCounts(buildRelatedArticleMap(articles), articles);
    // 旧実装（publishedAt 降順）は最新3本が 20枠すべてを取っていた
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(RELATED_ARTICLE_COUNT + 1);
  });

  it("公開日が最も古い記事も関連枠に選ばれる", () => {
    const articles = isolatedArticles(20);
    const counts = inboundCounts(buildRelatedArticleMap(articles), articles);
    const oldest = [...articles].sort(
      (a, b) => a.data.publishedAt.getTime() - b.data.publishedAt.getTime()
    )[0];
    expect(counts.get(oldest.id)!).toBeGreaterThan(0);
  });

  it("1段目・2段目で既に被リンクが多い記事は fallback で後回しになる", () => {
    // hub は cat1 の3本から同一カテゴリで参照される＝被リンクが多い
    const articles = [
      article("hub", "cat1", "2026-01-01"),
      article("cat1-a", "cat1", "2026-01-02"),
      article("cat1-b", "cat1", "2026-01-03"),
      article("cat1-c", "cat1", "2026-01-04"),
      article("lonely", "cat9", "2026-01-05"),
      article("seeker", "cat8", "2026-06-01"),
    ];
    const picked = buildRelatedArticleMap(articles).get("seeker")!.map((a) => a.id);
    expect(picked[0]).toBe("lonely");
    expect(picked.indexOf("lonely")).toBeLessThan(picked.indexOf("hub"));
  });
});

describe("buildRelatedArticleMap / 決定性", () => {
  it("入力の並び順が変わっても同じ結果になる", () => {
    const articles = isolatedArticles(15);
    const forward = buildRelatedArticleMap(articles);
    const reversed = buildRelatedArticleMap([...articles].reverse());
    for (const a of articles) {
      expect(reversed.get(a.id)!.map((x) => x.id)).toEqual(forward.get(a.id)!.map((x) => x.id));
    }
  });

  it("同じ入力を2回渡しても結果が変わらない", () => {
    const articles = isolatedArticles(12);
    const first = buildRelatedArticleMap(articles);
    const second = buildRelatedArticleMap(articles);
    for (const a of articles) {
      expect(second.get(a.id)!.map((x) => x.id)).toEqual(first.get(a.id)!.map((x) => x.id));
    }
  });
});

describe("getRelatedArticles / ページからの入口", () => {
  it("buildRelatedArticleMap と同じ結果を返す", () => {
    const articles = isolatedArticles(12);
    const map = buildRelatedArticleMap(articles);
    for (const a of articles) {
      expect(getRelatedArticles(a, articles).map((x) => x.id)).toEqual(
        map.get(a.id)!.map((x) => x.id)
      );
    }
  });

  it("自分自身は関連記事に入らない", () => {
    const articles = isolatedArticles(10);
    for (const a of articles) {
      expect(getRelatedArticles(a, articles).map((x) => x.id)).not.toContain(a.id);
    }
  });
});
