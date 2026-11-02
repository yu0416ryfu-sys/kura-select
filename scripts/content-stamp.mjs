// 記事の「内容の更新日」台帳（data/content-dates.json）を記事の現状に合わせる。計画書5 §3（Part A）。
// sitemap の lastmod はこの台帳の日付になる（astro.config.mjs → scripts/lib/sitemap-lastmod.mjs）。
//
// 使い方:
//   pnpm content:stamp                     本文・title・description・faqs が変わった記事の日付を今日（JST）にする
//   pnpm content:stamp -- --dry            書き込まず、変わる記事だけ表示
//   pnpm content:stamp -- --date=YYYY-MM-DD  今日の代わりにこの日付を使う
//   pnpm content:stamp -- --keep-dates     ハッシュだけ更新して日付は据え置く
//                                          （pnpm inject-faqs の全件再実行など、読者に見える内容が変わらない一括処理の後）
//
// pnpm test（tests/content-stamp.test.ts）が台帳と記事のずれを検出して失敗するので、
// 記事を変えたらこのコマンドを実行して台帳を一緒にコミットする。
//
// ⚠ ハッシュの定義と台帳の更新規則は scripts/lib/content-stamp.ts に集約。ここは IO とレポートのみ。

import {
  collectStampArticles,
  readContentDates,
  stampContentDates,
  toJstDate,
  writeContentDates,
} from "./lib/content-stamp.ts";

const args = process.argv.slice(2);
const isDry = args.includes("--dry");
const keepDates = args.includes("--keep-dates");
const dateArg = args.find((a) => a.startsWith("--date="))?.slice("--date=".length);
if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error(`--date は YYYY-MM-DD で指定してください: ${dateArg}`);
  process.exit(1);
}
const today = dateArg ?? toJstDate(new Date());

const ledger = readContentDates() ?? {};
const result = stampContentDates(ledger, collectStampArticles(), today, { keepDates });

const lines = [
  ...result.added.map((slug) => `追加: ${slug}（${result.ledger[slug].contentUpdatedAt}）`),
  ...result.changed.map((slug) => `更新: ${slug}（${keepDates ? "日付据え置き" : today}）`),
  ...result.removed.map((slug) => `削除: ${slug}`),
];
if (lines.length === 0) {
  console.log("変更なし（台帳は記事と一致しています）");
  process.exit(0);
}
console.log(lines.join("\n"));
if (isDry) {
  console.log(`\n--dry のため書き込みません（${lines.length} 件）`);
} else {
  writeContentDates(result.ledger);
  console.log(`\ndata/content-dates.json を更新しました（${lines.length} 件）`);
}
