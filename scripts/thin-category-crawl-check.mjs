// 薄いカテゴリの noindex 反映確認 CLI（AdSense 是正・一時サイトマップの撤去判定用）
//
// 使い方:
//   pnpm thin-cat:crawl-check          # 薄いカテゴリ全件を URL 検査にかける（読み取りのみ）
//   pnpm thin-cat:crawl-check -- --json
//
// 終了コード: 再クロール後も登録済み（noindex が出ていない疑い）か取得エラーがあれば 1。
// 未完了（古いクロールのまま登録済み）だけなら 0。
// 計画書: docs/IMPLEMENTATION_PLAN_THIN_CATEGORY_RECRAWL_2026-10-07.md
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import {
  getGscAuth,
  resolveServiceAccountKey,
  missingKeyMessage,
  SITE_URL,
} from './lib/gsc-client.mjs';
import { getThinCategorySlugs, NOINDEX_DEPLOYED_AT } from './lib/thin-categories.mjs';
import {
  classifyThinCrawl,
  summarizeThinCrawl,
  formatThinCrawlReport,
} from './lib/thin-category-crawl.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '../.env');

async function main() {
  const asJson = process.argv.slice(2).includes('--json');

  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    // .env が無くても環境変数で渡っていれば動く
  }

  if (!resolveServiceAccountKey()) {
    console.error(`❌ ${missingKeyMessage()}`);
    process.exitCode = 1;
    return;
  }

  const slugs = [...getThinCategorySlugs()].sort();
  const auth = await getGscAuth();
  const searchconsole = google.searchconsole({ version: 'v1', auth });

  const rows = [];
  // 逐次で呼ぶ（URL 検査 API の上限は 2,000件/日・600件/分なので数十件なら余裕がある）
  for (const slug of slugs) {
    const url = `${SITE_URL}category/${slug}/`;
    let inspection;
    try {
      const res = await searchconsole.urlInspection.index.inspect({
        requestBody: { inspectionUrl: url, siteUrl: SITE_URL },
      });
      const s = res.data.inspectionResult?.indexStatusResult ?? {};
      inspection = {
        verdict: s.verdict ?? null,
        indexingState: s.indexingState ?? null,
        coverageState: s.coverageState ?? null,
        lastCrawlTime: s.lastCrawlTime ?? null,
      };
    } catch (error) {
      inspection = { error: error.message };
    }
    rows.push({
      slug,
      state: classifyThinCrawl(inspection, NOINDEX_DEPLOYED_AT),
      verdict: inspection.verdict ?? null,
      lastCrawlTime: inspection.lastCrawlTime ?? null,
      coverageState: inspection.coverageState ?? inspection.error ?? null,
    });
  }

  const summary = summarizeThinCrawl(rows);
  if (asJson) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), summary, rows }, null, 2));
  } else {
    console.log(formatThinCrawlReport(rows, summary).join('\n'));
  }
  if (summary.anomalies.length > 0 || summary.errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`❌ ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
