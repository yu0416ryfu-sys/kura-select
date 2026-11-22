/**
 * 記事の入れ替えで外す記事の候補（M0〜M4）を当てる純関数。
 * 計画書: docs/IMPLEMENTATION_PLAN_ARTICLE_ROTATION_SKILL_2026-11-21.md §5-1
 * ルール: docs/IMPLEMENTATION_PLAN_ARTICLE_ROTATION_2026-10-13.md §2.2
 *
 * 取得できなかったデータ（null）を 0 として扱わない。null に頼る判定は hold（判定保留）にし、M4 に流さない。
 * 呼び出し元: scripts/rotation-candidates.mjs（CLI）・scripts/article-dashboard.mjs（parseImprovementLog）
 */

export const ROTATION_MIN_AGE_DAYS = 60; // 公開から60日以上
export const ROTATION_MAX_IMPRESSIONS = 10; // GSC 28日の表示が10未満
export const ROTATION_BING_ADD_THRESHOLD = 100; // M2: Bing 4週の表示 ≥ 100
export const ROTATION_RECENT_IMPROVEMENT_DAYS = 28; // M0: 加筆から28日以内
// 試験枠で2週判定が ❌（暫定でない）の記事は、公開28日から対象にする（2026-11-21 ユーザー決定・案B）
export const ROTATION_TRIAL_FAILED_MIN_AGE_DAYS = 28;
// Bing の取得が正常かどうかの目安（運用値・統計的な根拠なし。11-22 の実測: 週あたり記事 47〜55 本・表示1の行が10行）
export const ROTATION_BING_MIN_ARTICLES_PER_WEEK = 20;
export const ROTATION_BING_SMALL_ROW_MAX = 2;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' を UTC の通日に変換する（時刻を持たない日付どうしの差を出すため） */
function toDayNumber(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** 'YYYY-MM-DD' に日数を足す */
export function addDays(date, delta) {
  return new Date((toDayNumber(date) + delta) * 86400000).toISOString().slice(0, 10);
}

/** 改善ログの slug（-comparison を省いた短縮形）を記事 ID に寄せる。見つからなければ null */
export function resolveLogSlug(slug, ids) {
  for (const candidate of [slug, `${slug}-comparison`]) if (ids.has(candidate)) return candidate;
  for (const id of ids) if (id.endsWith(`/${slug}`)) return id;
  return null;
}

/**
 * docs/CONTENT_IMPROVEMENT_LOG.md の本文から実施ログの行を返す。
 * 旧 article-dashboard.mjs の loadImprovementLog と同じ挙動: 区切りで8セル以上かつ2セル目が日付の行を
 * ファイル全体から拾う（7列の §6 の行も拾う。§6 の日付はデプロイ日で、§1 の実施日と同じ）。
 * @returns {{ date: string, id: string, type: string, text: string, request: string }[]}
 */
export function parseImprovementLog(text, ids) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cells = line.split('|').map((s) => s.trim());
    // | 日付 | 記事 | 型 | 内容 | コミット | 登録リクエスト |
    if (cells.length < 8 || !DATE_RE.test(cells[1])) continue;
    const id = resolveLogSlug(cells[2], ids);
    if (!id) continue;
    rows.push({ date: cells[1], id, type: cells[3], text: cells[4], request: cells[6] });
  }
  return rows;
}

/**
 * 同じ本文の「## 6. 未登録の復帰の経過」の表から、+28日 の欄が空の記事 ID を返す。
 * 節の見出しが無ければ空の Set（節が消えたら M0 の条件が1つ減るだけで、M4 を増やす向きには働かない）。
 */
export function parseRecoverPending(text, ids) {
  const pending = new Set();
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+6\.\s/.test(line));
  if (start < 0) return pending;
  let col28 = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) break; // 次の節に入ったら終わり
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    if (col28 < 0) {
      col28 = cells.findIndex((c) => c === '+28日');
      continue;
    }
    if (!DATE_RE.test(cells[1] ?? '')) continue;
    const id = resolveLogSlug(cells[2], ids);
    if (id && (cells[col28] ?? '') === '') pending.add(id);
  }
  return pending;
}

/**
 * docs/ROTATION_LOG.md の「**新規記事**」の表から、試験枠で2週判定が ❌ かつ暫定でない記事 ID を返す。
 * 表の列: | 公開日 | 記事 | 型 | 採択時の表示・測ったクエリ | 2週後の順位帯 |
 * 暫定（コアアップデートと重なった判定）は取り直して確定するまで早く外さない。
 * 表が見つからなければ空の Set（公開60日の通常の条件に戻るだけで、早く外す向きには働かない）。
 */
export function parseTrialFailures(text) {
  const out = new Set();
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '**新規記事**');
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('**') || /^#/.test(line)) break; // 次の表・節に入ったら終わり
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    const slug = cells[2]?.match(/^`([^`]+)`$/)?.[1];
    if (!slug) continue;
    const type = cells[3] ?? '';
    const verdict = cells[5] ?? '';
    if (type.includes('試験枠') && verdict.startsWith('❌') && !verdict.includes('暫定')) out.add(slug);
  }
  return out;
}

/**
 * URL・パスを記事 ID に寄せる。記事 URL でなければ null（sumByArticleId と同じ変換）。
 * noindex-articles.mjs の articleSlugFromUrl は `#`・`?` を落とさない別の変換なので使い回さない。
 */
export function articleIdFromUrl(key) {
  const cleaned = String(key ?? '').replace(/[#?].*$/, '');
  return cleaned.match(/^(?:https?:\/\/[^/]+)?\/articles\/(.+?)\/?$/)?.[1] ?? null;
}

/**
 * GSC の page・GA4 の pagePath・Bing のページ URL を記事 ID に寄せて合計する。
 * 絶対 URL（http/https・www の有無）とパスを受け付け、`#` 以降・`?` 以降・末尾スラッシュを落とす。
 * `reviews/` 配下の ID はそのまま残す。記事 URL でない行は捨てる。
 * @param {{ key: string, value: number }[]} entries
 * @returns {Map<string, number>}
 */
export function sumByArticleId(entries) {
  const out = new Map();
  for (const { key, value } of entries ?? []) {
    const id = articleIdFromUrl(key);
    if (!id) continue;
    out.set(id, (out.get(id) ?? 0) + Number(value ?? 0));
  }
  return out;
}

/**
 * Bing の週ごとの行から、確定日以前で最新の n 週（行の date の値で数える）だけを残す。
 * @param {{ date: string, page: string, impressions: number }[]} rows
 * @returns {{ weeks: string[], rows: typeof rows, scale: number }}
 *   weeks は使った週の日付（昇順）。scale は4週あたりへの換算係数（n ÷ weeks.length。週が0なら 0）
 */
export function selectLatestBingWeeks(rows, confirmedDate, n = 4) {
  const dates = [...new Set((rows ?? []).map((r) => r.date).filter((d) => DATE_RE.test(d) && d <= confirmedDate))].sort();
  const weeks = dates.slice(-n);
  const keep = new Set(weeks);
  return {
    weeks,
    rows: (rows ?? []).filter((r) => keep.has(r.date)),
    scale: weeks.length ? n / weeks.length : 0,
  };
}

/**
 * パスに articles を含むか（大文字小文字・パーセントエンコードを問わない）。デコードできない URL も含むとみなす。
 * 記事一覧ページ（/articles/・src/pages/articles/index.astro）は記事ではないが正しい URL なので除く。
 */
function looksLikeArticleUrl(page) {
  const path = String(page ?? '').replace(/[#?].*$/, '').replace(/^https?:\/\/[^/]+/, '');
  if (/^\/articles\/?$/.test(path)) return false;
  let s = path;
  try {
    s = decodeURIComponent(s);
  } catch {
    return true; // 壊れたエンコードは照合漏れの疑いとして数える
  }
  return /articles/i.test(s);
}

/**
 * 選んだ Bing の行から、その回の取得が正常かどうかを判定する。
 * 正常なら、行の無い記事は「表示0」とみなしてよい。
 * 計画書: docs/IMPLEMENTATION_PLAN_ROTATION_BING_NO_ROW_2026-11-22.md §4-1
 * @param {{ rows: {date:string, page:string, impressions:number}[], weeks: string[] }} picked  selectLatestBingWeeks の戻り値
 * @param {Set<string>} articleIds  実在する記事 ID（draft を除いた全記事と noindex 済みの記事）
 * @param {number} [n=4]  必要な週数
 * @returns {{ healthy: boolean, reasons: string[] }}  reasons は異常の理由（正常なら空）
 */
export function assessBingFetchHealth(picked, articleIds, n = 4) {
  const reasons = [];
  const weeks = picked?.weeks ?? [];
  const rows = picked?.rows ?? [];
  const known = articleIds ?? new Set();
  if (weeks.length !== n) reasons.push(`週が ${weeks.length} 週（${n} 週必要）`);
  const articleRows = rows.map((r) => ({ ...r, id: articleIdFromUrl(r.page) })).filter((r) => r.id);
  for (const week of weeks) {
    // 記事 URL だけを数える（トップ・カテゴリは除く）。同じ週の同じ記事は1本と数える
    const ids = new Set(articleRows.filter((r) => r.date === week).map((r) => r.id));
    if (ids.size < ROTATION_BING_MIN_ARTICLES_PER_WEEK) {
      reasons.push(`${week} の週の記事が ${ids.size} 本（${ROTATION_BING_MIN_ARTICLES_PER_WEEK} 本未満）`);
    }
  }
  if (!articleRows.some((r) => Number.isFinite(r.impressions) && r.impressions <= ROTATION_BING_SMALL_ROW_MAX)) {
    reasons.push(`表示 ${ROTATION_BING_SMALL_ROW_MAX} 以下の記事の行が無い（少ない行が落ちている疑い）`);
  }
  // URL の表記ゆれによる照合漏れの疑い（10-11 の型）
  const unmapped = rows.filter((r) => !articleIdFromUrl(r.page) && looksLikeArticleUrl(r.page));
  if (unmapped.length) reasons.push(`記事に寄せられない記事らしい URL が ${unmapped.length} 行（例: ${unmapped[0].page}）`);
  const unknown = articleRows.filter((r) => !known.has(r.id));
  if (unknown.length) reasons.push(`実在しない記事 ID の行が ${unknown.length} 行（例: ${unknown[0].id}）`);
  return { healthy: reasons.length === 0, reasons };
}

/**
 * M0〜M4 を当てる。入力のどれかが null（取得失敗）なら、その条件に頼る判定を保留にする。
 * @param {object} input
 * @param {string} input.today                         'YYYY-MM-DD'（JST）
 * @param {{ id: string, publishedAt: string }[]} input.articles   draft を除いた全記事
 * @param {Map<string, number>} input.gscImpressions   確定日までの28日・見出しアンカー行を除く。キーなし＝0
 * @param {Map<string, number> | null} input.outbound  GA4 送客イベントの合計（28日）。null＝取得失敗
 * @param {Map<string, number> | null} input.bingImpressions  Bing 4週の表示。null＝取得失敗。キーなし＝行なし
 * @param {boolean} [input.bingHealthy]                assessBingFetchHealth(...).healthy。true のときだけ行なしを表示0とみなす
 * @param {Set<string> | null} input.frozen            凍結中。null＝凍結台帳を読めない
 * @param {Set<string>} input.noindexed                data/noindex-articles.json
 * @param {Set<string>} input.seasonal                 data/rotation-seasonal.json
 * @param {{ id: string, date: string }[] | null} input.improvements  null＝改善ログなし
 * @param {Set<string> | null} input.recoverPending    null＝改善ログなし
 * @param {Set<string>} [input.trialFailed]            試験枠で2週判定が ❌（暫定でない）。公開28日から対象にする
 * @returns {object[]} 対象の行だけ。GSC の表示の少ない順
 */
export function classifyRotationCandidates(input) {
  const {
    today,
    articles,
    gscImpressions,
    outbound,
    bingImpressions,
    bingHealthy = false, // true のときだけ、行なしを表示0とみなす（未指定は安全側の保留）
    frozen,
    noindexed,
    seasonal,
    improvements,
    recoverPending,
    trialFailed = new Set(),
  } = input;
  const recentFrom = addDays(today, -ROTATION_RECENT_IMPROVEMENT_DAYS);
  const lastImprovement = new Map();
  for (const row of improvements ?? []) {
    if (!lastImprovement.has(row.id) || row.date > lastImprovement.get(row.id)) lastImprovement.set(row.id, row.date);
  }

  const out = [];
  for (const article of articles) {
    const { id } = article;
    const publishedAt = typeof article.publishedAt === 'string' && DATE_RE.test(article.publishedAt) ? article.publishedAt : null;
    const ageDays = publishedAt ? toDayNumber(today) - toDayNumber(publishedAt) : null;
    const gsc = gscImpressions.get(id) ?? 0;
    if (gsc >= ROTATION_MAX_IMPRESSIONS) continue;
    if (noindexed.has(id)) continue;
    // 公開日なしは年齢の条件を飛ばして対象に入れ、下で hold にする
    const minAge = trialFailed.has(id) ? ROTATION_TRIAL_FAILED_MIN_AGE_DAYS : ROTATION_MIN_AGE_DAYS;
    if (ageDays !== null && ageDays < minAge) continue;

    const bing = bingImpressions === null ? null : bingImpressions.has(id) ? bingImpressions.get(id) : '行なし';
    const row = {
      id,
      publishedAt,
      ageDays,
      gsc,
      outbound: outbound === null ? null : outbound.get(id) ?? 0,
      bing,
      verdict: '',
      reason: '',
      verdictIfBingZero: null,
      trialFailed: trialFailed.has(id),
    };
    const set = (verdict, reason) => {
      row.verdict = verdict;
      row.reason = reason;
    };
    // M3・M4 の当てはめ（M2-hold の「表示0とみなした場合」でも使う）
    const afterM2 = () => (seasonal.has(id) ? 'M3' : 'M4');

    const recent = lastImprovement.get(id);
    if (!publishedAt) set('hold', '公開日なし');
    else if (frozen === null) set('hold', '凍結台帳を読めない');
    else if (frozen.has(id)) set('M0', '凍結中');
    else if (improvements === null || recoverPending === null) set('hold', '改善ログなし');
    else if (recent && recent >= recentFrom) set('M0', `加筆 ${recent} から28日以内`);
    else if (recoverPending.has(id)) set('M0', '未登録の復帰の +28日 が未記入');
    else if (outbound === null) set('hold', 'GA4 取得失敗');
    else if (row.outbound >= 1) set('M1', `送客 ${row.outbound} 件`);
    else if (bing === null) set('hold', 'Bing 取得失敗');
    else if (bing === '行なし' && bingHealthy === true) {
      const v = afterM2();
      set(
        v,
        v === 'M3'
          ? 'Bing 行なし（取得は正常・表示0とみなす）・季節品（季節品の手順で判断）'
          : 'Bing 行なし（取得は正常・表示0とみなす）・noindex 候補',
      );
    } else if (bing === '行なし') {
      set('M2-hold', 'Bing 行なし（取得の健全性が未確認か異常）');
      row.verdictIfBingZero = afterM2();
    } else if (bing >= ROTATION_BING_ADD_THRESHOLD) set('M2', `加筆候補（Bing ${bing}）`);
    else if (afterM2() === 'M3') set('M3', '季節品（季節品の手順で判断）');
    else set('M4', 'noindex 候補');
    out.push(row);
  }
  return out.sort((a, b) => a.gsc - b.gsc || a.id.localeCompare(b.id));
}
