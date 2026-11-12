// Google 検索ステータス ダッシュボード（https://status.search.google.com/）の取り込み
//
// 目的: コアアップデート・スパムアップデート・クロール/インデックス/配信の障害は、
// サイトの施策と関係なく表示・クリック・順位を動かす。測定窓にこれらが重なったかを
// 機械的に判定し、週次スナップショット・ベースライン・施策判定に注記する。
//
// データ源は公式の JSON（incidents.json）。ダッシュボードは直近約1年分しか返さないので、
// 取得した分を data/google-search-status.json に追記して履歴を残す（過去の判定の見直し用）。

export const STATUS_DASHBOARD_URL = "https://status.search.google.com/";
export const STATUS_INCIDENTS_URL = "https://status.search.google.com/incidents.json";

/** コアアップデートの完了後も順位が揺れ戻す期間（日）。2026-06 の May core 後の揺れ戻しの実績から */
export const CORE_UPDATE_AFTERMATH_DAYS = 14;

/**
 * 種別
 * - core-update: コアアップデート。窓に重なったら検索指標の判定は「暫定」
 * - spam-update: スパムアップデート。注記（サイト全体の正規化で吸収できる前提）
 * - disruption: クロール/インデックス/配信の障害。注記し、該当日を除いた日次換算も見る
 * - limited: 対象が日本語の検索に及ばない更新（例: 米国英語限定の Discover 更新）。参考のみ
 * - other: 上のどれにも当たらない告知。注記
 */
export type IncidentKind = "core-update" | "spam-update" | "disruption" | "limited" | "other";

/** 窓に重なったときの扱い */
export type OverlapLevel = "provisional" | "note" | "info";

export interface RawIncidentUpdate {
  when?: string;
  text?: string;
  status?: string;
}

export interface RawIncident {
  id: string;
  begin: string;
  end?: string;
  external_desc?: string;
  service_name?: string;
  status_impact?: string;
  severity?: string;
  uri?: string;
  updates?: RawIncidentUpdate[];
}

export interface SearchStatusIncident {
  id: string;
  title: string;
  service: string;
  kind: IncidentKind;
  statusImpact: string;
  severity: string;
  /** UTC の ISO 文字列（原文のまま） */
  beginUtc: string;
  endUtc: string | null;
  /**
   * 窓と突き合わせる日付（YYYY-MM-DD）。保守側に広げる: 開始は太平洋時間（GSC の日付の基準・JST より早い）、
   * 終了は JST（施策の起点日の基準・太平洋時間より遅い）。
   */
  beginDate: string;
  endDate: string | null;
  /** 最初の告知文（対象範囲の判定根拠） */
  firstText: string;
  url: string;
}

export interface SearchStatusLog {
  updatedAt: string;
  source: string;
  readme: string;
  incidents: SearchStatusIncident[];
}

export interface DateWindow {
  start: string;
  end: string;
}

export interface IncidentOverlap {
  id: string;
  title: string;
  kind: IncidentKind;
  level: OverlapLevel;
  /** 影響期間（core は完了後の揺れ戻し期間を含む）。継続中なら end は asOf */
  impactStart: string;
  impactEnd: string;
  ongoing: boolean;
  /** 窓の中で影響期間と重なった日数 */
  overlapDays: number;
  overlapStart: string;
  overlapEnd: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, label: string): void {
  if (!DATE_RE.test(value)) throw new Error(`${label} は YYYY-MM-DD で指定してください: ${value}`);
}

function shiftedDate(iso: string, offsetHours: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`日時を解釈できません: ${iso}`);
  return new Date(ms + offsetHours * 3600 * 1000).toISOString().slice(0, 10);
}

/** UTC の ISO 文字列 → JST の日付 */
export function toJstDate(iso: string): string {
  return shiftedDate(iso, 9);
}

/** UTC の ISO 文字列 → 太平洋時間の日付（GSC の日付の基準。夏時間を無視して -8 時間で早めに倒す） */
export function toPacificDate(iso: string): string {
  return shiftedDate(iso, -8);
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

/** 告知の最初の文（いちばん古い update）。対象範囲（言語・国）の判定に使う */
function firstUpdateText(raw: RawIncident): string {
  const updates = [...(raw.updates ?? [])].sort((a, b) =>
    String(a.when ?? "").localeCompare(String(b.when ?? "")),
  );
  return (updates[0]?.text ?? "").trim();
}

export function classifyIncident(raw: RawIncident): IncidentKind {
  const title = raw.external_desc ?? "";
  const text = firstUpdateText(raw);
  const impact = raw.status_impact ?? "";
  if (impact === "SERVICE_DISRUPTION" || impact === "SERVICE_OUTAGE") return "disruption";
  // 「English language users in the US」のように対象が限られ、全言語と書かれていない更新
  const limitedScope =
    /english[- ]language users|users in the us\b|english only/i.test(text) &&
    !/all languages/i.test(text);
  if (limitedScope) return "limited";
  // Discover の更新は検索結果の順位ではないので core 扱いにしない（全言語なら注記）
  if (/core update/i.test(title) && !/discover/i.test(title)) return "core-update";
  if (/spam update/i.test(title)) return "spam-update";
  return "other";
}

export function normalizeIncident(raw: RawIncident): SearchStatusIncident {
  if (!raw?.id || !raw.begin) throw new Error("incident に id / begin がありません");
  return {
    id: raw.id,
    title: raw.external_desc ?? "(無題)",
    service: raw.service_name ?? "",
    kind: classifyIncident(raw),
    statusImpact: raw.status_impact ?? "",
    severity: raw.severity ?? "",
    beginUtc: raw.begin,
    endUtc: raw.end ?? null,
    beginDate: toPacificDate(raw.begin),
    endDate: raw.end ? toJstDate(raw.end) : null,
    firstText: firstUpdateText(raw),
    url: raw.uri ? new URL(raw.uri, STATUS_DASHBOARD_URL).toString() : STATUS_DASHBOARD_URL,
  };
}

export function normalizeIncidents(raw: unknown): SearchStatusIncident[] {
  if (!Array.isArray(raw)) throw new Error("incidents.json が配列ではありません");
  return raw.map((item) => normalizeIncident(item as RawIncident));
}

/**
 * 保存済みの履歴に取得分をマージする。id が同じものは取得分で上書き（完了日の追記など）。
 * ダッシュボードから消えた古い incident は履歴に残す。並びは開始日の新しい順。
 */
export function mergeIncidents(
  existing: SearchStatusIncident[],
  fetched: SearchStatusIncident[],
): SearchStatusIncident[] {
  const byId = new Map<string, SearchStatusIncident>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of fetched) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.beginUtc.localeCompare(a.beginUtc));
}

export function overlapLevel(kind: IncidentKind): OverlapLevel {
  if (kind === "core-update") return "provisional";
  if (kind === "limited") return "info";
  return "note";
}

/**
 * 影響期間。core は完了後の揺れ戻し期間を足す。
 * 継続中は「asOf まで」とし、core は Google が告知する最長ロールアウト（2週）より早くは終わらないとみなす。
 */
export function impactPeriod(
  incident: SearchStatusIncident,
  asOf: string,
): { start: string; end: string; ongoing: boolean } {
  assertDate(asOf, "asOf");
  const ongoing = incident.endDate === null;
  let baseEnd = incident.endDate ?? asOf;
  if (ongoing && incident.kind === "core-update") {
    const minRollout = addDays(incident.beginDate, CORE_UPDATE_AFTERMATH_DAYS);
    if (minRollout > baseEnd) baseEnd = minRollout;
  }
  const end =
    incident.kind === "core-update" ? addDays(baseEnd, CORE_UPDATE_AFTERMATH_DAYS) : baseEnd;
  return { start: incident.beginDate, end, ongoing };
}

/**
 * 窓（両端含む）に影響期間が重なる incident を返す。
 * 継続中の incident は「今日（asOf）まで続いている」とみなす。
 */
export function findOverlaps(
  incidents: SearchStatusIncident[],
  window: DateWindow,
  asOf: string,
): IncidentOverlap[] {
  assertDate(window.start, "window.start");
  assertDate(window.end, "window.end");
  const result: IncidentOverlap[] = [];
  for (const incident of incidents) {
    const period = impactPeriod(incident, asOf);
    const overlapStart = period.start > window.start ? period.start : window.start;
    const overlapEnd = period.end < window.end ? period.end : window.end;
    if (overlapStart > overlapEnd) continue;
    result.push({
      id: incident.id,
      title: incident.title,
      kind: incident.kind,
      level: overlapLevel(incident.kind),
      impactStart: period.start,
      impactEnd: period.end,
      ongoing: period.ongoing,
      overlapDays: daysBetweenInclusive(overlapStart, overlapEnd),
      overlapStart,
      overlapEnd,
    });
  }
  return result.sort((a, b) => a.impactStart.localeCompare(b.impactStart));
}

/** 窓の重なりから、その窓での判定の扱いを1語で返す */
export function windowVerdict(overlaps: IncidentOverlap[]): "暫定" | "注記" | "影響なし" {
  if (overlaps.some((o) => o.level === "provisional")) return "暫定";
  if (overlaps.some((o) => o.level === "note")) return "注記";
  return "影響なし";
}

const KIND_LABEL: Record<IncidentKind, string> = {
  "core-update": "コアアップデート",
  "spam-update": "スパムアップデート",
  disruption: "障害",
  limited: "対象外の地域・言語",
  other: "その他の告知",
};

export function kindLabel(kind: IncidentKind): string {
  return KIND_LABEL[kind];
}

export function formatOverlap(o: IncidentOverlap): string {
  const period = o.ongoing ? `${o.impactStart}〜（継続中）` : `${o.impactStart}〜${o.impactEnd}`;
  const aftermath = o.kind === "core-update" ? `・完了後${CORE_UPDATE_AFTERMATH_DAYS}日を含む` : "";
  return `${o.title}（${kindLabel(o.kind)}・影響期間 ${period}${aftermath}）が ${o.overlapStart}〜${o.overlapEnd} の ${o.overlapDays} 日重なる`;
}

export interface HoldLike {
  slug?: string;
  startedAt?: string;
  releaseDate?: string;
  targetType?: string;
}

/**
 * 凍結台帳の行から窓を作る。後窓＝起点日〜解除日（releaseDate は解除日の翌日なので -1）、
 * 前窓＝起点前28日（新規記事は前窓なし）。台帳に正確な窓が注記されていればそちらが正で、これは目安。
 */
export function holdWindows(
  holds: HoldLike[],
): Array<{ slug: string; label: string; window: DateWindow }> {
  const result: Array<{ slug: string; label: string; window: DateWindow }> = [];
  for (const h of holds) {
    if (!h.slug || !h.startedAt || !h.releaseDate) continue;
    if (!DATE_RE.test(h.startedAt) || !DATE_RE.test(h.releaseDate)) continue;
    if (h.targetType !== "new-article") {
      result.push({
        slug: h.slug,
        label: "前窓",
        window: { start: addDays(h.startedAt, -28), end: addDays(h.startedAt, -1) },
      });
    }
    result.push({
      slug: h.slug,
      label: "後窓",
      window: { start: h.startedAt, end: addDays(h.releaseDate, -1) },
    });
  }
  return result;
}

export interface NamedWindow extends DateWindow {
  label: string;
}

/**
 * スナップショット用の Markdown 節。窓ごとに重なりを並べ、判定の扱いを書く。
 */
export function formatSearchStatusSection(input: {
  available: boolean;
  error?: string;
  source?: "live" | "cache";
  asOf: string;
  windows: NamedWindow[];
  incidents: SearchStatusIncident[];
  holds?: Array<{ slug: string; label: string; window: DateWindow }>;
}): string[] {
  const lines: string[] = [];
  lines.push(`## 0-1. Google 検索の公式ステータス（${STATUS_DASHBOARD_URL}）`);
  lines.push("");
  if (!input.available) {
    lines.push(`⚠️ 取得できなかった: ${input.error ?? "不明"}。判定の前にダッシュボードを目で確認すること。`);
    lines.push("");
    return lines;
  }
  if (input.source === "cache") {
    lines.push("⚠️ ダッシュボードを取得できず、`data/google-search-status.json` の保存分で判定した（新しい告知を見落としている可能性あり）。");
    lines.push("");
  }
  const ongoing = input.incidents.filter((i) => i.endDate === null);
  lines.push(
    `- 継続中: ${
      ongoing.length === 0
        ? "なし"
        : ongoing.map((i) => `${i.title}（${kindLabel(i.kind)}・${i.beginDate}〜）`).join(" / ")
    }`,
  );
  lines.push("");
  lines.push("| 窓 | 期間 | 扱い | 重なった告知 |");
  lines.push("|---|---|---|---|");
  for (const w of input.windows) {
    const overlaps = findOverlaps(input.incidents, w, input.asOf);
    lines.push(
      `| ${w.label} | ${w.start}〜${w.end} | ${windowVerdict(overlaps)} | ${
        overlaps.length === 0 ? "なし" : overlaps.map(formatOverlap).join("<br>")
      } |`,
    );
  }
  lines.push("");
  if (input.holds && input.holds.length > 0) {
    lines.push("**凍結台帳にある施策の窓（解除済みで台帳に残る行を含む。後窓＝起点日〜解除日・前窓＝起点前28日の目安。正確な窓は台帳の注記が正）**");
    lines.push("");
    lines.push("| 記事 | 窓 | 期間 | 扱い | 重なった告知 |");
    lines.push("|---|---|---|---|---|");
    for (const h of input.holds) {
      const overlaps = findOverlaps(input.incidents, h.window, input.asOf);
      lines.push(
        `| ${h.slug} | ${h.label} | ${h.window.start}〜${h.window.end} | ${windowVerdict(overlaps)} | ${
          overlaps.length === 0 ? "なし" : overlaps.map(formatOverlap).join("<br>")
        } |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "> 扱い: **暫定**＝コアアップデート（完了後" +
      CORE_UPDATE_AFTERMATH_DAYS +
      "日の揺れ戻しを含む）が重なる。検索指標（表示・クリック・CTR・順位）の判定は暫定とし、影響期間の外の窓で取り直してから確定する。" +
      "**注記**＝スパムアップデート・障害が重なる。判定はしてよいが理由に書く（障害日は除いた日次換算も併記）。" +
      "**影響なし**＝重なりなし。GA4 の率（送客率・エンゲージ率）は検索順位の変動を直接受けないので、扱いは注記にとどめる（CLAUDE.md §5.0.2 ルール6）。",
  );
  lines.push("");
  return lines;
}
