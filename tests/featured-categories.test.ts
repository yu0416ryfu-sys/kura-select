import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FEATURED_CATEGORY_LIMIT,
  countArticlesByCategory,
  pickFeaturedCategories,
} from "../src/lib/featured-categories";

const cat = (id: string, order: number) => ({ id, data: { order } });
const art = (categoryId: string, draft = false) => ({
  data: { draft, category: { id: categoryId } },
});

describe("countArticlesByCategory", () => {
  it("カテゴリごとに記事数を数える", () => {
    const counts = countArticlesByCategory([art("a"), art("a"), art("b")]);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
  });

  it("draft: true の記事は数えない（noindex 判定の母数と同じ基準）", () => {
    const counts = countArticlesByCategory([art("a"), art("a", true)]);
    expect(counts.get("a")).toBe(1);
  });

  it("記事0本のカテゴリはキー自体を持たない", () => {
    expect(countArticlesByCategory([art("a")]).has("b")).toBe(false);
  });
});

describe("pickFeaturedCategories", () => {
  it("記事数の多い順に並べる（order より記事数が優先）", () => {
    const categories = [cat("few", 1), cat("many", 99)];
    const articles = [art("many"), art("many"), art("few")];
    expect(pickFeaturedCategories(categories, articles).map((c) => c.id)).toEqual([
      "many",
      "few",
    ]);
  });

  it("記事数が同数なら order 昇順を保つ", () => {
    const categories = [cat("late", 20), cat("early", 2)];
    const articles = [art("late"), art("early")];
    expect(pickFeaturedCategories(categories, articles).map((c) => c.id)).toEqual([
      "early",
      "late",
    ]);
  });

  it("limit 件で打ち切る", () => {
    const categories = [cat("a", 1), cat("b", 2), cat("c", 3)];
    expect(pickFeaturedCategories(categories, [], 2)).toHaveLength(2);
  });

  it("入力配列を破壊しない", () => {
    const categories = [cat("b", 9), cat("a", 1)];
    const before = categories.map((c) => c.id);
    pickFeaturedCategories(categories, [art("b")]);
    expect(categories.map((c) => c.id)).toEqual(before);
  });

  it("記事0本のカテゴリも落ちずに末尾へ回る", () => {
    const categories = [cat("empty", 1), cat("filled", 9)];
    const picked = pickFeaturedCategories(categories, [art("filled")]);
    expect(picked.map((c) => c.id)).toEqual(["filled", "empty"]);
  });
});

// 実データに対する回帰テスト。order 昇順で切っていた頃は上位18件のうち8件が
// 記事1本以下（= noindex 対象）だった。記事数順にした意味が失われていないかを見張る。
describe("実データ", () => {
  const ARTICLES_DIR = "src/content/articles";
  const CATEGORIES_DIR = "src/content/categories";
  const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.mdx?$/.test(entry.name) ? [full] : [];
    });

  const articles = walk(ARTICLES_DIR)
    .map((file) => {
      const frontmatter = fs.readFileSync(file, "utf8").match(FRONTMATTER_RE)?.[0] ?? "";
      return {
        data: {
          draft: /^draft:\s*true/m.test(frontmatter),
          category: {
            id: (frontmatter.match(/^category:\s*["']?([^"'\r\n]+)/m)?.[1] ?? "").trim(),
          },
        },
      };
    })
    .filter((a) => a.data.category.id !== "");

  const categories = fs
    .readdirSync(CATEGORIES_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({
      id: file.replace(/\.md$/, ""),
      data: { order: Number(fs.readFileSync(path.join(CATEGORIES_DIR, file), "utf8").match(/^order:\s*(\d+)/m)?.[1] ?? 9999) },
    }));

  const counts = countArticlesByCategory(articles);
  const featured = pickFeaturedCategories(categories, articles);

  it("記事2本以上のカテゴリは1件残らず上位18件に入る", () => {
    const indexable = categories.filter((c) => (counts.get(c.id) ?? 0) >= 2).map((c) => c.id);
    const featuredIds = new Set(featured.map((c) => c.id));
    expect(indexable.filter((id) => !featuredIds.has(id))).toEqual([]);
    expect(indexable.length).toBeLessThanOrEqual(FEATURED_CATEGORY_LIMIT);
  });

  it("薄いカテゴリの露出は order 昇順だった頃（8件）より減っている", () => {
    const thinInFeatured = featured.filter((c) => (counts.get(c.id) ?? 0) <= 1).length;
    const thinInOrderTop = [...categories]
      .sort((a, b) => a.data.order - b.data.order)
      .slice(0, FEATURED_CATEGORY_LIMIT)
      .filter((c) => (counts.get(c.id) ?? 0) <= 1).length;
    expect(thinInFeatured).toBeLessThan(thinInOrderTop);
  });
});
