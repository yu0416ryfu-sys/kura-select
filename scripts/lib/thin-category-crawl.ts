// 薄いカテゴリの noindex が Google に届いたかの判定（AdSense 是正・2026-10-07）。
//
// なぜ必要か: 08-14 に薄いカテゴリを noindex にしたとき sitemap からも外したため、
// Google が再訪せず、noindex 化前の状態のままインデックスに残っていた。
// 一時サイトマップ（src/pages/sitemap-recrawl.xml.ts）で再クロールを促し、
// その進み具合を URL 検査 API の結果からここで機械的に判定する。
// 撤去条件と手順は docs/IMPLEMENTATION_PLAN_THIN_CATEGORY_RECRAWL_2026-10-07.md §5。

export type ThinCrawlState =
  | 'excluded-noindex' // noindex が読まれて除外 → 完了
  | 'dropped-after' // 未登録、かつ境界より後にクロール → 完了
  | 'stale-indexed' // 登録済み、かつ境界以前のクロール（or 不明）→ 未完了（本命の待ち）
  | 'indexed-after' // 登録済み、かつ境界より後にクロール → 異常（noindex が出ていない疑い）
  | 'not-indexed' // 未登録、かつ境界以前のクロール（or 未クロール）→ 完了
  | 'error'; // API エラー

/** URL 検査 API の indexStatusResult から取り出す値。欠けることがあるので全部 optional */
export interface ThinCrawlInspection {
  verdict?: string | null;
  indexingState?: string | null;
  coverageState?: string | null;
  lastCrawlTime?: string | null;
  error?: string;
}

export interface ThinCrawlRow {
  slug: string;
  state: ThinCrawlState;
  lastCrawlTime: string | null;
  coverageState: string | null;
  verdict: string | null;
}

export interface ThinCrawlSummary {
  counts: Record<ThinCrawlState, number>;
  /** インデックスに残っている・判定できないものが0件 */
  done: boolean;
  anomalies: string[];
  errors: string[];
}

const ALL_STATES: ThinCrawlState[] = [
  'excluded-noindex',
  'dropped-after',
  'not-indexed',
  'stale-indexed',
  'indexed-after',
  'error',
];

/** 完了扱いの state（インデックスに無い）。noindex は静的 HTML なので次のクロールでも必ず読まれる */
const DONE_STATES = new Set<ThinCrawlState>(['excluded-noindex', 'dropped-after', 'not-indexed']);

/** lastCrawlTime が境界より後か。読めない日付は「境界以前」に倒す */
function crawledAfter(lastCrawlTime: string | null | undefined, boundary: string): boolean {
  if (!lastCrawlTime) return false;
  const crawled = new Date(lastCrawlTime).getTime();
  const bound = new Date(boundary).getTime();
  if (Number.isNaN(crawled) || Number.isNaN(bound)) return false;
  return crawled > bound;
}

/**
 * 1件の URL 検査結果を分類する（上から順に評価）。
 * 「登録済み」は coverageState の文言（言語設定で変わりうる）ではなく verdict === 'PASS' で見る。
 */
export function classifyThinCrawl(i: ThinCrawlInspection, noindexDeployedAt: string): ThinCrawlState {
  if (i.error) return 'error';
  if (i.indexingState === 'BLOCKED_BY_META_TAG') return 'excluded-noindex';
  const after = crawledAfter(i.lastCrawlTime, noindexDeployedAt);
  if (i.verdict === 'PASS') return after ? 'indexed-after' : 'stale-indexed';
  // FAIL（404・5xx 等）も「インデックスに無い」ので完了側。レポートの coverageState で目視する
  return after ? 'dropped-after' : 'not-indexed';
}

export function summarizeThinCrawl(rows: Pick<ThinCrawlRow, 'slug' | 'state'>[]): ThinCrawlSummary {
  const counts = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<ThinCrawlState, number>;
  for (const row of rows) counts[row.state] += 1;
  return {
    counts,
    done: rows.every((r) => DONE_STATES.has(r.state)),
    anomalies: rows.filter((r) => r.state === 'indexed-after').map((r) => r.slug),
    errors: rows.filter((r) => r.state === 'error').map((r) => r.slug),
  };
}

const STATE_LABEL: Record<ThinCrawlState, string> = {
  'excluded-noindex': '✅ noindex で除外',
  'dropped-after': '✅ 再クロール後に未登録',
  'not-indexed': '✅ 未登録',
  'stale-indexed': '⏳ 古いクロールのまま登録済み',
  'indexed-after': '🚨 再クロール後も登録済み',
  error: '⚠️ 取得エラー',
};

export function formatThinCrawlReport(rows: ThinCrawlRow[], summary: ThinCrawlSummary): string[] {
  const lines: string[] = [];
  lines.push(`## 薄いカテゴリの noindex 反映状況（${rows.length}件）`);
  lines.push('');
  lines.push('| 状態 | 件数 |');
  lines.push('|---|---|');
  for (const state of ALL_STATES) lines.push(`| ${STATE_LABEL[state]} | ${summary.counts[state]} |`);
  lines.push('');
  lines.push(
    summary.done
      ? '**完了**: すべてインデックスに無い。GSC で sitemap-recrawl.xml を削除してから一時サイトマップを撤去する（計画書 §5 R-6 → R-7）。'
      : '**未完了**: インデックスに残っている URL がある。',
  );
  lines.push('');

  if (summary.anomalies.length > 0) {
    lines.push('🚨 再クロール後も登録済み: ライブ HTML の `<meta name="robots">` に noindex が出ているか確認する');
    for (const slug of summary.anomalies) lines.push(`- ${slug}`);
    lines.push('');
  }
  if (summary.errors.length > 0) {
    lines.push('⚠️ 取得エラー: 認証切れ（invalid_grant 等）を疑う');
    for (const slug of summary.errors) lines.push(`- ${slug}`);
    lines.push('');
  }

  const pending = rows.filter((r) => !DONE_STATES.has(r.state) && r.state !== 'error');
  if (pending.length > 0) {
    lines.push('| 未完了のカテゴリ | 状態 | 最終クロール | coverageState |');
    lines.push('|---|---|---|---|');
    for (const r of pending) {
      lines.push(`| ${r.slug} | ${STATE_LABEL[r.state]} | ${r.lastCrawlTime ?? '-'} | ${r.coverageState ?? '-'} |`);
    }
    lines.push('');
  }

  // 完了扱いでも verdict FAIL（404・5xx 等）はページが壊れている兆候なので目視できるよう出す
  const failed = rows.filter((r) => r.verdict === 'FAIL');
  if (failed.length > 0) {
    lines.push('参考（verdict FAIL・ページが壊れていないか確認する）:');
    for (const r of failed) lines.push(`- ${r.slug}: ${r.coverageState}`);
    lines.push('');
  }
  return lines;
}
