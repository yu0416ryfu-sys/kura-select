import { defineConfig, envField } from "astro/config";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import rss from "@astrojs/rss";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";

// カスタムドメイン設定時は base を削除し site を変更する
const GITHUB_PAGES_SITE = "https://yu0416ryfu-sys.github.io";
const BASE_PATH = "/kura-select";

export default defineConfig({
  site: GITHUB_PAGES_SITE,
  base: BASE_PATH,
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
        default: "https://yu0416ryfu-sys.github.io/kura-select",
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
