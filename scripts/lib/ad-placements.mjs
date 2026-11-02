/**
 * インプレッション広告の掲載台帳（data/ad-placements.json）の判定を1か所にまとめる。
 * 計画書 docs/PLAN_IMPRESSION_ADS_2026-11-03_V3.md §5 #2・#3。
 *
 * ArticleLayout.astro（AdSlot.astro）と tests/ad-placements.test.ts の両方がここを使う。
 * slug は article.id と同じ形（`-comparison` 付き・サブディレクトリなら `reviews/` 接頭辞あり）。
 */
// JSON は import で読む（noindex-articles.mjs と同じ理由: fs だと Astro のバンドル後に基準パスがずれる）
import adPlacements from "../../data/ad-placements.json" with { type: "json" };

/**
 * @typedef {{
 *   slug: string, kind: string, slotId: string,
 *   start: string, end: string | null, endReason: string | null,
 *   reason: Record<string, unknown>
 * }} AdPlacement
 */

/** 外したときの理由（計画書 §5） */
export const END_REASONS = ["stop-send-rate", "stop-zero-send", "stop-cwv", "stop-search", "manual"];

/** 掲載の判定は JST の日付で行う（ビルドは GitHub Actions の UTC で走るため） */
export function todayJst() {
  return new Intl.DateTimeFormat("sv", { timeZone: "Asia/Tokyo" }).format(new Date());
}

/** @returns {AdPlacement[]} */
export function readAdPlacements(ledger = adPlacements) {
  return ledger.placements ?? [];
}

/** 掲載中 = start <= today かつ end == null */
export function isActivePlacement(placement, today = todayJst()) {
  return placement.start <= today && placement.end == null;
}

/** その記事の掲載中の行。無ければ undefined */
export function getActivePlacement(slug, today = todayJst(), placements = readAdPlacements()) {
  return placements.find((p) => p.slug === slug && isActivePlacement(p, today));
}
