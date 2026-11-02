import { defineConfig, envField } from "astro/config";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import rss from "@astrojs/rss";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import { getThinCategorySlugs, isThinCategoryUrl } from "./scripts/lib/thin-categories.mjs";
import { articleSlugFromUrl, getNoindexArticleSlugs, isNoindexArticleUrl } from "./scripts/lib/noindex-articles.mjs";
import { buildArticleLastmod } from "./scripts/lib/sitemap-lastmod.mjs";
import rehypePickButtons from "./src/lib/markdown/rehype-pick-buttons.ts";

// sitemap の記事 lastmod は「内容の更新日」（data/content-dates.json・無ければ publishedAt）。
// 価格同期で進む updatedAt は使わない。加筆したときだけ lastmod が進み、再クロールを促せる。計画書5 §3。
const articleLastmod = buildArticleLastmod();

// 記事1本以下のカテゴリページは noindex（src/pages/category/[slug].astro）なので sitemap からも外す。
// noindex なのに sitemap に載っていると GSC が「送信された URL に noindex タグが追加されています」
// とエラー扱いにするため。判定は scripts/lib/thin-categories.mjs に集約し、
// tests/thin-categories.test.ts で [slug].astro とのドリフトを検知する。
const thinCategorySlugs = getThinCategorySlugs();

// 入れ替えで外した記事（data/noindex-articles.json）も noindex なので sitemap から外す。
// 判定は scripts/lib/noindex-articles.mjs に集約し、ArticleLayout.astro と共有する。
const noindexArticleSlugs = getNoindexArticleSlugs();

export default defineConfig({
  site: "https://www.kura-select.com",
  // 末尾スラッシュを統一（GH Pages での重複URL・リンクエクイティ分散を防ぐ）
  trailingSlash: "always",
  integrations: [
    preact({ compat: true }),
    sitemap({
      // 検索ページ・記事一覧ページ・記事1本以下のカテゴリ・入れ替えで外した記事はインデックス対象外
      // （noindex 指定と整合）。それ以外の記事詳細（/articles/<slug>/）は除外しない。
      filter: (page) =>
        !page.endsWith("/search/") &&
        !page.endsWith("/articles/") &&
        !isThinCategoryUrl(page, thinCategorySlugs) &&
        !isNoindexArticleUrl(page, noindexArticleSlugs),
      serialize(item) {
        // reviews/<slug> も拾う（article.id と同じ形。noindex の判定と同じ helper）
        const slug = articleSlugFromUrl(item.url);
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
