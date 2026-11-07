// 送客の弱い高流入記事の2群（広告群・改善群）の進み具合を集計する（計画書 docs/PLAN_IMPRESSION_ADS_2026-11-03_V3.md）。
// pnpm article-dashboard の「収益化施策」欄が使う。閲覧用の途中経過で、停止・判定はここでは行わない。
// GA4 の値は T-1 を含む窓（PV・送客＝イベント数だけ使う。CLAUDE.md §5.0.2 ルール2）。

export const GROUPS = ['ad', 'improve'];
export const PRE_DAYS = 28; // 掲載前・施策前の期間の最短日数（§4-3・§3）
export const IMPROVE_DAYS = 28; // 改善群の判定窓（§3）
export const SAFETY_BLOCK_DAYS = 28; // 安全装置の固定ブロック（§4-4）
export const AD_JUDGE_SENDS = 20; // 合算判定に必要な掲載後の送客（§4-4）
export const AD_JUDGE_DAYS = 56; // 最初の掲載から +8週（§4-4）
export const AD_REVIEW_DAYS = 84; // 続けるかの判断 +12週（§4-4）
export const AD_RPM_DAYS = 28; // 実測 RPM で閾値を見直す +4週（§4-2）
export const AD_STOP_RATIO = 0.7; // 合算の停止線（§4-4）

export function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** from〜to（両端含む）の日付から除外日を除いた配列 */
export function datesBetween(from, to, excluded = []) {
  const skip = new Set(excluded);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!skip.has(d)) out.push(d);
  return out;
}

/** start の前日から遡って、除外日を除いた n 日を集める（§4-3: 足りない分は前に遡って補う） */
export function preWindow(start, excluded = [], n = PRE_DAYS) {
  const skip = new Set(excluded);
  const dates = [];
  for (let d = addDays(start, -1); dates.length < n; d = addDays(d, -1)) if (!skip.has(d)) dates.unshift(d);
  return { from: dates[0], to: dates[dates.length - 1], dates };
}

/** ga4Map（date -> {pv, outbound}）を指定日の集合で合計する */
export function sumDates(ga4Map, dates) {
  let pv = 0;
  let outbound = 0;
  for (const d of dates) {
    const c = ga4Map?.get(d);
    if (!c) continue;
    pv += c.pv ?? 0;
    outbound += c.outbound ?? 0;
  }
  return { pv, outbound, days: dates.length, rate: pv > 0 ? outbound / pv : null };
}

/** 複数ページの合計（サイト送客率＝群を除いた記事の 送客 ÷ PV） */
function sumPaths(ga4, paths, dates) {
  let pv = 0;
  let outbound = 0;
  for (const p of paths) {
    const s = sumDates(ga4.get(p), dates);
    pv += s.pv;
    outbound += s.outbound;
  }
  return { pv, outbound, rate: pv > 0 ? outbound / pv : null };
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * @param {object} input
 * @param {object} input.groups      data/revenue-groups.json
 * @param {object[]} input.placements data/ad-placements.json の placements
 * @param {object[]} input.revenueRows data/ad-revenue.json の rows
 * @param {{date:string,id:string,type:string}[]} input.improveLog CONTENT_IMPROVEMENT_LOG.md の行（記事 ID 解決済み）
 * @param {Map<string, Map<string, {pv:number,outbound:number}>>|null} input.ga4 path -> date -> 値
 * @param {Map<string, string>} input.paths 記事 ID -> GA4 の pagePath
 * @param {string|null} input.ga4End GA4 の最終日（T-1）
 * @param {string} input.today
 * @param {Map<string, string>} [input.activeHold] 記事 ID -> 凍結解除日
 */
export function buildRevenueGroupStatus(input) {
  const { groups, placements = [], revenueRows = [], improveLog = [], ga4, paths, ga4End, today } = input;
  const activeHold = input.activeHold ?? new Map();
  const excluded = groups?.excludedDates ?? [];
  const members = groups?.members ?? [];
  const memberIds = new Set(members.map((m) => m.slug));
  const controlPaths = [...paths].filter(([id]) => !memberIds.has(id)).map(([, p]) => p);
  const hasGa4 = Boolean(ga4 && ga4End);
  const eps = typeof groups?.eps === 'number' ? groups.eps : null;

  const site = (dates) => (hasGa4 && dates.length ? sumPaths(ga4, controlPaths, dates) : null);
  const article = (id, dates) => (hasGa4 ? sumDates(ga4.get(paths.get(id)), dates) : null);
  /** (記事の後/前 の送客率) ÷ (サイトの後/前 の送客率)。参考値 */
  const normRatio = (pre, post, sPre, sPost) =>
    pre?.rate && post?.rate != null && sPre?.rate && sPost?.rate ? (post.rate / pre.rate) / (sPost.rate / sPre.rate) : null;

  // ---- 広告群
  const ad = members
    .filter((m) => m.group === 'ad')
    .map((m) => {
      const rows = placements.filter((p) => p.slug === m.slug).sort((a, b) => (a.start < b.start ? 1 : -1));
      const pl = rows[0] ?? null;
      const base = {
        slug: m.slug,
        assignedAt: m.assignedAt,
        note: m.note ?? null,
        hold: activeHold.get(m.slug) ?? null,
        selection: m.selection ?? null,
      };
      if (!pl) return { ...base, state: 'not-started' };

      const state = pl.end ? 'stopped' : pl.start <= today ? 'live' : 'scheduled';
      const postEnd = hasGa4 ? (pl.end && pl.end < ga4End ? pl.end : ga4End) : null;
      const pre = preWindow(pl.start, excluded);
      const postDates = postEnd && postEnd >= pl.start ? datesBetween(pl.start, postEnd, excluded) : [];
      const preStat = article(m.slug, pre.dates);
      const postStat = postDates.length ? article(m.slug, postDates) : null;
      const sitePre = site(pre.dates);
      const sitePost = site(postDates);

      // 広告の実績（ad-revenue.json・枠ごと日別）
      const spotIds = new Set((pl.slots ?? []).map((s) => String(s.spotId)));
      const rev = revenueRows.filter((r) => spotIds.has(String(r.spotId)) && r.date >= pl.start && (!pl.end || r.date <= pl.end));
      const revDates = [...new Set(rev.map((r) => r.date))].sort();
      const lastRevenueDate = revDates[revDates.length - 1] ?? null;
      const impressions = rev.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
      const revenue = rev.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
      // 収益/1,000PV は広告の記入がある日だけで割る
      const pvOnRevDates = hasGa4 && revDates.length ? article(m.slug, revDates.filter((d) => !excluded.includes(d))).pv : null;

      // 安全装置: 掲載開始日から区切った固定の4週ごとの送客
      const blocks = [];
      if (hasGa4) {
        for (let s = pl.start, k = 1; s <= postEnd; s = addDays(s, SAFETY_BLOCK_DAYS), k++) {
          const e = addDays(s, SAFETY_BLOCK_DAYS - 1);
          const to = e < postEnd ? e : postEnd;
          const st = sumDates(ga4.get(paths.get(m.slug)), datesBetween(s, to));
          blocks.push({ n: k, from: s, to: e, complete: e <= postEnd, sends: st.outbound, pv: st.pv });
        }
      }

      return {
        ...base,
        state,
        start: pl.start,
        end: pl.end ?? null,
        endReason: pl.endReason ?? null,
        slots: (pl.slots ?? []).map((s) => ({ platform: s.platform, spotId: String(s.spotId), size: s.size ?? null })),
        daysLive: postDates.length,
        pre: { from: pre.from, to: pre.to, ...preStat },
        post: postStat ? { from: pl.start, to: postEnd, ...postStat } : null,
        sitePre,
        sitePost,
        normRatio: normRatio(preStat, postStat, sitePre, sitePost),
        ads: { impressions, revenue, lastRevenueDate, pv: pvOnRevDates, rpm: pvOnRevDates ? (revenue / pvOnRevDates) * 1000 : null },
        blocks,
        zeroSendBlock: blocks.find((b) => b.complete && b.sends === 0)?.n ?? null,
        psi: pl.reason?.psiMobile ?? null,
        approvedBy: pl.reason?.approvedBy ?? null,
      };
    });

  // ---- 広告群の合算（§4-4）
  const started = ad.filter((a) => a.start && a.start <= today);
  const firstStart = started.map((a) => a.start).sort()[0] ?? null;
  let combined = null;
  if (firstStart) {
    const postSends = started.reduce((s, a) => s + (a.post?.outbound ?? 0), 0);
    // 送客 20 に達した日（GA4 の日次で累積）
    let reachedAt = null;
    if (hasGa4) {
      const days = datesBetween(firstStart, ga4End, excluded);
      let cum = 0;
      for (const d of days) {
        for (const a of started) {
          if (d < a.start || (a.end && d > a.end)) continue;
          cum += ga4.get(paths.get(a.slug))?.get(d)?.outbound ?? 0;
        }
        if (cum >= AD_JUDGE_SENDS) {
          reachedAt = d;
          break;
        }
      }
    }
    const judgeByDate = addDays(firstStart, AD_JUDGE_DAYS);
    // 総収益/PV の比（掲載前 PV で重みづけ）。掲載前の送客 0 の記事は外す（§4-4）
    const usable = started.filter((a) => a.pre?.outbound > 0 && a.post?.pv > 0 && a.sitePre?.rate && a.sitePost?.rate);
    let ratio = null;
    if (usable.length) {
      let wsum = 0;
      let acc = 0;
      for (const a of usable) {
        const norm = a.sitePre.rate / a.sitePost.rate;
        const e = eps ?? 1;
        const preVal = (a.pre.outbound * e) / a.pre.pv;
        // 広告収益は EPS が決まっているときだけ足す（記入のある日の分だけ）
        const postVal = (a.post.outbound * e * norm + (eps != null ? a.ads.revenue : 0)) / a.post.pv;
        acc += (postVal / preVal) * a.pre.pv;
        wsum += a.pre.pv;
      }
      ratio = acc / wsum;
    }
    combined = {
      firstStart,
      postSends,
      targetSends: AD_JUDGE_SENDS,
      reachedAt,
      judgeByDate,
      judgeDate: reachedAt && reachedAt < judgeByDate ? reachedAt : judgeByDate,
      rpmReviewDate: addDays(firstStart, AD_RPM_DAYS),
      reviewDate: addDays(firstStart, AD_REVIEW_DAYS),
      ratio,
      ratioBasis: eps != null ? 'revenue' : 'send-rate',
      ratioArticles: usable.length,
      stopRatio: AD_STOP_RATIO,
      eps,
    };
  }

  // ---- 改善群
  const improve = members
    .filter((m) => m.group === 'improve')
    .map((m) => {
      const action = improveLog
        .filter((r) => r.id === m.slug && r.date >= m.assignedAt)
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0] ?? null;
      const base = {
        slug: m.slug,
        assignedAt: m.assignedAt,
        notBefore: m.notBefore ?? null,
        returnedAt: m.returnedAt ?? null,
        note: m.note ?? null,
        hold: activeHold.get(m.slug) ?? null,
        selection: m.selection ?? null,
      };
      if (m.returnedAt) return { ...base, state: 'returned', startedAt: action?.date ?? null, actionType: action?.type ?? null };
      if (!action) return { ...base, state: 'not-started' };

      const start = action.date;
      const judgeDate = addDays(start, IMPROVE_DAYS); // 4週の窓が閉じた翌日
      const extendDate = addDays(start, IMPROVE_DAYS * 2);
      const pre = preWindow(start, excluded);
      const postEnd = hasGa4 ? (ga4End < addDays(judgeDate, -1) ? ga4End : addDays(judgeDate, -1)) : null;
      const postDates = postEnd && postEnd >= start ? datesBetween(start, postEnd, excluded) : [];
      const preStat = article(m.slug, pre.dates);
      const postStat = postDates.length ? article(m.slug, postDates) : null;
      const sitePre = site(pre.dates);
      const sitePost = site(postDates);
      return {
        ...base,
        state: today >= judgeDate ? 'due' : 'measuring',
        startedAt: start,
        actionType: action.type,
        elapsedDays: Math.min(daysBetween(start, today), IMPROVE_DAYS),
        judgeDate,
        extendDate,
        pre: { from: pre.from, to: pre.to, ...preStat },
        post: postStat ? { from: start, to: postEnd, ...postStat } : null,
        sitePre,
        sitePost,
        normRatio: normRatio(preStat, postStat, sitePre, sitePost),
      };
    });

  return { plan: groups?.plan ?? null, selection: groups?.selection ?? null, excludedDates: excluded, ad, combined, improve };
}

/** GA4 をどこから取れば群の掲載前・施策前の期間を覆えるか（日付が無ければ null） */
export function earliestNeededDate(groups, placements = [], improveLog = []) {
  const excluded = groups?.excludedDates ?? [];
  const starts = [];
  for (const m of groups?.members ?? []) {
    if (m.group === 'ad') for (const p of placements) if (p.slug === m.slug && p.start) starts.push(p.start);
    if (m.group === 'improve') {
      const r = improveLog.filter((x) => x.id === m.slug && x.date >= m.assignedAt).map((x) => x.date).sort()[0];
      if (r) starts.push(r);
    }
  }
  if (!starts.length) return null;
  return preWindow(starts.sort()[0], excluded).from;
}
