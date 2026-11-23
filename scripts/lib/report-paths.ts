// reports/ に書くファイルのパスを組み立てる（update-products から使う）
// 計画書: docs/IMPLEMENTATION_PLAN_REPORTS_OUTPUT_CLEANUP_2026-11-23.md §4・§5-1
import { join, posix } from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// parseSlashRegExp()（update-products.mjs）と同じ式
const SLASH_REGEXP_RE = /^\/(.+)\/([dgimsuvy]*)$/;
const ARTICLE_STEM_RE = /^[a-z0-9-]+$/;
const FILTER_NAME_MAX = 40;

function assertDate(today: string): void {
  if (typeof today !== 'string' || !DATE_RE.test(today)) {
    throw new Error(`today は YYYY-MM-DD で渡してください: "${String(today)}"`);
  }
}

/** capacity の確認が要る商品の追記先（直下の1本だけ） */
export function capacityInputPath(reportsRoot: string, today: string): string {
  assertDate(today);
  return join(reportsRoot, `ai-capacity-input-${today}.jsonl`);
}

/** フィルタ（ワイルドカード・正規表現など）をファイル名に使える形にする */
function toFilterName(value: string): string {
  const cleaned = value
    .replace(/[^a-z0-9-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, FILTER_NAME_MAX)
    .replace(/_+$/g, '');
  return `filter-${cleaned || 'x'}`;
}

/** --file= の値から、追加候補のファイル名に入れる対象を決める（計画書 §4 の表。上から順に判定） */
export function additionReportScope(fileFilter: string | null | undefined): string {
  // 順1: 指定なし
  const raw = String(fileFilter ?? '').trim().toLowerCase();
  if (!raw) return 'all';

  // 順2: /…/ の形の正規表現
  if (SLASH_REGEXP_RE.test(raw)) return toFilterName(raw);

  // normalizeArticleFileName() と同じく、\ を / にして basename を取る
  const base = posix.basename(raw.replace(/\\/g, '/')).trim();

  // 順3: ワイルドカード（名前は元の値から作る）
  if (/[*?]/.test(base)) return toFilterName(raw);

  // 順4: 記事ファイル1本
  const stem = base.replace(/\.md$/, '');
  if (ARTICLE_STEM_RE.test(stem)) return stem;

  // 順5: それ以外
  return toFilterName(raw);
}

/** 追加候補の2ファイル。同じ日・同じ対象なら同じパスになる（上書き） */
export function additionReportPaths(
  dir: string,
  today: string,
  fileFilter: string | null | undefined,
): { candidatesPath: string; urlsPath: string } {
  assertDate(today);
  const scope = additionReportScope(fileFilter);
  return {
    candidatesPath: join(dir, `addition-candidates-${today}-${scope}.md`),
    urlsPath: join(dir, `addition-urls-${today}-${scope}.md`),
  };
}
