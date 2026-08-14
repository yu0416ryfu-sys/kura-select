import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCategorySlugById,
  getPublishedArticleCountByCategory,
  getThinCategorySlugs,
  isThinCategoryUrl,
  ARTICLES_DIR,
  CATEGORIES_DIR,
} from "../scripts/lib/thin-categories.mjs";

// ---------------------------------------------------------------------------
// フィクスチャ（draft / slug ずれ など、実データでは再現できないケース用）
// ---------------------------------------------------------------------------

let fixtureRoot: string;
let fxArticles: string;
let fxCategories: string;

function writeArticle(name: string, frontmatter: string) {
  fs.writeFileSync(
    path.join(fxArticles, name),
    `---\n${frontmatter}\n---\n\n本文\n`,
    "utf-8"
  );
}

function writeCategory(name: string, frontmatter: string) {
  fs.writeFileSync(
    path.join(fxCategories, name),
    `---\n${frontmatter}\n---\n`,
    "utf-8"
  );
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "thin-cat-"));
  fxArticles = path.join(fixtureRoot, "articles");
  fxCategories = path.join(fixtureRoot, "categories");
  fs.mkdirSync(fxArticles);
  fs.mkdirSync(fxCategories);

  // solo: 公開記事1本だけ → 薄い
  writeCategory("solo.md", 'name: "ソロ"\nslug: solo');
  writeArticle("solo-a.md", 'title: "A"\ncategory: "solo"');

  // pair: 公開記事2本 → 薄くない
  writeCategory("pair.md", 'name: "ペア"\nslug: pair');
  writeArticle("pair-a.md", 'title: "A"\ncategory: "pair"');
  writeArticle("pair-b.md", 'title: "B"\ncategory: "pair"');

  // drafty: 公開1本 + draft 1本 → draft を数えなければ薄い
  writeCategory("drafty.md", 'name: "ドラフト"\nslug: drafty');
  writeArticle("drafty-a.md", 'title: "A"\ncategory: "drafty"');
  writeArticle("drafty-b.md", 'title: "B"\ncategory: "drafty"\ndraft: true');

  // renamed: ファイル ID と slug が異なる（将来の改名に備えた検証）
  writeCategory("renamed.md", 'name: "改名"\nslug: renamed-slug');
  writeArticle("renamed-a.md", 'title: "A"\ncategory: "renamed"');

  // empty: 記事0本 → 薄い
  writeCategory("empty.md", 'name: "空"\nslug: empty');

  // noslug: slug frontmatter が無い → ファイル ID にフォールバック
  writeCategory("noslug.md", 'name: "スラッグなし"');
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("getCategorySlugById", () => {
  it("slug frontmatter を読む", () => {
    const map = getCategorySlugById(fxCategories);
    expect(map.get("renamed")).toBe("renamed-slug");
    expect(map.get("solo")).toBe("solo");
  });

  it("slug が無ければファイル ID にフォールバックする", () => {
    expect(getCategorySlugById(fxCategories).get("noslug")).toBe("noslug");
  });
});

describe("getPublishedArticleCountByCategory", () => {
  it("カテゴリごとの公開記事数を数える", () => {
    const counts = getPublishedArticleCountByCategory(fxArticles);
    expect(counts.get("solo")).toBe(1);
    expect(counts.get("pair")).toBe(2);
  });

  it("draft: true の記事は数えない", () => {
    // drafty は md が2本あるが、公開は1本だけ
    expect(getPublishedArticleCountByCategory(fxArticles).get("drafty")).toBe(1);
  });
});

describe("getThinCategorySlugs", () => {
  const thin = () => getThinCategorySlugs(fxArticles, fxCategories);

  it("記事1本のカテゴリを薄いと判定する", () => {
    expect(thin().has("solo")).toBe(true);
  });

  it("記事2本以上のカテゴリは薄いと判定しない", () => {
    expect(thin().has("pair")).toBe(false);
  });

  it("draft を除くと1本になるカテゴリは薄いと判定する", () => {
    expect(thin().has("drafty")).toBe(true);
  });

  it("記事0本のカテゴリも薄いと判定する", () => {
    expect(thin().has("empty")).toBe(true);
  });

  it("ファイル ID ではなく slug を返す", () => {
    const t = thin();
    expect(t.has("renamed-slug")).toBe(true);
    expect(t.has("renamed")).toBe(false);
  });
});

describe("isThinCategoryUrl", () => {
  // describe 本体は beforeAll より先に評価されるため、Set の生成は it の中で行う
  // （フィクスチャ未作成のまま呼ぶと既定引数で実データを読んでしまう）
  const thin = () => getThinCategorySlugs(fxArticles, fxCategories);

  it("薄いカテゴリの URL を判定する", () => {
    expect(isThinCategoryUrl("https://example.com/category/solo/", thin())).toBe(true);
  });

  it("薄くないカテゴリの URL は false", () => {
    expect(isThinCategoryUrl("https://example.com/category/pair/", thin())).toBe(false);
  });

  it("カテゴリ以外の URL は false", () => {
    expect(isThinCategoryUrl("https://example.com/articles/solo-a/", thin())).toBe(false);
    expect(isThinCategoryUrl("https://example.com/", thin())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 実データに対する検証（sitemap と noindex のドリフト検知）
//
// src/pages/category/[slug].astro は `articles.length <= 1` で noindex を出す。
// このモジュールは sitemap 側で同じ判定をするので、両者の対象件数が
// 食い違うと「noindex なのに sitemap に載っている」状態になる。
// ---------------------------------------------------------------------------

describe("実データ", () => {
  it("記事ディレクトリ・カテゴリディレクトリが実在する", () => {
    expect(fs.existsSync(ARTICLES_DIR)).toBe(true);
    expect(fs.existsSync(CATEGORIES_DIR)).toBe(true);
  });

  it("全カテゴリが薄い / 薄くないのどちらかに分類される", () => {
    const total = getCategorySlugById().size;
    const thin = getThinCategorySlugs().size;

    expect(total).toBeGreaterThan(0);
    expect(thin).toBeGreaterThan(0);
    expect(thin).toBeLessThan(total);
  });

  it("サブディレクトリの記事も数える（content.config.ts の glob は ** で再帰する）", () => {
    // src/content/articles/reviews/shampoo-pantene-damage-care-review.md が category: "shampoo"。
    // トップレベルしか読まない実装だと shampoo を誤って「記事1本＝薄い」と判定してしまう。
    // 2026-08-14 に実際に踏んだ回帰なので、ここで固定する。
    const counts = getPublishedArticleCountByCategory();
    expect(counts.get("shampoo")).toBeGreaterThanOrEqual(2);
    expect(getThinCategorySlugs().has("shampoo")).toBe(false);
  });

  it("数えた記事総数が .md/.mdx の実ファイル数と一致する（draft を除く）", () => {
    // モジュール内のロジックとは別実装で列挙し、取りこぼしを検知する
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return /\.mdx?$/.test(e.name) ? [full] : [];
      });

    const published = walk(ARTICLES_DIR).filter(
      (f) => !/^draft:\s*true\s*$/m.test(fs.readFileSync(f, "utf-8").split(/^---\s*$/m)[1] ?? "")
    );

    const counted = [...getPublishedArticleCountByCategory().values()].reduce((a, b) => a + b, 0);
    expect(counted).toBe(published.length);
  });
});
