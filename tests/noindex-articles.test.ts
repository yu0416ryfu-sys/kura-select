import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  readNoindexArticles,
  getNoindexArticleSlugs,
  articleSlugFromUrl,
  isNoindexArticleUrl,
} from "../scripts/lib/noindex-articles.mjs";

const ARTICLES_DIR = path.resolve("./src/content/articles");

/** 公開記事の id（base からの相対パス・拡張子なし・区切りは /）を列挙する。draft は除く */
function listPublishedArticleIds(dir: string, base = dir): string[] {
  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      ids.push(...listPublishedArticleIds(full, base));
    } else if (/\.mdx?$/.test(entry.name)) {
      const frontmatter = fs.readFileSync(full, "utf8").split(/^---\s*$/m)[1] ?? "";
      if (/^draft:\s*true\s*$/m.test(frontmatter)) continue;
      ids.push(path.relative(base, full).replace(/\\/g, "/").replace(/\.mdx?$/, ""));
    }
  }
  return ids;
}

describe("data/noindex-articles.json", () => {
  const entries = readNoindexArticles();
  const published = new Set(listPublishedArticleIds(ARTICLES_DIR));

  it("slug がすべて実在する公開記事", () => {
    const missing = entries.map((e) => e.slug).filter((slug) => !published.has(slug));
    expect(missing).toEqual([]);
  });

  it("slug に重複がない", () => {
    const slugs = entries.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("各行に理由と YYYY-MM-DD の日付がある", () => {
    for (const e of entries) {
      expect(e.reason, e.slug).toBeTruthy();
      expect(e.date, e.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("articleSlugFromUrl / isNoindexArticleUrl", () => {
  const slugs = new Set(["razor-comparison", "reviews/foo-review"]);

  it("記事 URL から article.id の形の slug を取り出す（reviews/ を含む）", () => {
    expect(articleSlugFromUrl("https://www.kura-select.com/articles/razor-comparison/")).toBe("razor-comparison");
    expect(articleSlugFromUrl("https://www.kura-select.com/articles/reviews/foo-review/")).toBe("reviews/foo-review");
  });

  it("記事一覧・記事以外の URL は undefined", () => {
    expect(articleSlugFromUrl("https://www.kura-select.com/articles/")).toBeUndefined();
    expect(articleSlugFromUrl("https://www.kura-select.com/category/razor/")).toBeUndefined();
  });

  it("noindex の記事だけ true", () => {
    expect(isNoindexArticleUrl("https://www.kura-select.com/articles/razor-comparison/", slugs)).toBe(true);
    expect(isNoindexArticleUrl("https://www.kura-select.com/articles/reviews/foo-review/", slugs)).toBe(true);
    expect(isNoindexArticleUrl("https://www.kura-select.com/articles/toothpaste-comparison/", slugs)).toBe(false);
    expect(isNoindexArticleUrl("https://www.kura-select.com/articles/", slugs)).toBe(false);
  });

  it("既定の Set は JSON の slug と一致する", () => {
    expect([...getNoindexArticleSlugs()].sort()).toEqual(readNoindexArticles().map((e) => e.slug).sort());
  });
});
