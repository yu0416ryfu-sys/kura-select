import { describe, it, expect } from "vitest";
import {
  groupSeries,
  monthlySeriesPrice,
  captureDaysByMonth,
  chainedIndex,
  excludePriceRangeSeries,
  flagSuspectObservations,
  flagLevelShifts,
  cleanSeries,
  isManuallyExcluded,
  indexByGroup,
  buildCategoryToGroup,
  dropUnmappedArticles,
  unitPriceChanges,
  discountShareByDate,
  findFrozenLinks,
  buildPriceReport,
  type SeriesObs,
  type Series,
  type ManualExclusion,
} from "../src/lib/price-report";
import type { PriceHistoryRecord } from "../src/lib/price-history";

// ── テスト用の行・系列 ──────────────────────────────────────────────────

function rec(p: Partial<PriceHistoryRecord> & { capturedAt: string; price: number }): PriceHistoryRecord {
  return {
    articleId: "a1",
    commit: null,
    productKey: "rk:shop/p1",
    itemCode: "shop/p1",
    name: "商品",
    rank: 1,
    provider: "rakuten",
    capacity: "100枚",
    ...p,
  };
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 7日おきの観測を価格の列から作る */
function weekly(prices: number[], start = "2026-05-01"): SeriesObs[] {
  return prices.map((price, i) => ({
    date: addDays(start, i * 7),
    price,
    capacity: "100枚",
    name: "商品",
    itemCode: "shop/p1",
  }));
}

/** 月ごとの中央値の Map を直接作る */
function monthly(entries: Record<string, Record<string, number>>) {
  return new Map(Object.entries(entries).map(([k, v]) => [k, new Map(Object.entries(v))]));
}

const allDays = (months: string[], n = 5) => new Map(months.map((m) => [m, n]));

/** n 系列ぶん、月→価格 の関数から monthly を作る（系列キーは rakuten\ta<i>\tp<i>） */
function manySeries(n: number, priceOf: (i: number, month: string) => number | null, months: string[]) {
  const out: Record<string, Record<string, number>> = {};
  for (let i = 0; i < n; i++) {
    const row: Record<string, number> = {};
    for (const m of months) {
      const p = priceOf(i, m);
      if (p != null) row[m] = p;
    }
    out[`rakuten\ta${i}\tp${i}`] = row;
  }
  return monthly(out);
}

const MONTHS = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
const OPTS = { minPairs: 3, baseMonth: "2026-05", asOf: "2026-10-11", captureDays: allDays(MONTHS) };

// ── 1. monthlySeriesPrice ───────────────────────────────────────────────

describe("monthlySeriesPrice", () => {
  it("同月の複数観測が中央値1点になる", () => {
    const s = groupSeries([
      rec({ capturedAt: "2026-05-01", price: 100 }),
      rec({ capturedAt: "2026-05-08", price: 300 }),
      rec({ capturedAt: "2026-05-15", price: 200 }),
      rec({ capturedAt: "2026-06-01", price: 400 }),
    ]);
    const m = monthlySeriesPrice(s).get("rakuten\ta1\trk:shop/p1")!;
    expect(m.get("2026-05")).toBe(200);
    expect(m.get("2026-06")).toBe(400);
  });

  it("価格0・欠損は除外", () => {
    const s = groupSeries([
      rec({ capturedAt: "2026-05-01", price: 0 }),
      rec({ capturedAt: "2026-05-08", price: NaN }),
      rec({ capturedAt: "2026-05-15", price: 200 }),
    ]);
    expect(monthlySeriesPrice(s).get("rakuten\ta1\trk:shop/p1")!.get("2026-05")).toBe(200);
  });
});

// ── 2〜4. chainedIndex ──────────────────────────────────────────────────

describe("chainedIndex", () => {
  it("隣り合う月に両方ある系列だけで比べる（入れ替わった系列は寄与しない）", () => {
    // 系列0〜2 は5〜6月とも 100、系列3 は5月だけ（6月に消える）、系列4 は6月だけ（高い）
    const m = monthly({
      "rakuten\ta0\tp0": { "2026-05": 100, "2026-06": 100 },
      "rakuten\ta1\tp1": { "2026-05": 100, "2026-06": 100 },
      "rakuten\ta2\tp2": { "2026-05": 100, "2026-06": 100 },
      "rakuten\ta3\tp3": { "2026-05": 50 },
      "rakuten\ta4\tp4": { "2026-06": 1000 },
    });
    const r = chainedIndex(m, { ...OPTS, asOf: "2026-07-15" });
    expect(r.months.map((p) => [p.month, p.index, p.pairs])).toEqual([
      ["2026-05", 100, 4],
      ["2026-06", 100, 3],
    ]);
  });

  it("全系列が一定なら 100 のまま／全系列 +10% なら 110", () => {
    const flat = manySeries(5, () => 100, MONTHS);
    expect(chainedIndex(flat, OPTS).months.every((p) => p.index === 100)).toBe(true);
    const up = manySeries(5, (_i, m) => (m === "2026-05" ? 100 : 110), MONTHS);
    expect(chainedIndex(up, OPTS).months.map((p) => p.index)).toEqual([100, 110, 110, 110, 110]);
  });

  it("基準月より前（4月）は出ない", () => {
    const m = manySeries(5, () => 100, ["2026-04", ...MONTHS]);
    const r = chainedIndex(m, { ...OPTS, captureDays: allDays(["2026-04", ...MONTHS]) });
    expect(r.months[0].month).toBe("2026-05");
  });

  it("pairs < minPairs の月は null、以降の月もすべて null（再開しない）", () => {
    // 7月に系列が2本しか続かない
    const m = manySeries(5, (i, mo) => (mo === "2026-07" && i >= 2 ? null : 100), MONTHS);
    const r = chainedIndex(m, OPTS);
    expect(r.months.map((p) => p.index)).toEqual([100, 100, null, null, null]);
    expect(r.partial!.index).toBeNull();
  });

  it("取得日が月3日未満の月は null（以降も null）", () => {
    const m = manySeries(5, () => 100, MONTHS);
    const cd = allDays(MONTHS);
    cd.set("2026-06", 2);
    expect(chainedIndex(m, { ...OPTS, captureDays: cd }).months.map((p) => p.index)).toEqual([
      100,
      null,
      null,
      null,
      null,
    ]);
  });

  it("as-of の月は本線に入らず、前月の月全体の中央値と比べた途中経過になる", () => {
    const m = manySeries(5, (_i, mo) => (mo === "2026-10" ? 120 : 100), MONTHS);
    const r = chainedIndex(m, OPTS);
    expect(r.months.map((p) => p.month)).not.toContain("2026-10");
    expect(r.partial).toEqual({ month: "2026-10", through: "2026-10-11", index: 120, pairs: 5, captureDays: 5 });
  });

  it("as-of の月の取得日が3日未満なら途中経過は null で、本線の値は変わらない", () => {
    const m = manySeries(5, (_i, mo) => (mo === "2026-10" ? 120 : 100), MONTHS);
    const cd = allDays(MONTHS);
    cd.set("2026-10", 2);
    const r = chainedIndex(m, { ...OPTS, captureDays: cd });
    expect(r.partial!.index).toBeNull();
    expect(r.months).toEqual(chainedIndex(m, OPTS).months);
  });
});

// ── 5. 取得不具合の除外 ─────────────────────────────────────────────────

function series(p: Partial<Series> & { obs: SeriesObs[] }): Series {
  const provider = p.provider ?? "rakuten";
  const articleId = p.articleId ?? "a1";
  const productKey = p.productKey ?? "rk:shop/p1";
  return { key: `${provider}\t${articleId}\t${productKey}`, provider, articleId, productKey, obs: p.obs };
}

describe("excludePriceRangeSeries", () => {
  const codes = new Set(["shop/p1"]);
  it("名簿の itemCode の楽天の系列が外れ、同じ itemCode の Yahoo の系列は残る", () => {
    const rk = series({ obs: weekly([100]) });
    const yh = series({ provider: "yahoo", obs: weekly([100]) });
    const { kept, excluded } = excludePriceRangeSeries([rk, yh], codes);
    expect(excluded).toEqual([rk]);
    expect(kept).toEqual([yh]);
  });

  it("itemCode の大文字小文字の違いを吸収する", () => {
    const obs = weekly([100]).map((o) => ({ ...o, itemCode: "Shop/P1" }));
    expect(excludePriceRangeSeries([series({ obs })], codes).excluded).toHaveLength(1);
  });

  it("itemCode が null の系列は外さない", () => {
    const obs = weekly([100]).map((o) => ({ ...o, itemCode: null }));
    expect(excludePriceRangeSeries([series({ obs })], codes).kept).toHaveLength(1);
  });
});

describe("flagSuspectObservations", () => {
  it("単発の ×2・×1/2 → 誤判定型", () => {
    expect([...flagSuspectObservations(weekly([100, 100, 100, 200, 100, 100, 100]))]).toEqual([[3, "set-multiple"]]);
    expect([...flagSuspectObservations(weekly([100, 100, 100, 50, 100, 100, 100]))]).toEqual([[3, "set-multiple"]]);
  });

  it("単発の ×1.7 → 原因不明型", () => {
    expect([...flagSuspectObservations(weekly([100, 100, 100, 170, 100, 100, 100]))]).toEqual([[3, "unknown"]]);
  });

  it("近傍が3点未満なら判定しない", () => {
    expect(flagSuspectObservations(weekly([100, 100, 300])).size).toBe(0);
  });

  it("±40% 未満の値下がり（通常のセール）は残る", () => {
    expect(flagSuspectObservations(weekly([100, 100, 100, 65, 100, 100, 100])).size).toBe(0);
  });
});

describe("flagLevelShifts", () => {
  const run = (prices: number[], start?: string, singles = new Set<number>()) =>
    flagLevelShifts(weekly(prices, start), singles);

  it("×1/2 が4週続いて2観測連続で戻る → 区間全体を検出", () => {
    const r = run([100, 100, 100, 50, 50, 50, 50, 100, 100]);
    expect([...r.flagged].sort()).toEqual([3, 4, 5, 6]);
    expect(r.intervals).toBe(1);
  });

  it("84日ちょうど → 検出・85日 → 検出しない（暦日）", () => {
    const mk = (lastDay: number): SeriesObs[] =>
      [0, 7, 14, 21, 21 + lastDay, 21 + lastDay + 7, 21 + lastDay + 14].map((d, i) => ({
        date: addDays("2026-05-01", d),
        price: i >= 3 && i <= 4 ? 50 : 100,
        capacity: null,
        name: "x",
        itemCode: null,
      }));
    // 始点 = index3（21日目）、終点 = index4（21+lastDay日目）
    expect(flagLevelShifts(mk(84), new Set()).intervals).toBe(1);
    expect(flagLevelShifts(mk(85), new Set()).intervals).toBe(0);
  });

  it("区間の途中に 0.7 倍の観測が挟まる → 区間に含めて1つの段差として検出", () => {
    const r = run([100, 100, 100, 50, 70, 50, 50, 100, 100]);
    expect([...r.flagged].sort()).toEqual([3, 4, 5, 6]);
    expect(r.intervals).toBe(1);
  });

  it("戻りが1観測だけでまた外れる → 区間を延長する", () => {
    const r = run([100, 100, 100, 50, 50, 100, 50, 50, 100, 100]);
    expect([...r.flagged].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7]);
    expect(r.intervals).toBe(1);
  });

  it("区間の過半数が 0.6〜0.85 倍 → 検出しない", () => {
    const r = run([100, 100, 100, 50, 70, 70, 70, 100, 100]);
    expect(r.flagged.size).toBe(0);
  });

  it("戻りが無いまま系列が終わる → 判定しない", () => {
    const r = run([100, 100, 100, 50, 50, 50]);
    expect(r.flagged.size).toBe(0);
    expect(r.unresolvedNoReturn).toBe(1);
  });

  it("始点の前に3観測ない → 判定しない", () => {
    const r = run([100, 100, 50, 50, 100, 100]);
    expect(r.flagged.size).toBe(0);
    expect(r.unresolvedNoBaseline).toBeGreaterThan(0);
  });

  it("段差のあとに2つ目の段差 → 戻った観測から L0 を作り直して別々に検出", () => {
    const r = run([100, 100, 100, 50, 50, 100, 100, 100, 200, 200, 100, 100]);
    expect([...r.flagged].sort((a, b) => a - b)).toEqual([3, 4, 8, 9]);
    expect(r.intervals).toBe(2);
  });

  it("区間の途中で L0 が変わらない（区間内の観測で基準を作り直さない）", () => {
    // 区間内で 50 が続いても基準は 100 のまま。50 の後の 52 も外れとして区間に残る
    const r = run([100, 100, 100, 50, 50, 50, 52, 52, 100, 100]);
    expect([...r.flagged].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7]);
  });

  it("始点の直前3観測に第2段の単発の外れが含まれる → その観測を除いた3観測で L0 を作る", () => {
    // index3 の 150 を単発の外れとして渡す。L0 から除くと median(90,100,110)=100 で
    // 60 は 0.6 倍＝外れでない。除かないと median(100,110,150)=110 で 60 は 0.545 倍＝段差になる
    const prices = [90, 100, 110, 150, 60, 60, 100, 100];
    expect(run(prices, undefined, new Set([3])).flagged.size).toBe(0);
    expect([...run(prices).flagged].sort()).toEqual([4, 5]);
  });
});

describe("cleanSeries", () => {
  it("単発判定と重なった観測は段差側に1回だけ数える", () => {
    // 3観測だけの段差は index4〜6 が単発にも引っかかる
    const s = series({ obs: weekly([100, 100, 100, 100, 50, 50, 50, 100, 100, 100, 100]) });
    expect([...flagSuspectObservations(s.obs).keys()]).toEqual([4, 5, 6]);
    const { series: out, stats } = cleanSeries([s], new Set(), []);
    expect(stats.levelShift.observations).toBe(3);
    expect(stats.suspect.setMultiple + stats.suspect.unknown).toBe(0);
    expect(out[0].obs.map((o) => o.price)).toEqual([100, 100, 100, 100, 100, 100, 100, 100]);
  });

  it("exclusions.json の期間指定が効く", () => {
    const s = series({ obs: weekly([100, 100, 100, 100]) });
    const ex: ManualExclusion[] = [
      {
        provider: "rakuten",
        articleId: "a1",
        productKey: "rk:shop/p1",
        from: "2026-05-08",
        to: "2026-05-15",
        reason: "テスト",
      },
    ];
    expect(isManuallyExcluded(s, "2026-05-01", ex)).toBe(false);
    expect(isManuallyExcluded(s, "2026-05-08", ex)).toBe(true);
    const { series: out, stats } = cleanSeries([s], new Set(), ex);
    expect(out[0].obs.map((o) => o.date)).toEqual(["2026-05-01", "2026-05-22"]);
    expect(stats.manual.observations).toBe(2);
  });
});

// ── 6. provider を混ぜない ─────────────────────────────────────────────

describe("provider を混ぜない", () => {
  it("同じ記事・productKey でも provider が違えば別系列", () => {
    const s = groupSeries([
      rec({ capturedAt: "2026-05-01", price: 100 }),
      rec({ capturedAt: "2026-05-01", price: 200, provider: "yahoo" }),
    ]);
    expect(s.map((x) => [x.provider, x.obs[0].price])).toEqual([
      ["rakuten", 100],
      ["yahoo", 200],
    ]);
  });
});

// ── 7. unitPriceChanges ─────────────────────────────────────────────────

describe("unitPriceChanges", () => {
  it("容量が減って価格が同じ → 検出", () => {
    const obs = weekly([100, 100]);
    obs[1].capacity = "90枚";
    const r = unitPriceChanges([series({ obs })]);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ fromTotal: 100, toTotal: 90, direction: "decrease", priceAfter: 100 });
  });

  it("容量の解析に失敗 → 除外件数に入る", () => {
    const obs = weekly([100, 100, 100]);
    obs[1].capacity = "不明";
    obs[2].capacity = null;
    const r = unitPriceChanges([series({ obs })]);
    expect(r.changes).toHaveLength(0);
    expect(r.unparsedObservations).toBe(2);
  });
});

// ── 8. discountShareByDate ──────────────────────────────────────────────

describe("discountShareByDate", () => {
  it("直近28日に3点未満の系列は分母に入らない", () => {
    const r = discountShareByDate([series({ obs: weekly([100, 100, 50]) })]);
    expect(r.every((p) => p.eligible === 0)).toBe(true);
  });

  it("当日の観測は基準の中央値に入らない", () => {
    // 前3週 [100,100,80]・当日 85 → 当日を含めない中央値 100 → 値下がり（含めると 92.5 で値下がりにならない）
    const r = discountShareByDate([series({ obs: weekly([100, 100, 80, 85]) })]);
    expect(r[3]).toMatchObject({ eligible: 1, discounted: 1 });
  });

  it("直近28日は前日までの28日間（29日前の観測は入らない）", () => {
    const mk = (days: number[]): SeriesObs[] =>
      days.map((d) => ({ date: addDays("2026-05-01", d), price: 100, capacity: null, name: "x", itemCode: null }));
    // 29日目から見て 1日目は28日前（入る）、0日目は29日前（入らない）
    expect(discountShareByDate([series({ obs: mk([1, 20, 25, 29]) })]).at(-1)).toMatchObject({ eligible: 1 });
    expect(discountShareByDate([series({ obs: mk([0, 20, 25, 29]) })]).at(-1)).toMatchObject({ eligible: 0 });
  });

  it("除外済みの観測は基準の中央値に入らない", () => {
    // 2日おき [100,100,100,65,65,65,85]。6〜10日目を手入力で除外する
    const obs: SeriesObs[] = [100, 100, 100, 65, 65, 65, 85].map((price, i) => ({
      date: addDays("2026-05-01", i * 2),
      price,
      capacity: null,
      name: "x",
      itemCode: null,
    }));
    const s = series({ obs });
    const ex: ManualExclusion[] = [
      { provider: "rakuten", articleId: "a1", productKey: "rk:shop/p1", from: "2026-05-07", to: "2026-05-11", reason: "t" },
    ];
    const { series: cleaned } = cleanSeries([s], new Set(), ex);
    // 除外後の基準 = median(100,100,100) → 85 は値下がり（除外しなければ基準 82.5 で値下がりにならない）
    expect(discountShareByDate(cleaned).at(-1)).toMatchObject({ eligible: 1, discounted: 1 });
    expect(discountShareByDate([s]).at(-1)).toMatchObject({ discounted: 0 });
  });
});

// ── 9. 決定性 ───────────────────────────────────────────────────────────

describe("buildPriceReport の決定性", () => {
  const groups = [{ id: "g1", label: "グループ1", categories: ["c1"] }];
  const records: PriceHistoryRecord[] = [];
  for (let i = 0; i < 4; i++) {
    for (const [d, p] of [
      ["2026-05-01", 100],
      ["2026-05-08", 100],
      ["2026-05-15", 100],
      ["2026-06-01", 110],
      ["2026-06-08", 110],
      ["2026-06-15", 110],
    ] as const) {
      records.push(rec({ capturedAt: d, price: p + i, productKey: `rk:shop/p${i}`, itemCode: `shop/p${i}` }));
    }
  }
  const base = {
    asOf: "2026-06-20",
    priceRangeCodes: [],
    exclusions: [],
    articleCategory: { a1: "c1" },
    groups,
    minPairs: 2,
    minGroupPairs: 2,
  };

  it("同じ入力・as-of で JSON が完全に一致する", () => {
    expect(JSON.stringify(buildPriceReport({ ...base, records }))).toBe(
      JSON.stringify(buildPriceReport({ ...base, records })),
    );
  });

  it("as-of より後の行が混ざっていても結果が同じ（droppedAfterAsOf 以外）", () => {
    const later = [...records, rec({ capturedAt: "2026-07-01", price: 999 })];
    const a = buildPriceReport({ ...base, records });
    const b = buildPriceReport({ ...base, records: later });
    expect(b.input.droppedAfterAsOf).toBe(1);
    expect({ ...b, input: { ...b.input, droppedAfterAsOf: 0 } }).toEqual(a);
  });

  it("入力の行の順番を入れ替えても結果が同じ", () => {
    expect(JSON.stringify(buildPriceReport({ ...base, records: [...records].reverse() }))).toBe(
      JSON.stringify(buildPriceReport({ ...base, records })),
    );
  });

  it("出力に実行時刻が入っていない", () => {
    const json = JSON.stringify(buildPriceReport({ ...base, records }));
    expect(json).not.toMatch(/generatedAt|\d{4}-\d{2}-\d{2}T\d{2}:/);
  });
});

// ── 11. findFrozenLinks ─────────────────────────────────────────────────

describe("findFrozenLinks", () => {
  it("凍結中の slug だけを返す", () => {
    const frozen = new Set(["toilet-paper-comparison", "mask-comparison"]);
    expect(findFrozenLinks(["toilet-paper-comparison", "rice-comparison", "mask-comparison"], frozen)).toEqual([
      "toilet-paper-comparison",
      "mask-comparison",
    ]);
  });
});

// ── 12. グループ ────────────────────────────────────────────────────────

describe("グループの対応", () => {
  it("どのグループにも入らないカテゴリがあると例外になる", () => {
    expect(() => buildCategoryToGroup([{ id: "g1", label: "g", categories: ["c1"] }], ["c1", "c2"])).toThrow(/c2/);
  });

  it("記事→カテゴリの対応が取れない articleId は集計から外れ、件数が返る", () => {
    const r = dropUnmappedArticles(
      [series({ articleId: "a1", obs: weekly([1]) }), series({ articleId: "gone", obs: weekly([1]) })],
      new Map([["a1", "c1"]]),
    );
    expect(r.series.map((s) => s.articleId)).toEqual(["a1"]);
    expect(r.unmappedArticleIds).toEqual(["gone"]);
  });

  it("pairs < minGroupPairs のグループの月は null（以降も null）", () => {
    // g1: 系列3本（7月に1本だけ）・g2: 系列3本（ずっと続く）
    const m = monthly({
      "rakuten\ta0\tp0": { "2026-05": 100, "2026-06": 100, "2026-07": 100, "2026-08": 100 },
      "rakuten\ta0\tp1": { "2026-05": 100, "2026-06": 100, "2026-08": 100 },
      "rakuten\ta0\tp2": { "2026-05": 100, "2026-06": 100, "2026-08": 100 },
      "rakuten\ta1\tp3": { "2026-05": 100, "2026-06": 100, "2026-07": 100, "2026-08": 100 },
      "rakuten\ta1\tp4": { "2026-05": 100, "2026-06": 100, "2026-07": 100, "2026-08": 100 },
      "rakuten\ta1\tp5": { "2026-05": 100, "2026-06": 100, "2026-07": 100, "2026-08": 100 },
    });
    const groups = [
      { id: "g1", label: "1", categories: ["c1"] },
      { id: "g2", label: "2", categories: ["c2"] },
    ];
    const r = indexByGroup(
      m,
      new Map([
        ["a0", "c1"],
        ["a1", "c2"],
      ]),
      groups,
      { minPairs: 2, baseMonth: "2026-05", asOf: "2026-09-05", captureDays: allDays(MONTHS) },
    );
    expect(r[0].result.months.map((p) => p.index)).toEqual([100, 100, null, null]);
    expect(r[1].result.months.map((p) => p.index)).toEqual([100, 100, 100, 100]);
  });
});

describe("captureDaysByMonth", () => {
  it("観測のある日付を月ごとに数える", () => {
    const s = groupSeries([
      rec({ capturedAt: "2026-05-01", price: 1 }),
      rec({ capturedAt: "2026-05-01", price: 1, productKey: "x" }),
      rec({ capturedAt: "2026-05-02", price: 1 }),
    ]);
    expect(captureDaysByMonth(s).get("2026-05")).toBe(2);
  });
});
