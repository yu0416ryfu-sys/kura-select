import { getThinCategoryRecrawlEntries } from "../../scripts/lib/thin-categories.mjs";
import { SITE } from "../lib/site";

// AdSense 是正（2026-10-07）: noindex 化した薄いカテゴリを Google に読み直させる一時サイトマップ。
// 08-14 に noindex 化と同時に本サイトマップから外したため、Google が再訪せず
// noindex 化前の状態のままインデックスに残っていた。
// 本サイトマップ（sitemap-index.xml）には載せず、robots.txt にも書かない。GSC から手動で送信する。
// 進み具合は `pnpm thin-cat:crawl-check`。撤去条件と手順は
// docs/IMPLEMENTATION_PLAN_THIN_CATEGORY_RECRAWL_2026-10-07.md §5（GSC 側の削除を先に行う）。
export function GET() {
  const urls = getThinCategoryRecrawlEntries()
    .map(({ slug, lastmod }: { slug: string; lastmod: string }) => {
      // slug をそのまま XML に埋め込むので、エスケープが要る文字が来たら build を止める
      if (/[&<>"']/.test(slug)) throw new Error(`sitemap-recrawl: XML に埋め込めない slug: ${slug}`);
      return `<url><loc>${SITE.url}/category/${slug}/</loc><lastmod>${lastmod}</lastmod></url>`;
    })
    .join("");
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
