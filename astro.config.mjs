import { defineConfig, envField } from "astro/config";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import rss from "@astrojs/rss";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://www.kura-select.com",
  // 末尾スラッシュを統一（GH Pages での重複URL・リンクエクイティ分散を防ぐ）
  trailingSlash: "always",
  integrations: [
    preact({ compat: true }),
    sitemap(),
    mdx(),
  ],
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
