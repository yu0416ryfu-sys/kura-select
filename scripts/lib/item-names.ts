/**
 * 楽天の「実出品名」集約ユーティリティ（Phase 0.6）
 *
 * 計画書: docs/IMPLEMENTATION_PLAN_LOW_RANK_ARTICLE_LIFT_2026-08-23.md §4.2 / F17 / F25
 *
 * reports/ai-capacity-input-*.jsonl には update-products が毎週取得した
 * 楽天APIの実出品名（api.itemName）が残っている。これを集約して
 * Phase 1（カテゴリ適合スキャン）の入力にする。
 *
 * 設計上の要点:
 * - キーは (articleFile, rank) ではなく rakutenUrl の shopCode/itemCode。
 *   rank は limitProductsByRank() / reorderProductsByPricePerUnit() で
 *   入れ替わるため、85ファイルを遡ると同じ rank が別商品を指す期間がある（N14）。
 * - current.rakutenUrl が欠けるレコードは api.itemUrl にフォールバックする（v6）。
 * - method は必ず保持する。`[Search]`（キーワード検索フォールバック）由来は
 *   別商品の可能性があり、`[Item/Get]` と混ぜて判定してはいけない。
 * - 実出品名が取れなかった商品は unknown として明示する。error 0 と混同しない。
 */

import { toRakutenUrlKey } from './rakuten-url.ts';

/** ai-capacity-input-*.jsonl の1レコード（必要な範囲だけ型付け） */
export interface AiCapacityRecord {
  articleFile?: string;
  rank?: number;
  category?: string;
  method?: string;
  current?: { name?: string; rakutenUrl?: string | null } | null;
  api?: { itemName?: string; itemUrl?: string | null } | null;
}

/** 集約後の1エントリ（楽天商品キー単位） */
export interface ItemNameEntry {
  /** shopCode/itemCode（小文字） */
  key: string;
  /** 楽天APIが返した実出品名 */
  itemName: string;
  /** '[Item/Get]' / '[Search]' など。判定時に混ぜないため必ず保持する */
  method: string | null;
  /** キーの取得元。'current.rakutenUrl' か 'api.itemUrl'（フォールバック） */
  keySource: 'current.rakutenUrl' | 'api.itemUrl';
  /** 由来ファイルの日付（YYYY-MM-DD） */
  sourceDate: string;
  /** 由来レコードの articleFile / rank / current.name（参考情報。判定キーではない） */
  articleFile: string | null;
  rank: number | null;
  recordedName: string | null;
}

/** 出力JSONLの1行 */
export interface ItemNameRow {
  key: string;
  slug: string | null;
  articleFile: string | null;
  rank: number | null;
  /** 記事frontmatterの現在の商品名（historical-only なら null） */
  currentName: string | null;
  itemName: string | null;
  method: string | null;
  keySource: ItemNameEntry['keySource'] | null;
  sourceDate: string | null;
  /** 実出品名が取れたか。false は「判定不能」であって「問題なし」ではない */
  known: boolean;
  /** 現在の記事frontmatterに存在する商品か（false = 削除済み商品の履歴） */
  inCurrent: boolean;
}

/** 現 frontmatter 側の商品（母数993の実体） */
export interface CurrentProductRef {
  articleFile: string;
  slug: string;
  rank: number;
  name: string;
  rakutenUrl: string;
}

/** JSONL テキストを1行ずつパースする（壊れた行は捨てる） */
export function parseAiCapacityJsonl(text: string): AiCapacityRecord[] {
  const records: AiCapacityRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AiCapacityRecord;
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      // 途中で切れた行などは無視する
    }
  }
  return records;
}

/**
 * 1レコードから集約エントリを作る。
 * キーは current.rakutenUrl 優先、欠けていれば api.itemUrl にフォールバック。
 */
export function toItemNameEntry(
  record: AiCapacityRecord,
  sourceDate: string
): ItemNameEntry | null {
  const itemName = typeof record.api?.itemName === 'string' ? record.api.itemName.trim() : '';
  if (!itemName) return null;

  let key = toRakutenUrlKey(record.current?.rakutenUrl);
  let keySource: ItemNameEntry['keySource'] = 'current.rakutenUrl';
  if (!key) {
    key = toRakutenUrlKey(record.api?.itemUrl);
    keySource = 'api.itemUrl';
  }
  if (!key) return null;

  return {
    key,
    itemName,
    method: typeof record.method === 'string' && record.method ? record.method : null,
    keySource,
    sourceDate,
    articleFile: typeof record.articleFile === 'string' ? record.articleFile : null,
    rank: typeof record.rank === 'number' ? record.rank : null,
    recordedName: typeof record.current?.name === 'string' ? record.current.name : null,
  };
}

export interface JsonlSource {
  /** YYYY-MM-DD */
  date: string;
  text: string;
}

/**
 * 複数ファイルを集約する。同一キーは sourceDate が新しい方を採る
 * （同日なら後から渡された方＝呼び出し側のソート順で後ろが勝つ）。
 */
export function aggregateItemNames(sources: readonly JsonlSource[]): Map<string, ItemNameEntry> {
  const sorted = [...sources].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const aggregated = new Map<string, ItemNameEntry>();
  for (const source of sorted) {
    for (const record of parseAiCapacityJsonl(source.text)) {
      const entry = toItemNameEntry(record, source.date);
      if (!entry) continue;
      const existing = aggregated.get(entry.key);
      // 新しいファイルの値で上書きする（同日は後勝ち）
      if (existing && existing.sourceDate > entry.sourceDate) continue;
      aggregated.set(entry.key, entry);
    }
  }
  return aggregated;
}

/** src/content/articles/foo-comparison.md → foo */
export function toSlug(articleFile: string | null | undefined): string | null {
  if (typeof articleFile !== 'string' || !articleFile) return null;
  const base = articleFile.split(/[\\/]/).pop() ?? '';
  const withoutExt = base.replace(/\.mdx?$/, '');
  if (!withoutExt) return null;
  return withoutExt.replace(/-comparison$/, '');
}

/**
 * 現 frontmatter の全商品（母数）に集約結果を突き合わせて出力行を作る。
 * 集約にしかないキー（削除済み商品の履歴）は inCurrent:false で末尾に付ける
 * ——§4.8 の是正前 gel-ball 6件はここにしか存在しない（F25）。
 */
export function buildItemNameRows(
  aggregated: ReadonlyMap<string, ItemNameEntry>,
  currentProducts: readonly CurrentProductRef[],
  { includeHistorical = true }: { includeHistorical?: boolean } = {}
): ItemNameRow[] {
  const rows: ItemNameRow[] = [];
  const usedKeys = new Set<string>();

  for (const product of currentProducts) {
    const key = toRakutenUrlKey(product.rakutenUrl);
    const entry = key ? aggregated.get(key) : undefined;
    if (key) usedKeys.add(key);
    rows.push({
      key: key ?? '',
      slug: product.slug,
      articleFile: product.articleFile,
      rank: product.rank,
      currentName: product.name,
      itemName: entry?.itemName ?? null,
      method: entry?.method ?? null,
      keySource: entry?.keySource ?? null,
      sourceDate: entry?.sourceDate ?? null,
      known: Boolean(entry),
      inCurrent: true,
    });
  }

  if (includeHistorical) {
    for (const [key, entry] of aggregated) {
      if (usedKeys.has(key)) continue;
      rows.push({
        key,
        slug: toSlug(entry.articleFile),
        articleFile: entry.articleFile,
        rank: entry.rank,
        currentName: null,
        itemName: entry.itemName,
        method: entry.method,
        keySource: entry.keySource,
        sourceDate: entry.sourceDate,
        known: true,
        inCurrent: false,
      });
    }
  }

  return rows;
}

export interface CoverageSummary {
  /** 母数（現 frontmatter の商品数） */
  total: number;
  known: number;
  unknown: number;
  coverage: number;
  /** URLからキーが取れなかった現商品（判定以前の問題） */
  keyless: number;
  /** 集約にしか無い履歴エントリ（削除済み商品など） */
  historical: number;
  byMethod: { method: string; count: number }[];
  /** unknown が多い記事（欠損の偏りを見る） */
  unknownBySlug: { slug: string; unknown: number; total: number }[];
}

export function summarizeCoverage(rows: readonly ItemNameRow[]): CoverageSummary {
  const current = rows.filter(r => r.inCurrent);
  const known = current.filter(r => r.known);
  const methodCounts = new Map<string, number>();
  for (const row of known) {
    const method = row.method ?? '(method不明)';
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
  }
  const perSlug = new Map<string, { unknown: number; total: number }>();
  for (const row of current) {
    const slug = row.slug ?? '(不明)';
    const stat = perSlug.get(slug) ?? { unknown: 0, total: 0 };
    stat.total += 1;
    if (!row.known) stat.unknown += 1;
    perSlug.set(slug, stat);
  }

  return {
    total: current.length,
    known: known.length,
    unknown: current.length - known.length,
    coverage: current.length ? known.length / current.length : 0,
    keyless: current.filter(r => !r.key).length,
    historical: rows.length - current.length,
    byMethod: [...methodCounts.entries()]
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => b.count - a.count),
    unknownBySlug: [...perSlug.entries()]
      .map(([slug, stat]) => ({ slug, unknown: stat.unknown, total: stat.total }))
      .filter(s => s.unknown > 0)
      .sort((a, b) => b.unknown - a.unknown || (a.slug < b.slug ? -1 : 1)),
  };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** カバー率レポート（Markdown）。冒頭に母数と unknown を必ず書く */
export function formatCoverageReport(
  summary: CoverageSummary,
  { today, sourceFileCount, jsonlPath }: { today: string; sourceFileCount: number; jsonlPath: string }
): string {
  const lines: string[] = [];
  lines.push(`# 実出品名カバー率レポート（${today}）`);
  lines.push('');
  lines.push(`- 母数（現 frontmatter の商品数）: **${summary.total}**`);
  lines.push(`- 実出品名あり: **${summary.known}**（${pct(summary.coverage)}）`);
  lines.push(`- **unknown（実出品名なし＝判定不能）: ${summary.unknown}**`);
  lines.push('');
  lines.push('> unknown は「問題なし（error 0）」ではなく **判定不能** です。');
  lines.push('> 欠損が多い記事は Phase 3 の目視に回すか、`--dump-item-names` で補完してください。');
  lines.push('');
  lines.push(`- 集約元: \`reports/ai-capacity-input-*.jsonl\` ${sourceFileCount} ファイル`);
  lines.push(`- 出力: \`${jsonlPath}\``);
  lines.push(`- rakutenUrl からキーを取れなかった現商品: ${summary.keyless}`);
  lines.push(`- 現商品に紐づかない履歴エントリ（削除済み商品など）: ${summary.historical}`);
  lines.push('');
  lines.push('## method 内訳（実出品名ありのみ）');
  lines.push('');
  lines.push('| method | 件数 |');
  lines.push('|---|---:|');
  for (const row of summary.byMethod) {
    lines.push(`| \`${row.method}\` | ${row.count} |`);
  }
  lines.push('');
  lines.push('> `[Search]`（キーワード検索フォールバック）由来は別商品の可能性があるため、');
  lines.push('> `[Item/Get]` と混ぜて判定しないこと（§4.2）。');
  lines.push('');
  lines.push('## unknown が残っている記事');
  lines.push('');
  if (summary.unknownBySlug.length === 0) {
    lines.push('（なし）');
  } else {
    lines.push('| slug | unknown | 商品数 |');
    lines.push('|---|---:|---:|');
    for (const row of summary.unknownBySlug) {
      lines.push(`| ${row.slug} | ${row.unknown} | ${row.total} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
