/**
 * 価格履歴抽出スクリプト（Phase 1）。
 *
 * git 履歴に蓄積済みの価格スナップショット（`商品データ更新` コミット）を
 * data/price-history/<articleId>.jsonl に構造化して取り出し、
 * 以後は update-products が同じ形式で追記し続ける。
 *
 * **記事ファイル・frontmatter は一切変更しない**（測定凍結を汚さない）。
 *
 * 使い方:
 *   pnpm price-history            # 現在のワークツリーから1時点分を追記
 *   pnpm price-history:backfill   # git 履歴から一括生成（ローカルで1回だけ）
 *   pnpm price-history:dry        # 書き込みなしで件数だけ確認
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';
import {
  buildRecordsFromArticle,
  mergeRecords,
  readArticleHistory,
  writeArticleHistory,
  appendPriceHistorySnapshot,
  toArticleId,
} from './lib/price-history.ts';

const ROOT = resolve(process.cwd());
const ARTICLES_PREFIX = 'src/content/articles/';
// backfill 対象コミットの件名。update-products.mjs / update-products.yml が付ける文言。
const BACKFILL_GREP = '商品データ更新';

function parseArgs(argv) {
  const options = { backfill: false, dryRun: false, grep: BACKFILL_GREP };

  for (const arg of argv) {
    if (arg === '--backfill') {
      options.backfill = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) {
      console.error(`不明な引数です: ${arg}`);
      process.exit(1);
    }
    const [, key, value] = match;
    if (key === 'grep') options.grep = value;
    else {
      console.error(`不明な引数です: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

function todayJst() {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * backfill: `商品データ更新` コミットを古い順に辿り、各時点の全記事からレコードを作る。
 *
 * - 各コミット時点の記事一覧は `git ls-tree` で取る（途中で削除・リネームされた記事を取りこぼさない）
 * - コミット日は author date をそのまま使う（既存コミットは JST 環境で作られているため TZ 変換しない）
 * - 同日に複数コミットがある場合は mergeRecords の後勝ちで最後の1件が残る
 */
function backfill(options) {
  const log = git([
    'log',
    '--format=%h %ad',
    '--date=short',
    `--grep=${options.grep}`,
  ])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [sha, date] = line.split(/\s+/);
      return { sha, date };
    })
    // git log は新しい順。同日複数コミットで「最後のコミットが残る」ようにするため逆順にする
    .reverse();

  console.log(`対象コミット: ${log.length}件`);
  if (log.length === 0) return;
  console.log(`期間: ${log[0].date} 〜 ${log[log.length - 1].date}`);

  /** @type {Map<string, import('./lib/price-history.ts').PriceHistoryRecord[]>} */
  const byArticle = new Map();
  let skipped = 0;
  let commitIndex = 0;

  for (const { sha, date } of log) {
    commitIndex += 1;
    let tree;
    try {
      tree = git(['ls-tree', '-r', '--name-only', sha, ARTICLES_PREFIX]);
    } catch {
      skipped += 1;
      continue;
    }

    const paths = tree
      .split('\n')
      .map(p => p.trim())
      .filter(p => (p.endsWith('.md') || p.endsWith('.mdx')) && !p.endsWith('.md.bak'));

    for (const path of paths) {
      let content;
      try {
        content = git(['show', `${sha}:${path}`]);
      } catch {
        skipped += 1;
        continue;
      }
      const articleId = toArticleId(path.slice(ARTICLES_PREFIX.length));
      const records = buildRecordsFromArticle(articleId, content, date, sha);
      if (records.length === 0) continue;
      byArticle.set(articleId, mergeRecords(byArticle.get(articleId) ?? [], records));
    }

    if (commitIndex % 10 === 0 || commitIndex === log.length) {
      console.log(`  ${commitIndex}/${log.length} コミット処理済み（記事 ${byArticle.size}本）`);
    }
  }

  let totalRows = 0;
  for (const [articleId, records] of byArticle) {
    // 既存ファイルがあれば失わないようマージする（backfill の再実行に耐える）
    const merged = mergeRecords(readArticleHistory(ROOT, articleId), records);
    totalRows += merged.length;
    if (!options.dryRun) writeArticleHistory(ROOT, articleId, merged);
  }

  console.log(`\n${options.dryRun ? '[dry-run] ' : ''}記事: ${byArticle.size}本 / 行数: ${totalRows} / スキップ: ${skipped}`);
  if (options.dryRun) console.log('⚠ --dry-run モード: ファイルは書き込みません');
}

function append(options) {
  const capturedAt = todayJst();
  const result = appendPriceHistorySnapshot({ root: ROOT, capturedAt, dryRun: options.dryRun });
  console.log(
    `${options.dryRun ? '[dry-run] ' : ''}capturedAt=${capturedAt} 記事: ${result.articles}本 / 新規行: ${result.newRows} / 上書き行: ${result.updatedRows}`
  );
  if (options.dryRun) console.log('⚠ --dry-run モード: ファイルは書き込みません');
}

const options = parseArgs(process.argv.slice(2));
if (options.backfill) backfill(options);
else append(options);
