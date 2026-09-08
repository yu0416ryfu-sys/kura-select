// コホート施策の再クロール確認 CLI（後窓の起点を決めるためのもの）
//
// 使い方:
//   pnpm cohort:crawl-check          # 台帳の lastCrawlAtApply を持つ行を確認
//   pnpm cohort:crawl-check -- --json
//
// 週次の `pnpm weekly:snapshot` が同じロジック（scripts/lib/cohort-crawl.ts）を
// 呼んでスナップショットに出力する。こちらは随時確認したいとき用。
//
// なぜ必要か: description / title の改稿は Google が再クロールするまで SERP に
// 出ない。デプロイ日を後窓の起点にすると窓の前半が旧スニペットの CTR になり、
// 施策を過小評価する（CLAUDE.md §5.0.2 / R2）。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import {
  getGscAuth,
  resolveServiceAccountKey,
  missingKeyMessage,
  SITE_URL,
} from './lib/gsc-client.mjs';
import {
  selectCohortCrawlTargets,
  evaluateCohortCrawl,
  formatCohortCrawlSection,
} from './lib/cohort-crawl.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '../.env');
const HOLDS_PATH = path.resolve(__dirname, '../data/measurement-holds.json');

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

  const ledger = JSON.parse(readFileSync(HOLDS_PATH, 'utf8'));
  const targets = selectCohortCrawlTargets(ledger, SITE_URL);
  if (targets.length === 0) {
    console.log('再クロール確認の対象はありません（台帳に lastCrawlAtApply を持つ行がない）。');
    return;
  }

  const auth = await getGscAuth();
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const inspections = new Map();
  for (const target of targets) {
    try {
      const res = await searchconsole.urlInspection.index.inspect({
        requestBody: { inspectionUrl: target.url, siteUrl: SITE_URL },
      });
      inspections.set(target.slug, {
        lastCrawlTime: res.data.inspectionResult?.indexStatusResult?.lastCrawlTime ?? null,
      });
    } catch (error) {
      inspections.set(target.slug, { error: error.message });
    }
  }

  const statuses = evaluateCohortCrawl(targets, inspections);
  if (asJson) {
    console.log(JSON.stringify(statuses, null, 2));
    return;
  }
  console.log(formatCohortCrawlSection(statuses).join('\n'));
}

main().catch((error) => {
  console.error(`❌ ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
