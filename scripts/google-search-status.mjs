// Google 検索ステータス（https://status.search.google.com/）の告知を取得し、測定窓との重なりを出す CLI
//
// 使い方:
//   pnpm search-status                                   # 取得して履歴に追記し、直近の告知と凍結中の施策の窓との重なりを表示
//   pnpm search-status -- --window=2026-10-13:2026-11-09 # 任意の窓（複数可）との重なり
//   pnpm search-status -- --offline                      # 取得せず data/google-search-status.json だけで判定
//   pnpm search-status -- --as-of=2026-11-13             # 継続中の告知を何日まで続いているとみなすか（既定は今日 JST）
//
// 重なりの扱い（CLAUDE.md §5.0.2 ルール6）: core＝暫定 / spam・障害＝注記 / 対象外の地域・言語＝参考
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  findOverlaps,
  formatOverlap,
  holdWindows,
  kindLabel,
  toJstDate,
  windowVerdict,
} from './lib/google-search-status.ts';
import { loadSearchStatus, SEARCH_STATUS_PATH } from './lib/google-search-status-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOLDS_PATH = path.resolve(__dirname, '../data/measurement-holds.json');

function parseArgs(argv) {
  const options = { offline: false, windows: [], asOf: toJstDate(new Date().toISOString()) };
  for (const arg of argv) {
    if (arg === '--offline') options.offline = true;
    else if (arg.startsWith('--window=')) {
      const [start, end] = arg.slice('--window='.length).split(':');
      if (!start || !end) throw new Error(`--window は START:END で指定してください: ${arg}`);
      options.windows.push({ label: '指定', start, end });
    } else if (arg.startsWith('--as-of=')) options.asOf = arg.slice('--as-of='.length);
    else if (arg !== '--') throw new Error(`不明な引数: ${arg}`);
  }
  return options;
}

function printOverlaps(label, window, incidents, asOf) {
  const overlaps = findOverlaps(incidents, window, asOf);
  console.log(`- ${label}（${window.start}〜${window.end}）: ${windowVerdict(overlaps)}`);
  for (const o of overlaps) console.log(`    ・${formatOverlap(o)}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const status = await loadSearchStatus({ offline: options.offline });
  if (!status.available) {
    console.error(`❌ 取得できず、保存分もありません: ${status.error}`);
    process.exitCode = 1;
    return;
  }
  if (status.source === 'cache' && status.error) console.warn(`⚠️ 取得に失敗したので保存分で判定します: ${status.error}`);
  console.log(`履歴: ${path.relative(process.cwd(), SEARCH_STATUS_PATH)}（${status.incidents.length} 件・${status.source === 'live' ? '取得済み' : '保存分'}）`);
  console.log(`継続中の告知は ${options.asOf}（JST）まで続いているとみなします\n`);

  console.log('## 直近の告知（新しい順・上位10件）');
  for (const i of status.incidents.slice(0, 10)) {
    console.log(`- ${i.beginDate}〜${i.endDate ?? '（継続中）'} ${i.title}（${kindLabel(i.kind)}・${i.service}）`);
  }

  if (options.windows.length > 0) {
    console.log('\n## 指定した窓');
    for (const w of options.windows) printOverlaps(w.label, w, status.incidents, options.asOf);
  }

  const holds = JSON.parse(readFileSync(HOLDS_PATH, 'utf8'));
  const windows = holdWindows(holds.holds ?? []);
  if (windows.length > 0) {
    console.log('\n## 凍結台帳にある施策の窓（前窓＝起点前28日・後窓＝起点〜解除日の目安）');
    for (const h of windows) printOverlaps(`${h.slug} ${h.label}`, h.window, status.incidents, options.asOf);
  }
}

main().catch((error) => {
  console.error(`❌ ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
