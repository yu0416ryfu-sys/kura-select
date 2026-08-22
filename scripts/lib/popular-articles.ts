// 人気記事欄（src/data/popularArticles.ts）の自動選定ロジック（純関数のみ）
//
// ファイル I/O・API 呼び出しはここには置かない（テストから直接呼べるようにするため）。
// CLI は scripts/generate-popular-articles.mjs 側。
// 計画書: docs/IMPLEMENTATION_PLAN_POPULAR_ARTICLES_AUTO_2026-08-22.md
//
// ⚠ Node ESM（--experimental-strip-types）解決のため相対 import は拡張子 .ts を必須にする。
import { toPagePath } from "./gsc-harvest.ts";

/** GSC を dimensions:["page"] で取得した1行 */
export interface GscPageRow {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** data/popular-articles-policy.json の正規化済みの形 */
export interface PopularPolicy {
  slots: number;
  minClicks: number;
  pinned: string[];
  excluded: string[];
  spotlight: string | null;
}

/** 記事単位に合算した実績 */
export interface ArticleStat {
  id: string;
  clicks: number;
  impressions: number;
  /** impressions 合計が 0 のときは順位不明として null */
  position: number | null;
}

export type DropReason =
  | "not-article"
  | "not-found"
  | "draft"
  | "excluded"
  | "below-min-clicks";

export interface DroppedEntry {
  id: string;
  reason: DropReason;
}

export interface SelectionResult {
  ids: string[];
  dropped: DroppedEntry[];
  /** slots に対して足りなかった件数（0 なら充足） */
  shortfall: number;
}

export interface RenderMeta {
  baselinePath: string;
  startDate: string;
  endDate: string;
  generatedAt: string;
  policyPath: string;
}

export const DEFAULT_POLICY: PopularPolicy = {
  slots: 6,
  minClicks: 1,
  pinned: [],
  excluded: [],
  spotlight: null,
};

/**
 * article id 正規化の唯一の入口。
 *
 * id は「GSC の URL」「src/content/articles 配下のファイルパス」「policy JSON の手書き」の
 * 3経路から来る。同じ正規化を通さないと、除外したはずの記事が除外されない形で静かに壊れる。
 * とくに Windows では reviews\foo.md のような区切りになるため `\` → `/` 変換が必須。
 * 大文字小文字の変換はしない（既存 id はすべて小文字。変換すると将来 id を取り違える）。
 */
export function normalizeArticleId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let value = raw;
  try {
    value = decodeURIComponent(value);
  } catch {
    // 不正なパーセントエンコードは生のまま扱う
  }
  value = value.trim();
  value = value.replace(/\\/g, "/");
  value = value.replace(/^\/+/, "");
  value = value.replace(/^articles\//, "");
  value = value.replace(/\/+$/, "");
  value = value.replace(/\.mdx?$/, "");
  return value;
}

/**
 * GSC の page URL から article id を取り出す。
 * `/articles/<id>/` 以外（カテゴリ・トップ・固定ページ・不正 URL）は null。
 *
 * pathname 化は toPagePath に任せる（正規化の入口を増やさないため）。
 * toPagePath はパース失敗時に生値をそのまま返すが、その値は `/articles/` で始まらないので
 * ここで自然に null に落ちる。
 */
export function toArticleId(page: unknown): string | null {
  if (typeof page !== "string" || page === "") return null;
  const pathname = toPagePath(page);
  if (!pathname.startsWith("/articles/")) return null;
  // フラグメント・クエリを落としてから正規化する
  const withoutHash = pathname.split("#")[0]!.split("?")[0]!;
  const id = normalizeArticleId(withoutHash);
  return id === "" ? null : id;
}

/**
 * pageRows を article id ごとに合算する。
 * position は impressions を重みとする加重平均（単純平均だと表示1回の行が同じ重みを持つ）。
 */
export function aggregatePageRows(rows: readonly GscPageRow[]): ArticleStat[] {
  const acc = new Map<
    string,
    { clicks: number; impressions: number; weighted: number }
  >();

  for (const row of rows ?? []) {
    const id = toArticleId(row?.page);
    if (!id) continue;
    const clicks = Number(row.clicks) || 0;
    const impressions = Number(row.impressions) || 0;
    const position = Number(row.position) || 0;
    const current = acc.get(id) ?? { clicks: 0, impressions: 0, weighted: 0 };
    current.clicks += clicks;
    current.impressions += impressions;
    current.weighted += position * impressions;
    acc.set(id, current);
  }

  return [...acc.entries()].map(([id, v]) => ({
    id,
    clicks: v.clicks,
    impressions: v.impressions,
    position: v.impressions > 0 ? v.weighted / v.impressions : null,
  }));
}

/** policy JSON を PopularPolicy に正規化する。欠けたキーは DEFAULT_POLICY で補う。 */
export function normalizePolicy(raw: unknown): PopularPolicy {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const slots = Number(source.slots);
  const minClicks = Number(source.minClicks);

  const toIdList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const ids = value.map((item) => normalizeArticleId(item)).filter((id) => id !== "");
    return [...new Set(ids)];
  };

  const spotlightRaw = normalizeArticleId(source.spotlight);

  return {
    slots: Number.isFinite(slots) && slots > 0 ? Math.floor(slots) : DEFAULT_POLICY.slots,
    minClicks:
      Number.isFinite(minClicks) && minClicks >= 0
        ? Math.floor(minClicks)
        : DEFAULT_POLICY.minClicks,
    pinned: toIdList(source.pinned),
    excluded: toIdList(source.excluded),
    spotlight: spotlightRaw === "" ? null : spotlightRaw,
  };
}

/**
 * 候補の絞り込みだけを行う（計画書 §3.3 の手順3〜6）。
 *
 * - pinned / spotlight は stats に行が無くても clicks:0 で補う
 *   （GSC で1表示も無い記事は pageRows に出ないため。育てたい記事が黙って消えるのを防ぐ）
 * - pinned / spotlight は minClicks を免除するが、実在確認（availableIds）は免除しない
 * - excluded は pinned / spotlight に優先する（凍結を守る指定が掲載強制に負けてはならない）
 */
export function filterEligible(
  stats: readonly ArticleStat[],
  policy: PopularPolicy,
  availableIds: ReadonlySet<string>,
): { eligible: ArticleStat[]; dropped: DroppedEntry[] } {
  const excluded = new Set(policy.excluded);
  const privileged = new Set<string>([
    ...policy.pinned,
    ...(policy.spotlight ? [policy.spotlight] : []),
  ]);

  const byId = new Map<string, ArticleStat>();
  for (const stat of stats) byId.set(stat.id, stat);

  // GSC に行が無い pinned / spotlight を clicks:0 で補う
  const candidates: ArticleStat[] = [...stats];
  for (const id of privileged) {
    if (byId.has(id)) continue;
    candidates.push({ id, clicks: 0, impressions: 0, position: null });
  }

  const eligible: ArticleStat[] = [];
  const dropped: DroppedEntry[] = [];

  for (const stat of candidates) {
    if (excluded.has(stat.id)) {
      dropped.push({ id: stat.id, reason: "excluded" });
      continue;
    }
    if (!availableIds.has(stat.id)) {
      dropped.push({ id: stat.id, reason: "not-found" });
      continue;
    }
    if (!privileged.has(stat.id) && stat.clicks < policy.minClicks) {
      dropped.push({ id: stat.id, reason: "below-min-clicks" });
      continue;
    }
    eligible.push(stat);
  }

  return { eligible, dropped };
}

/** 並べ替え: clicks 降順 → impressions 降順 → position 昇順（null は最下位）→ id 昇順 */
function compareStats(a: ArticleStat, b: ArticleStat): number {
  if (b.clicks !== a.clicks) return b.clicks - a.clicks;
  if (b.impressions !== a.impressions) return b.impressions - a.impressions;
  const ap = a.position ?? Number.POSITIVE_INFINITY;
  const bp = b.position ?? Number.POSITIVE_INFINITY;
  if (ap !== bp) return ap - bp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 最終構成を確定する（計画書 §3.3 の手順7〜10）。
 * pinned を先頭に固定し、spotlight を末尾1枠に確保して slots 件で切る。
 */
export function selectPopularArticles(
  stats: readonly ArticleStat[],
  policy: PopularPolicy,
  availableIds: ReadonlySet<string>,
): SelectionResult {
  const { eligible, dropped } = filterEligible(stats, policy, availableIds);
  const eligibleIds = new Set(eligible.map((s) => s.id));

  const pinned = policy.pinned.filter((id) => eligibleIds.has(id));
  const pinnedSet = new Set(pinned);

  const spotlight =
    policy.spotlight && eligibleIds.has(policy.spotlight) && !pinnedSet.has(policy.spotlight)
      ? policy.spotlight
      : null;

  const rest = eligible
    .filter((s) => !pinnedSet.has(s.id) && s.id !== spotlight)
    .sort(compareStats)
    .map((s) => s.id);

  // spotlight は末尾1枠。実績枠と育成枠を見た目でも分けるため、順位の中には混ぜない。
  const autoSlots = Math.max(0, policy.slots - pinned.length - (spotlight ? 1 : 0));
  const ids = [...pinned, ...rest.slice(0, autoSlots)];
  if (spotlight) ids.push(spotlight);

  return {
    ids,
    dropped,
    shortfall: Math.max(0, policy.slots - ids.length),
  };
}

/** 前回リストとの差分（§9-9 の安全弁と CLI 出力に使う） */
export function diffSelection(
  prevIds: readonly string[],
  nextIds: readonly string[],
): { added: string[]; removed: string[]; changed: number } {
  const prev = new Set(prevIds);
  const next = new Set(nextIds);
  const added = [...next].filter((id) => !prev.has(id));
  const removed = [...prev].filter((id) => !next.has(id));
  return { added, removed, changed: Math.max(added.length, removed.length) };
}

/** src/data/popularArticles.ts の中身を組み立てる */
export function renderPopularArticlesFile(
  ids: readonly string[],
  meta: RenderMeta,
): string {
  const lines = [
    "// このファイルは pnpm generate-popular が生成しています。手で編集しないでください。",
    `// 出典: ${meta.baselinePath}`,
    `// 窓: ${meta.startDate} 〜 ${meta.endDate}（GSC 確定日基準）`,
    `// 生成: ${meta.generatedAt}`,
    `// 運用ポリシー: ${meta.policyPath}`,
    "export const popularArticleIds = [",
    ...ids.map((id) => `  ${JSON.stringify(id)},`),
    "] as const;",
    "",
  ];
  return lines.join("\n");
}
