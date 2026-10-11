// 日用品価格レポート（計画書6）の集計。ランタイム依存を持たない純粋関数のみを置く。
// I/O（履歴・名簿・frontmatter の読み込みと JSON の書き出し）は scripts/build-price-report.mjs が担当する。
// 乱数・現在時刻は使わない（同じ入力と as-of から同じ結果が出ること）。

import { extractCapacityTotal } from './capacity.ts';
import type { PriceHistoryProvider, PriceHistoryRecord } from './price-history.ts';

// ── 定数（手順4 の実データで見直す。計画書 §10） ─────────────────────────

export const DEFAULT_BASE_MONTH = '2026-05';
export const DEFAULT_MIN_PAIRS = 30;
export const DEFAULT_MIN_GROUP_PAIRS = 20;
/** 月の取得日数がこれ未満なら、その月の値を null にする */
export const MIN_CAPTURE_DAYS = 3;
/** 第2段・段差の始点: 基準に対する比がこの範囲の外 */
export const SUSPECT_LOW = 0.6;
export const SUSPECT_HIGH = 1.6;
/** 整数倍・整数分の1 とみなす許容幅（±8%） */
export const SET_MULTIPLE_TOLERANCE = 0.08;
/** 段差の戻り判定の帯（L0 の ±15%） */
export const RETURN_LOW = 0.85;
export const RETURN_HIGH = 1.15;
/** 段差の最大長（暦日） */
export const LEVEL_SHIFT_MAX_DAYS = 84;
/** 値下がり判定: 直近28日中央値より 10% 以上安い */
export const DISCOUNT_WINDOW_DAYS = 28;
export const DISCOUNT_THRESHOLD = 0.9;
export const DISCOUNT_MIN_HISTORY = 3;

// ── 小道具 ───────────────────────────────────────────────────────────────

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

function addDays(date: string, n: number): string {
  return new Date((dayNumber(date) + n) * 86_400_000).toISOString().slice(0, 10);
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── 系列 ─────────────────────────────────────────────────────────────────

/** 系列＝記事×productKey×provider。provider を混ぜない（§3.2） */
export function seriesKeyOf(r: Pick<PriceHistoryRecord, 'provider' | 'articleId' | 'productKey'>): string {
  return `${r.provider}\t${r.articleId}\t${r.productKey}`;
}

export function parseSeriesKey(key: string): { provider: PriceHistoryProvider; articleId: string; productKey: string } {
  const [provider, articleId, productKey] = key.split('\t');
  return { provider: provider as PriceHistoryProvider, articleId, productKey };
}

export interface SeriesObs {
  date: string;
  price: number;
  capacity: string | null;
  name: string;
  itemCode: string | null;
}

export interface Series {
  key: string;
  provider: PriceHistoryProvider;
  articleId: string;
  productKey: string;
  /** capturedAt の昇順・同日は1点（中央値）に畳んだ観測 */
  obs: SeriesObs[];
}

/**
 * 行を系列に束ねる。価格 0・欠損の行は捨てる。同じ系列の同日の行は中央値1点に畳む。
 * 入力の行の順番に結果が依存しないよう、すべて明示的に sort する。
 */
export function groupSeries(records: readonly PriceHistoryRecord[]): Series[] {
  const byKey = new Map<string, PriceHistoryRecord[]>();
  for (const r of records) {
    if (!(typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0)) continue;
    const k = seriesKeyOf(r);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const out: Series[] = [];
  for (const key of [...byKey.keys()].sort(cmp)) {
    const rows = byKey.get(key)!;
    const byDate = new Map<string, PriceHistoryRecord[]>();
    for (const r of rows) {
      const list = byDate.get(r.capturedAt);
      if (list) list.push(r);
      else byDate.set(r.capturedAt, [r]);
    }
    const obs: SeriesObs[] = [...byDate.keys()].sort(cmp).map((date) => {
      const same = [...byDate.get(date)!].sort(
        (a, b) => a.price - b.price || cmp(a.capacity ?? '', b.capacity ?? '') || cmp(a.name, b.name),
      );
      return {
        date,
        price: median(same.map((r) => r.price)),
        capacity: same[0].capacity,
        name: same[0].name,
        itemCode: same[0].itemCode,
      };
    });
    const { provider, articleId, productKey } = parseSeriesKey(key);
    out.push({ key, provider, articleId, productKey, obs });
  }
  return out;
}

// ── 取得不具合の除外（§3.2 第1〜3段） ──────────────────────────────────

/** 照合用に `shop/code` を小文字にする */
export function normalizeItemCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return code.trim().toLowerCase();
}

/**
 * 第1段: 価格帯（選択式）の出品の系列を除外する。**provider = rakuten の系列だけ**（B2）。
 * itemCode が null の系列は外さない。
 */
export function excludePriceRangeSeries(
  series: readonly Series[],
  priceRangeCodes: ReadonlySet<string>,
): { kept: Series[]; excluded: Series[] } {
  const kept: Series[] = [];
  const excluded: Series[] = [];
  for (const s of series) {
    const hit =
      s.provider === 'rakuten' &&
      s.obs.some((o) => {
        const c = normalizeItemCode(o.itemCode);
        return c != null && priceRangeCodes.has(c);
      });
    (hit ? excluded : kept).push(s);
  }
  return { kept, excluded };
}

export type SuspectKind = 'set-multiple' | 'unknown';

/** 比 r が整数倍・整数分の1（2以上）に ±8% で一致するか */
export function isSetMultipleRatio(r: number): boolean {
  if (!(r > 0)) return false;
  const x = r >= 1 ? r : 1 / r;
  const n = Math.round(x);
  if (n < 2) return false;
  return Math.abs(x / n - 1) <= SET_MULTIPLE_TOLERANCE;
}

/**
 * 第2段: 単発の外れ。前後3観測ずつ（近傍に3点以上）の中央値に対する比が
 * 0.6 未満または 1.6 超の観測を返す（index → 型）。
 */
export function flagSuspectObservations(obs: readonly SeriesObs[]): Map<number, SuspectKind> {
  const out = new Map<number, SuspectKind>();
  for (let i = 0; i < obs.length; i++) {
    const near = [...obs.slice(Math.max(0, i - 3), i), ...obs.slice(i + 1, i + 4)].map((o) => o.price);
    if (near.length < 3) continue;
    const r = obs[i].price / median(near);
    if (r < SUSPECT_LOW || r > SUSPECT_HIGH) {
      out.set(i, isSetMultipleRatio(r) ? 'set-multiple' : 'unknown');
    }
  }
  return out;
}

export interface LevelShiftResult {
  /** 段差と判定した観測の index */
  flagged: Set<number>;
  /** 判定した区間の数 */
  intervals: number;
  /** 戻りが観測できないまま系列が終わった（判定しない） */
  unresolvedNoReturn: number;
  /** 始点の前に3観測なく L0 を作れなかった外れ（判定しない） */
  unresolvedNoBaseline: number;
}

function inReturnBand(q: number): boolean {
  return q >= RETURN_LOW && q <= RETURN_HIGH;
}

function isExtreme(q: number): boolean {
  return q < SUSPECT_LOW || q > SUSPECT_HIGH;
}

/**
 * 第2段の段差（§3.2 N8・S4）。単発判定（singles）を受けて、系列を昇順に1回だけ走査する。
 * - L0: 区間の外では、直近の3観測（区間に入った観測・単発の外れを飛ばす）の中央値。区間中は始点の値で固定
 * - 単発の外れも始点・区間の観測になりうる（2観測だけの段差は単発にも引っかかるため）。重なった観測は段差側に数える
 * - 始点: q < 0.6 または q > 1.6
 * - 終点: q が [0.85, 1.15] に2観測連続で入った最初の観測の直前
 * - 条件: 区間 2観測以上・始点〜終点が暦日 84日以内・区間の過半数が q < 0.6 か q > 1.6
 * - 区間の後（判定の成否によらず）は、戻った観測から L0 を作り直す
 */
export function flagLevelShifts(obs: readonly SeriesObs[], singles: ReadonlySet<number>): LevelShiftResult {
  const result: LevelShiftResult = {
    flagged: new Set<number>(),
    intervals: 0,
    unresolvedNoReturn: 0,
    unresolvedNoBaseline: 0,
  };
  let base: number[] = [];
  let i = 0;
  while (i < obs.length) {
    if (base.length < 3) {
      // L0 が作れない。外れていそうなら件数だけ数える（手元の基準で見る）
      if (base.length > 0 && isExtreme(obs[i].price / median(base))) result.unresolvedNoBaseline++;
      if (!singles.has(i)) base.push(obs[i].price);
      i++;
      continue;
    }
    const L0 = median(base.slice(-3));
    const q0 = obs[i].price / L0;
    if (!isExtreme(q0)) {
      if (!singles.has(i)) base.push(obs[i].price);
      i++;
      continue;
    }
    // 区間開始。L0 は固定
    const start = i;
    let end = -1;
    let j = i + 1;
    for (; j < obs.length; j++) {
      if (inReturnBand(obs[j].price / L0)) {
        if (j + 1 < obs.length && inReturnBand(obs[j + 1].price / L0)) {
          end = j - 1;
          break;
        }
        if (j + 1 >= obs.length) break; // 2連続を確かめられないまま系列が終わる
      }
    }
    if (end < 0) {
      result.unresolvedNoReturn++;
      break;
    }
    const len = end - start + 1;
    const extremeCount = obs.slice(start, end + 1).filter((o) => isExtreme(o.price / L0)).length;
    if (
      len >= 2 &&
      daysBetween(obs[start].date, obs[end].date) <= LEVEL_SHIFT_MAX_DAYS &&
      extremeCount * 2 > len
    ) {
      for (let k = start; k <= end; k++) result.flagged.add(k);
      result.intervals++;
    }
    // 戻った観測から L0 を作り直す
    base = [];
    i = end + 1;
  }
  return result;
}

/** 第3段: 手入力の除外 */
export interface ManualExclusion {
  provider: PriceHistoryProvider;
  articleId: string;
  productKey: string;
  /** 両端を含む（YYYY-MM-DD）。省略時は系列の全期間 */
  from?: string;
  to?: string;
  reason: string;
  commit?: string;
}

export function isManuallyExcluded(series: Series, date: string, exclusions: readonly ManualExclusion[]): boolean {
  return exclusions.some(
    (e) =>
      e.provider === series.provider &&
      e.articleId === series.articleId &&
      e.productKey === series.productKey &&
      (e.from == null || date >= e.from) &&
      (e.to == null || date <= e.to),
  );
}

export interface CleaningStats {
  priceRange: { excludedSeries: number; excludedObservations: number };
  suspect: { setMultiple: number; unknown: number };
  levelShift: {
    intervals: number;
    observations: number;
    unresolvedNoReturn: number;
    unresolvedNoBaseline: number;
  };
  manual: { observations: number };
}

/**
 * 第1〜3段をまとめて適用する。除外した観測は系列から取り除く（欠測にする）。
 * 単発と段差が重なった観測は段差側に1回だけ数える。
 */
export function cleanSeries(
  series: readonly Series[],
  priceRangeCodes: ReadonlySet<string>,
  exclusions: readonly ManualExclusion[],
): { series: Series[]; stats: CleaningStats } {
  const stats: CleaningStats = {
    priceRange: { excludedSeries: 0, excludedObservations: 0 },
    suspect: { setMultiple: 0, unknown: 0 },
    levelShift: { intervals: 0, observations: 0, unresolvedNoReturn: 0, unresolvedNoBaseline: 0 },
    manual: { observations: 0 },
  };
  const { kept, excluded } = excludePriceRangeSeries(series, priceRangeCodes);
  stats.priceRange.excludedSeries = excluded.length;
  stats.priceRange.excludedObservations = excluded.reduce((n, s) => n + s.obs.length, 0);

  const out: Series[] = [];
  for (const s of kept) {
    const singles = flagSuspectObservations(s.obs);
    const shifts = flagLevelShifts(s.obs, new Set(singles.keys()));
    stats.levelShift.intervals += shifts.intervals;
    stats.levelShift.observations += shifts.flagged.size;
    stats.levelShift.unresolvedNoReturn += shifts.unresolvedNoReturn;
    stats.levelShift.unresolvedNoBaseline += shifts.unresolvedNoBaseline;
    for (const [idx, kind] of singles) {
      if (shifts.flagged.has(idx)) continue;
      if (kind === 'set-multiple') stats.suspect.setMultiple++;
      else stats.suspect.unknown++;
    }
    const obs: SeriesObs[] = [];
    s.obs.forEach((o, idx) => {
      if (singles.has(idx) || shifts.flagged.has(idx)) return;
      if (isManuallyExcluded(s, o.date, exclusions)) {
        stats.manual.observations++;
        return;
      }
      obs.push(o);
    });
    if (obs.length > 0) out.push({ ...s, obs });
  }
  return { series: out, stats };
}

/** 第2段で外した単発の観測の一覧（第3段の登録の突き合わせ用。手順4） */
export function listSuspects(series: readonly Series[], kind?: SuspectKind) {
  const rows: Array<{ key: string; date: string; price: number; kind: SuspectKind }> = [];
  for (const s of series) {
    for (const [idx, k] of flagSuspectObservations(s.obs)) {
      if (kind && k !== kind) continue;
      rows.push({ key: s.key, date: s.obs[idx].date, price: s.obs[idx].price, kind: k });
    }
  }
  return rows.sort((a, b) => cmp(a.key, b.key) || cmp(a.date, b.date));
}

// ── 月次の連鎖指数 ───────────────────────────────────────────────────────

/** 系列ごと・月ごとの中央値価格（seriesKey → month → median） */
export function monthlySeriesPrice(series: readonly Series[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const s of series) {
    const byMonth = new Map<string, number[]>();
    for (const o of s.obs) {
      if (!(o.price > 0)) continue;
      const m = monthOf(o.date);
      const list = byMonth.get(m);
      if (list) list.push(o.price);
      else byMonth.set(m, [o.price]);
    }
    if (byMonth.size === 0) continue;
    const med = new Map<string, number>();
    for (const m of [...byMonth.keys()].sort(cmp)) med.set(m, median(byMonth.get(m)!));
    out.set(s.key, med);
  }
  return out;
}

/** 月 → 取得日数（観測のある日付の数）。全系列の観測日から数える */
export function captureDaysByMonth(series: readonly Series[]): Map<string, number> {
  const dates = new Set<string>();
  for (const s of series) for (const o of s.obs) dates.add(o.date);
  const out = new Map<string, number>();
  for (const d of [...dates].sort(cmp)) out.set(monthOf(d), (out.get(monthOf(d)) ?? 0) + 1);
  return out;
}

export interface IndexPoint {
  month: string;
  index: number | null;
  pairs: number;
  captureDays: number;
}

export interface ChainedIndexResult {
  /** 基準月〜as-of の前月（本線） */
  months: IndexPoint[];
  /** as-of の月の途中経過（前月の月全体の中央値と比べる）。出せなければ index: null */
  partial: (IndexPoint & { through: string }) | null;
}

export interface ChainedIndexOptions {
  minPairs: number;
  baseMonth: string;
  asOf: string;
  captureDays: ReadonlyMap<string, number>;
}

function chainStep(
  monthly: ReadonlyMap<string, ReadonlyMap<string, number>>,
  from: string,
  to: string,
): { pairs: number; ratio: number } {
  let pairs = 0;
  let logSum = 0;
  for (const key of [...monthly.keys()].sort(cmp)) {
    const m = monthly.get(key)!;
    const a = m.get(from);
    const b = m.get(to);
    if (a == null || b == null || !(a > 0) || !(b > 0)) continue;
    pairs++;
    logSum += Math.log(b / a);
  }
  return { pairs, ratio: pairs > 0 ? Math.exp(logSum / pairs) : NaN };
}

/**
 * ジェボンズ型の連鎖指数。隣り合う2か月に両方ある系列だけで前月比を取り、幾何平均して積み上げる。
 * 基準月 = 100。pairs < minPairs・取得日数 < 3 の月は null で、**以降の月もすべて null**（再開しない。R4）。
 * as-of の月は本線に入れず、途中経過として前月（月全体）と比べた値を partial に返す。
 */
export function chainedIndex(
  monthly: ReadonlyMap<string, ReadonlyMap<string, number>>,
  opts: ChainedIndexOptions,
): ChainedIndexResult {
  const asOfMonth = monthOf(opts.asOf);
  const months: IndexPoint[] = [];
  let prev: number | null = null;
  let broken = false;
  for (let m = opts.baseMonth; m < asOfMonth; m = nextMonth(m)) {
    const captureDays = opts.captureDays.get(m) ?? 0;
    if (m === opts.baseMonth) {
      let pairs = 0;
      for (const v of monthly.values()) if (v.has(m)) pairs++;
      const ok = captureDays >= MIN_CAPTURE_DAYS && pairs >= opts.minPairs;
      prev = ok ? 100 : null;
      broken = !ok;
      months.push({ month: m, index: prev, pairs, captureDays });
      continue;
    }
    const { pairs, ratio } = chainStep(monthly, prevMonth(m), m);
    if (!broken && captureDays >= MIN_CAPTURE_DAYS && pairs >= opts.minPairs && prev != null) {
      prev = prev * ratio;
      months.push({ month: m, index: round(prev, 2), pairs, captureDays });
    } else {
      broken = true;
      prev = null;
      months.push({ month: m, index: null, pairs, captureDays });
    }
  }
  if (asOfMonth <= opts.baseMonth) return { months, partial: null };

  const captureDays = opts.captureDays.get(asOfMonth) ?? 0;
  const { pairs, ratio } = chainStep(monthly, prevMonth(asOfMonth), asOfMonth);
  const ok = !broken && prev != null && captureDays >= MIN_CAPTURE_DAYS && pairs >= opts.minPairs;
  return {
    months,
    partial: {
      month: asOfMonth,
      through: opts.asOf,
      index: ok ? round(prev! * ratio, 2) : null,
      pairs,
      captureDays,
    },
  };
}

// ── グループ別 ───────────────────────────────────────────────────────────

export interface CategoryGroup {
  id: string;
  label: string;
  /** カテゴリのファイル ID（slug） */
  categories: string[];
}

/** category → group id。どのグループにも入らないカテゴリがあれば例外（「その他」に黙って流さない） */
export function buildCategoryToGroup(
  groups: readonly CategoryGroup[],
  allCategories: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const g of groups) {
    for (const c of g.categories) {
      if (map.has(c)) throw new Error(`カテゴリ ${c} が複数のグループ（${map.get(c)} / ${g.id}）に入っています`);
      map.set(c, g.id);
    }
  }
  const missing = allCategories.filter((c) => !map.has(c)).sort(cmp);
  if (missing.length > 0) {
    throw new Error(`どのグループにも入らないカテゴリがあります: ${missing.join(', ')}`);
  }
  return map;
}

/**
 * 記事→カテゴリの対応が取れない articleId の系列を外す。外した articleId を返す。
 */
export function dropUnmappedArticles(
  series: readonly Series[],
  articleCategory: ReadonlyMap<string, string>,
): { series: Series[]; unmappedArticleIds: string[] } {
  const unmapped = new Set<string>();
  const kept: Series[] = [];
  for (const s of series) {
    if (articleCategory.has(s.articleId)) kept.push(s);
    else unmapped.add(s.articleId);
  }
  return { series: kept, unmappedArticleIds: [...unmapped].sort(cmp) };
}

export interface GroupIndex {
  id: string;
  label: string;
  series: number;
  result: ChainedIndexResult;
}

export function indexByGroup(
  monthly: ReadonlyMap<string, ReadonlyMap<string, number>>,
  articleCategory: ReadonlyMap<string, string>,
  groups: readonly CategoryGroup[],
  opts: ChainedIndexOptions,
): GroupIndex[] {
  const allCategories = [...new Set(articleCategory.values())];
  const catToGroup = buildCategoryToGroup(groups, allCategories);
  const byGroup = new Map<string, Map<string, ReadonlyMap<string, number>>>();
  for (const g of groups) byGroup.set(g.id, new Map());
  for (const key of [...monthly.keys()].sort(cmp)) {
    const { articleId } = parseSeriesKey(key);
    const cat = articleCategory.get(articleId);
    if (cat == null) continue;
    byGroup.get(catToGroup.get(cat)!)!.set(key, monthly.get(key)!);
  }
  return groups.map((g) => {
    const sub = byGroup.get(g.id)!;
    return { id: g.id, label: g.label, series: sub.size, result: chainedIndex(sub, opts) };
  });
}

// ── 容量の変化 ───────────────────────────────────────────────────────────

export interface CapacityChange {
  key: string;
  articleId: string;
  productKey: string;
  name: string;
  date: string;
  fromCapacity: string;
  toCapacity: string;
  unit: string;
  fromTotal: number;
  toTotal: number;
  priceBefore: number;
  priceAfter: number;
  direction: 'decrease' | 'increase';
}

/**
 * 同一 productKey（系列）で容量の総量が変わったケースを列挙する。
 * 容量の解析に失敗した観測（null・単位不明）は除外して件数を返す。単位が変わったものは比べない。
 */
export function unitPriceChanges(series: readonly Series[]): {
  changes: CapacityChange[];
  unparsedObservations: number;
  unitMismatches: number;
} {
  const changes: CapacityChange[] = [];
  let unparsedObservations = 0;
  let unitMismatches = 0;
  for (const s of series) {
    let last: { obs: SeriesObs; total: number; unit: string } | null = null;
    for (const o of s.obs) {
      const parsed = o.capacity ? extractCapacityTotal(o.capacity) : null;
      if (!parsed) {
        unparsedObservations++;
        continue;
      }
      if (last) {
        if (last.unit !== parsed.unit) {
          unitMismatches++;
        } else if (last.total !== parsed.total) {
          changes.push({
            key: s.key,
            articleId: s.articleId,
            productKey: s.productKey,
            name: o.name,
            date: o.date,
            fromCapacity: last.obs.capacity!,
            toCapacity: o.capacity!,
            unit: parsed.unit,
            fromTotal: last.total,
            toTotal: parsed.total,
            priceBefore: last.obs.price,
            priceAfter: o.price,
            direction: parsed.total < last.total ? 'decrease' : 'increase',
          });
        }
      }
      last = { obs: o, total: parsed.total, unit: parsed.unit };
    }
  }
  changes.sort((a, b) => cmp(a.key, b.key) || cmp(a.date, b.date));
  return { changes, unparsedObservations, unitMismatches };
}

// ── 値下がり系列の割合 ───────────────────────────────────────────────────

export interface DiscountPoint {
  date: string;
  /** 分母: その日に観測があり、直近28日（当日を含まない）に3点以上ある系列 */
  eligible: number;
  discounted: number;
  share: number | null;
}

/**
 * 観測日ごとに「直近28日（前日まで）の中央値より 10% 以上安い」系列の割合。
 * 除外済みの観測は cleanSeries で取り除かれているので、基準の中央値にも入らない。
 */
export function discountShareByDate(series: readonly Series[]): DiscountPoint[] {
  const byDate = new Map<string, { eligible: number; discounted: number }>();
  for (const s of series) {
    for (let i = 0; i < s.obs.length; i++) {
      const o = s.obs[i];
      const from = addDays(o.date, -DISCOUNT_WINDOW_DAYS);
      const hist: number[] = [];
      for (let k = i - 1; k >= 0 && s.obs[k].date >= from; k--) hist.push(s.obs[k].price);
      const cell = byDate.get(o.date) ?? { eligible: 0, discounted: 0 };
      byDate.set(o.date, cell);
      if (hist.length < DISCOUNT_MIN_HISTORY) continue;
      cell.eligible++;
      if (o.price <= median(hist) * DISCOUNT_THRESHOLD) cell.discounted++;
    }
  }
  return [...byDate.keys()].sort(cmp).map((date) => {
    const c = byDate.get(date)!;
    return { date, ...c, share: c.eligible > 0 ? round(c.discounted / c.eligible, 4) : null };
  });
}

// ── カバレッジ ───────────────────────────────────────────────────────────

export interface CoverageMonth {
  month: string;
  series: number;
  captureDays: number;
  /** 前月にもあった系列の数・割合 */
  retainedFromPrev: number;
  retentionRate: number | null;
}

export interface CoverageResult {
  firstDate: string | null;
  lastDate: string | null;
  captureDays: number;
  /** 取得日の最大間隔（日） */
  maxGapDays: number;
  /** 7日を超える間隔 */
  longGaps: Array<{ from: string; to: string; days: number }>;
  months: CoverageMonth[];
}

export function coverage(series: readonly Series[]): CoverageResult {
  const dates = [...new Set(series.flatMap((s) => s.obs.map((o) => o.date)))].sort(cmp);
  const longGaps: CoverageResult['longGaps'] = [];
  let maxGapDays = 0;
  for (let i = 1; i < dates.length; i++) {
    const d = daysBetween(dates[i - 1], dates[i]);
    maxGapDays = Math.max(maxGapDays, d);
    if (d > 7) longGaps.push({ from: dates[i - 1], to: dates[i], days: d });
  }
  const seriesByMonth = new Map<string, Set<string>>();
  for (const s of series) {
    for (const o of s.obs) {
      const m = monthOf(o.date);
      const set = seriesByMonth.get(m) ?? new Set<string>();
      set.add(s.key);
      seriesByMonth.set(m, set);
    }
  }
  const capDays = captureDaysByMonth(series);
  const months: CoverageMonth[] = [...seriesByMonth.keys()].sort(cmp).map((m) => {
    const cur = seriesByMonth.get(m)!;
    const prev = seriesByMonth.get(prevMonth(m));
    const retained = prev ? [...cur].filter((k) => prev.has(k)).length : 0;
    return {
      month: m,
      series: cur.size,
      captureDays: capDays.get(m) ?? 0,
      retainedFromPrev: retained,
      retentionRate: prev && prev.size > 0 ? round(retained / prev.size, 4) : null,
    };
  });
  return {
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    captureDays: dates.length,
    maxGapDays,
    longGaps,
    months,
  };
}

// ── 凍結リンク ───────────────────────────────────────────────────────────

/** 号のリンク先のうち、凍結中の記事を返す（R2。台帳の読み込みと日付判定はスクリプト側） */
export function findFrozenLinks(articles: readonly string[], frozenSlugs: ReadonlySet<string>): string[] {
  return articles.filter((a) => frozenSlugs.has(a));
}

// ── レポート全体 ─────────────────────────────────────────────────────────

export interface BuildPriceReportInput {
  records: readonly PriceHistoryRecord[];
  asOf: string;
  priceRangeCodes: readonly string[];
  exclusions: readonly ManualExclusion[];
  /** articleId → category（ファイル ID） */
  articleCategory: Readonly<Record<string, string>>;
  groups: readonly CategoryGroup[];
  baseMonth?: string;
  minPairs?: number;
  minGroupPairs?: number;
}

function serializeIndex(r: ChainedIndexResult) {
  return {
    months: r.months.map((p) => ({ month: p.month, index: p.index, pairs: p.pairs, captureDays: p.captureDays })),
    partial: r.partial
      ? {
          month: r.partial.month,
          through: r.partial.through,
          index: r.partial.index,
          pairs: r.partial.pairs,
          captureDays: r.partial.captureDays,
        }
      : null,
  };
}

/**
 * 集計済み JSON の中身を組み立てる。キーの順は固定・配列は sort 済み・実行時刻を入れない。
 */
export function buildPriceReport(input: BuildPriceReportInput) {
  const baseMonth = input.baseMonth ?? DEFAULT_BASE_MONTH;
  const minPairs = input.minPairs ?? DEFAULT_MIN_PAIRS;
  const minGroupPairs = input.minGroupPairs ?? DEFAULT_MIN_GROUP_PAIRS;

  // as-of で切る（as-of より後の行は読み込んだ直後に捨てる）
  const inWindow = input.records.filter((r) => r.capturedAt <= input.asOf);
  const droppedAfterAsOf = input.records.length - inWindow.length;

  const articleCategory = new Map(Object.entries(input.articleCategory).sort(([a], [b]) => cmp(a, b)));
  // グループ対応の検査はデータの有無によらず先に行う
  buildCategoryToGroup(input.groups, [...new Set(articleCategory.values())]);

  const grouped = groupSeries(inWindow);
  const { series: mapped, unmappedArticleIds } = dropUnmappedArticles(grouped, articleCategory);
  const priceRangeSet = new Set(input.priceRangeCodes.map((c) => normalizeItemCode(c)!).filter(Boolean));

  const providers = (['rakuten', 'yahoo'] as const).map((provider) => {
    const raw = mapped.filter((s) => s.provider === provider);
    const { series, stats } = cleanSeries(raw, priceRangeSet, input.exclusions);
    const monthly = monthlySeriesPrice(series);
    const captureDays = captureDaysByMonth(series);
    const index = chainedIndex(monthly, { minPairs, baseMonth, asOf: input.asOf, captureDays });
    const groups = indexByGroup(monthly, articleCategory, input.groups, {
      minPairs: minGroupPairs,
      baseMonth,
      asOf: input.asOf,
      captureDays,
    });
    const capacity = unitPriceChanges(series);
    return {
      provider,
      input: {
        series: raw.length,
        observations: raw.reduce((n, s) => n + s.obs.length, 0),
      },
      cleaning: stats,
      coverage: coverage(series),
      index: serializeIndex(index),
      groups: groups.map((g) => ({ id: g.id, label: g.label, series: g.series, ...serializeIndex(g.result) })),
      capacityChanges: {
        decreases: capacity.changes.filter((c) => c.direction === 'decrease').length,
        increases: capacity.changes.filter((c) => c.direction === 'increase').length,
        unparsedObservations: capacity.unparsedObservations,
        unitMismatches: capacity.unitMismatches,
        items: capacity.changes,
      },
      discountShare: discountShareByDate(series),
    };
  });

  return {
    asOf: input.asOf,
    baseMonth,
    params: {
      minPairs,
      minGroupPairs,
      minCaptureDays: MIN_CAPTURE_DAYS,
      suspectLow: SUSPECT_LOW,
      suspectHigh: SUSPECT_HIGH,
      setMultipleTolerance: SET_MULTIPLE_TOLERANCE,
      returnBand: [RETURN_LOW, RETURN_HIGH],
      levelShiftMaxDays: LEVEL_SHIFT_MAX_DAYS,
      discountWindowDays: DISCOUNT_WINDOW_DAYS,
      discountThreshold: DISCOUNT_THRESHOLD,
    },
    input: {
      rows: inWindow.length,
      droppedAfterAsOf,
      unmappedArticles: { count: unmappedArticleIds.length, articleIds: unmappedArticleIds },
      priceRangeItems: priceRangeSet.size,
      manualExclusions: input.exclusions.length,
    },
    groups: input.groups.map((g) => ({ id: g.id, label: g.label, categories: [...g.categories].sort(cmp) })),
    providers,
  };
}

export type PriceReport = ReturnType<typeof buildPriceReport>;
