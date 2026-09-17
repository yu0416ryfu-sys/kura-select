import { defineConfig, envField } from "astro/config";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import rss from "@astrojs/rss";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import { getThinCategorySlugs, isThinCategoryUrl } from "./scripts/lib/thin-categories.mjs";
import rehypePickButtons from "./src/lib/markdown/rehype-pick-buttons.ts";

// 記事 frontmatter の updatedAt（無ければ publishedAt）から sitemap の lastmod を作る。
// Google に「この URL は更新済み」と伝え、再クロールと SERP 日付の見直しを促す。
const ARTICLES_DIR = path.resolve("./src/content/articles");
const articleLastmod = new Map();
for (const file of fs.readdirSync(ARTICLES_DIR)) {
  if (!/\.mdx?$/.test(file)) continue;
  const frontmatter = fs.readFileSync(path.join(ARTICLES_DIR, file), "utf-8").split(/^---\s*$/m)[1] ?? "";
  const published = frontmatter.match(/^publishedAt:\s*"?([\d-]+)"?/m)?.[1];
  const updated = frontmatter.match(/^updatedAt:\s*"?([\d-]+)"?/m)?.[1];
  const date = updated ?? published;
  if (date) articleLastmod.set(file.replace(/\.mdx?$/, ""), new Date(date).toISOString());
}

// 記事1本以下のカテゴリページは noindex（src/pages/category/[slug].astro）なので sitemap からも外す。
// noindex なのに sitemap に載っていると GSC が「送信された URL に noindex タグが追加されています」
// とエラー扱いにするため。判定は scripts/lib/thin-categories.mjs に集約し、
// tests/thin-categories.test.ts で [slug].astro とのドリフトを検知する。
const thinCategorySlugs = getThinCategorySlugs();

export default defineConfig({
  site: "https://www.kura-select.com",
  // 末尾スラッシュを統一（GH Pages での重複URL・リンクエクイティ分散を防ぐ）
  trailingSlash: "always",
  integrations: [
    preact({ compat: true }),
    sitemap({
      // 検索ページ・記事一覧ページ・記事1本以下のカテゴリはインデックス対象外（noindex 指定と整合）。
      // 記事詳細（/articles/<slug>/）は除外しない。
      filter: (page) =>
        !page.endsWith("/search/") &&
        !page.endsWith("/articles/") &&
        !isThinCategoryUrl(page, thinCategorySlugs),
      serialize(item) {
        const slug = item.url.match(/\/articles\/([^/]+)\/?$/)?.[1];
        const lastmod = slug ? articleLastmod.get(slug) : undefined;
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
    mdx(),
  ],
  markdown: {
    // 本文の <!-- kura:pick-buttons ... --> を楽天ボタンに置き換える（マーカーの無い記事では何もしない）。
    // @astrojs/mdx は既定でこの設定を引き継ぐ。
    rehypePlugins: [rehypePickButtons],
  },
  vite: {
    plugins: [tailwindcss()],
  },
  env: {
    schema: {
      PUBLIC_RAKUTEN_AFFILIATE_ID: envField.string({
        context: "client",
        access: "public",
      }),
      PUBLIC_SITE_URL: envField.string({
        context: "client",
        access: "public",
        default: "https://www.kura-select.com",
      }),
    },
  },
  security: {
    checkOrigin: true,
  },
  // experimental.csp は Astro 6.1 では未サポート。
  // 将来のバージョンアップ時に security.csp として有効化予定。
  image: {
    domains: [],
  },
});
