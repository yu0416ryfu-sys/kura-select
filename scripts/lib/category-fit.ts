/**
 * 記事の既存商品が「いま この記事の追加候補として出てきたら採用されるか」を判定する。
 *
 * 低順位記事の底上げ Phase 1（`docs/IMPLEMENTATION_PLAN_LOW_RANK_ARTICLE_LIFT_2026-08-23.md` §4.4）。
 * 楽天APIは叩かない。判定は `reports/item-names/item-names-*.jsonl` の**実出品名**に対して行う。
 *
 * 設計原則: 本番のガードと同じ定義・同じ評価順を使う。
 * ルールとスコア関数は `search-rules.ts` から import する（複製しない）。
 *
 * 本番（`update-products.mjs` の checkAdditions）の評価順:
 *   stage1 checkAdditionCandidateCategory → stage2 isAllowedCapacityUnit → stage4 scoreAdditionCandidate
 *
 * ただし **重大度は検出目的に合わせる**: stage1 / stage4 は error、stage2（unit-mismatch）は warn。
 * stage2 を error にすると販促文字列の誤抽出（`365日出荷対応`→`365日`）と L/kg 非正規化で
 * 誤検知が倍増し、§4.8 のゲートが機能しなくなる（v6 / F24）。
 *
 * `isSameProductDifferentUrl()` は候補 vs 既存商品の重複排除なので使わない
 * （既存商品同士を突き合わせると自己一致で全滅する）。
 */
import {
  resolveArticleSearchRule,
  checkAdditionCandidateCategory,
  isAllowedCapacityUnit,
  scoreAdditionCandidate,
  CATEGORY_SEARCH_RULES,
  getArticleSpecificAdditionRule,
  type ResolvedSearchRule,
} from './search-rules.ts';
import { extractCapacityFromItemName, extractAllProductsData, extractProductSnapshotByRank } from './frontmatter.ts';
import { toRakutenUrlKey } from './rakuten-url.ts';
import { isLikelySameProductName } from './product-name-match.ts';

/** 実出品名が取れた商品だけが判定対象。取れないものは unknown（判定不能） */
export const KNOWN_ITEM_METHOD = '[Item/Get]';

export type FitCode =
  | 'ok'
  | 'excluded-term'
  | 'required-group-miss'
  | 'no-include-hit'
  | 'below-min-score'
  | 'name-mismatch'
  | 'unit-mismatch'
  | 'borderline'
  | 'unknown';

export type FitSeverity = 'error' | 'warn' | 'ok' | 'unknown';

/** 判定にかける1商品。candidateText() は name しか読まないので name が本体 */
export interface FitProduct {
  slug: string;
  articleFile: string;
  rank: number | null;
  /** 記事 frontmatter の商品名 */
  currentName: string;
  /** 楽天APIが返した実出品名。null は unknown */
  itemName: string | null;
  method: string | null;
  price: number | null;
  reviewCount: number | null;
  rating: number | null;
}

export interface FitFinding {
  slug: string;
  articleFile: string;
  rank: number | null;
  currentName: string;
  itemName: string | null;
  code: FitCode;
  severity: FitSeverity;
  /** どの段で落ちたか。人間が誤検知を判断するための一次情報 */
  stage: 'stage1' | 'stage2' | 'stage4' | 'name' | null;
  reason: string | null;
  score: number | null;
  scoreReasons: string[];
  capacity: string | null;
}

export interface ArticleFit {
  slug: string;
  articleFile: string;
  category: string;
  baseKeyword: string;
  /** カテゴリ rule も記事別 rule も無い / 兄弟とカテゴリを共有していて記事別 rule が無い */
  ruleMissing: RuleMissingKind | null;
  findings: FitFinding[];
  /** 判定できた商品数（unknown を分母から除く） */
  judged: number;
  unknown: number;
  errors: number;
  warns: number;
  total: number;
  /** 判定できた商品に占める error 率。judged が 0 なら null（0% ではない） */
  errorRate: number | null;
}

export type RuleMissingKind = 'no-category-rule' | 'shared-category-no-article-rule';

const SEVERITY_BY_CODE: Record<FitCode, FitSeverity> = {
  'ok': 'ok',
  'excluded-term': 'error',
  'required-group-miss': 'error',
  'no-include-hit': 'error',
  'below-min-score': 'error',
  'name-mismatch': 'error',
  'unit-mismatch': 'warn',
  'borderline': 'warn',
  'unknown': 'unknown',
};

/** stage1 の reason 文字列から判定コードを決める（本番の文言に依存する箇所を1か所に閉じる） */
export function classifyStage1Reason(reason: string | null): FitCode {
  if (!reason) return 'no-include-hit';
  if (reason.startsWith('除外語')) return 'excluded-term';
  if (reason.startsWith('必須語なし')) return 'required-group-miss';
  return 'no-include-hit';
}

/**
 * 1商品を本番と同じ順で判定する。
 *
 * name-mismatch は stage1 より前に見る。実出品名が別商品なら、
 * その先の stage1〜4 は「別商品に対する判定」になって意味を持たないため。
 */
export function judgeProduct(product: FitProduct, rule: ResolvedSearchRule): FitFinding {
  const base = {
    slug: product.slug,
    articleFile: product.articleFile,
    rank: product.rank,
    currentName: product.currentName,
    itemName: product.itemName,
  };

  if (!product.itemName) {
    return { ...base, code: 'unknown', severity: 'unknown', stage: null, reason: '実出品名が未集約', score: null, scoreReasons: [], capacity: null };
  }
  if (product.method !== KNOWN_ITEM_METHOD) {
    return {
      ...base, code: 'name-mismatch', severity: 'error', stage: 'name',
      reason: `method が ${product.method ?? '(不明)'}（${KNOWN_ITEM_METHOD} 以外は別商品の可能性）`,
      score: null, scoreReasons: [], capacity: null,
    };
  }
  if (!isLikelySameProductName(product.currentName, product.itemName)) {
    return {
      ...base, code: 'name-mismatch', severity: 'error', stage: 'name',
      reason: '記事の商品名と実出品名が一致しない（商品名ドリフト）',
      score: null, scoreReasons: [], capacity: null,
    };
  }

  const candidate = { name: product.itemName, price: product.price, reviewCount: product.reviewCount, rating: product.rating };

  // stage1: カテゴリ判定（exclude / requiredGroups / requireInclude の二値 reject）
  const category = checkAdditionCandidateCategory(candidate, rule);
  if (!category.ok) {
    const code = classifyStage1Reason(category.reason);
    return { ...base, code, severity: SEVERITY_BY_CODE[code], stage: 'stage1', reason: category.reason, score: null, scoreReasons: [], capacity: null };
  }

  // stage2: 容量単位。本番 :2895 と同じく実出品名から抽出する（frontmatter の capacity ではない）。
  // `capacity &&` ガードは必須——容量が抽出できない商品は本番も reject しない。
  const capacity = extractCapacityFromItemName(product.itemName);
  const unitMismatch = Boolean(capacity) && !isAllowedCapacityUnit(capacity as string, rule);

  // stage4: スコア
  const scored = scoreAdditionCandidate(candidate, rule);
  if (scored.score < rule.minScore) {
    return {
      ...base, code: 'below-min-score', severity: 'error', stage: 'stage4',
      reason: `スコア不足 ${scored.score} < ${rule.minScore}`,
      score: scored.score, scoreReasons: scored.reasons, capacity,
    };
  }

  // ここから先は本番なら採用される。警告だけ添える
  if (unitMismatch) {
    return {
      ...base, code: 'unit-mismatch', severity: 'warn', stage: 'stage2',
      reason: `比較対象外の容量単位: ${capacity}（許可: ${(rule.units ?? []).join('/')}）`,
      score: scored.score, scoreReasons: scored.reasons, capacity,
    };
  }
  if (scored.score < rule.minScore + 2) {
    return {
      ...base, code: 'borderline', severity: 'warn', stage: 'stage4',
      reason: `スコアが下限すれすれ ${scored.score}（下限 ${rule.minScore}）`,
      score: scored.score, scoreReasons: scored.reasons, capacity,
    };
  }
  return { ...base, code: 'ok', severity: 'ok', stage: 'stage4', reason: null, score: scored.score, scoreReasons: scored.reasons, capacity };
}

/**
 * ルール未定義の種別を返す。
 *
 * (a) カテゴリの rule 自体が無い、(b) 他の comparison 記事とカテゴリを共有していて
 * 記事別ルールが解決できない、のどちらか。どちらも「ガードが最も弱い状態で動いている」
 * という構造の指摘であり、商品が壊れている意味ではない。
 */
export function detectRuleMissing(
  category: string,
  baseKeyword: string,
  articlesInCategory: number
): RuleMissingKind | null {
  const hasArticleRule = getArticleSpecificAdditionRule(category, baseKeyword) !== null;
  if (hasArticleRule) return null;
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_SEARCH_RULES, category)) return 'no-category-rule';
  if (articlesInCategory > 1) return 'shared-category-no-article-rule';
  return null;
}

/** 実出品名の索引（key = shopCode/itemCode 小文字）が返す行の最小形 */
export interface ItemNameLookup {
  itemName?: string | null;
  method?: string | null;
}

/**
 * 記事本文から判定用の候補を組み立てる。
 *
 * **`extractAllProductsData()` は price / rating を返さない**（rank・name・capacity・
 * reviewCount・rakutenUrl のみ）。`scoreAdditionCandidate()` は price と rating を
 * 加点に使うので、snapshot から補わないと素点が本番より低く出て `below-min-score` が
 * 大量に誤発火する（実測: 補完前 35件 → 補完後 0件）。
 *
 * 実出品名の索引キーは `toRakutenUrlKey()` で作る。item-names 側と同じ関数を使わないと
 * キーがずれて全件 unknown になる。
 */
export function buildFitProducts(
  content: string,
  { slug, articleFile, itemNames }: { slug: string; articleFile: string; itemNames: Map<string, ItemNameLookup> }
): FitProduct[] {
  return extractAllProductsData(content).map(product => {
    const snapshot = product.rank != null ? extractProductSnapshotByRank(content, product.rank) : null;
    const key = toRakutenUrlKey(product.rakutenUrl);
    const row = key ? itemNames.get(key) : null;
    return {
      slug,
      articleFile,
      rank: product.rank ?? null,
      currentName: product.name,
      itemName: row?.itemName ?? null,
      method: row?.method ?? null,
      price: snapshot?.price ?? null,
      rating: snapshot?.rating ?? null,
      reviewCount: snapshot?.reviewCount ?? product.reviewCount ?? null,
    };
  });
}

export interface FitArticleInput {
  slug: string;
  articleFile: string;
  title: string;
  category: string;
  products: FitProduct[];
  /** 同じカテゴリを使っている comparison 記事の本数（自分を含む） */
  articlesInCategory: number;
}

export function judgeArticle(article: FitArticleInput): ArticleFit {
  const { baseKeyword, rule } = resolveArticleSearchRule({
    title: article.title,
    products: article.products.map(p => ({ name: p.currentName })),
    file: article.articleFile,
    category: article.category,
  });
  const findings = article.products.map(product => judgeProduct(product, rule));
  const unknown = findings.filter(f => f.severity === 'unknown').length;
  const errors = findings.filter(f => f.severity === 'error').length;
  const warns = findings.filter(f => f.severity === 'warn').length;
  const judged = findings.length - unknown;

  return {
    slug: article.slug,
    articleFile: article.articleFile,
    category: article.category,
    baseKeyword,
    ruleMissing: detectRuleMissing(article.category, baseKeyword, article.articlesInCategory),
    findings,
    judged,
    unknown,
    errors,
    warns,
    total: findings.length,
    errorRate: judged > 0 ? errors / judged : null,
  };
}

export interface FitSummary {
  articles: number;
  products: number;
  judged: number;
  unknown: number;
  errors: number;
  warns: number;
  /** 判定できた商品に占める error 率 */
  errorRate: number | null;
  /** 判定できた商品の過半数が error の記事 */
  majorityErrorSlugs: string[];
  ruleMissing: { slug: string; category: string; kind: RuleMissingKind }[];
  byCode: { code: FitCode; count: number }[];
}

export function summarize(articles: readonly ArticleFit[]): FitSummary {
  const all = articles.flatMap(a => a.findings);
  const counts = new Map<FitCode, number>();
  for (const finding of all) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);

  const judged = all.filter(f => f.severity !== 'unknown').length;
  const errors = all.filter(f => f.severity === 'error').length;

  return {
    articles: articles.length,
    products: all.length,
    judged,
    unknown: all.length - judged,
    errors,
    warns: all.filter(f => f.severity === 'warn').length,
    errorRate: judged > 0 ? errors / judged : null,
    // 判定できた商品が0本の記事は「過半数 error」に数えない（判定不能であって異常ではない）
    majorityErrorSlugs: articles
      .filter(a => a.errorRate !== null && a.errorRate > 0.5)
      .sort((a, b) => (b.errorRate ?? 0) - (a.errorRate ?? 0) || b.errors - a.errors)
      .map(a => a.slug),
    ruleMissing: articles
      .filter(a => a.ruleMissing !== null)
      .map(a => ({ slug: a.slug, category: a.category, kind: a.ruleMissing as RuleMissingKind })),
    byCode: [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
  };
}

const pct = (value: number | null) => (value === null ? '判定不能' : `${(value * 100).toFixed(1)}%`);

/** Markdown レポート。冒頭に必ず「判定できた母数」と unknown を書く */
export function formatFitReport(
  articles: readonly ArticleFit[],
  summary: FitSummary,
  { today, inputPath }: { today: string; inputPath: string }
): string {
  const lines: string[] = [];
  lines.push(`# カテゴリ適合スキャン（${today}）`);
  lines.push('');
  lines.push(`- 対象記事: **${summary.articles}** / 商品: **${summary.products}**`);
  lines.push(`- **判定できた商品: ${summary.judged}** ・ **unknown（実出品名なし＝判定不能）: ${summary.unknown}**`);
  lines.push(`- error: **${summary.errors}**（判定できた商品の ${pct(summary.errorRate)}） ・ warn: ${summary.warns}`);
  lines.push(`- 入力: \`${inputPath}\``);
  lines.push('');
  lines.push('> unknown は「問題なし」ではなく **判定不能** です。error 0 と混同しないこと。');
  lines.push('> stage2（unit-mismatch）は warn です。販促文字列の誤抽出と L/kg 非正規化で誤爆するため。');
  lines.push('> 商品は書き換えていません。是正は Phase 3 の枠で、凍結表を確認してから行います。');
  lines.push('>');
  lines.push('> ⚠️ **error 一覧を Phase 3 のターゲティングにそのまま使わないこと。**');
  lines.push('> 初回ゲート（2026-08-27・error 記事から無作為10本を目視）で **誤検知 8本** となり、');
  lines.push('> 計画書 §4.8 の受け入れ基準（誤検知2本以下）を満たさなかった。判定条件をいじって粘らず、');
  lines.push('> **本レポートの用途は「ルール未定義の記事」の構造把握に限定**する。');
  lines.push('> error の主因は実出品名が販促文字列であることで、除外語が意味を反転して当たる');
  lines.push('> （例: `殺虫成分不使用` に除外語 `殺虫` がヒット）。個別の error は1件ずつ現物を見ること。');
  lines.push('');

  lines.push('## 判定コード別の件数');
  lines.push('');
  lines.push('| コード | 重大度 | 件数 |');
  lines.push('|---|---|---:|');
  for (const { code, count } of summary.byCode) {
    lines.push(`| \`${code}\` | ${SEVERITY_BY_CODE[code]} | ${count} |`);
  }
  lines.push('');

  const majority = articles.filter(a => a.errorRate !== null && a.errorRate > 0.5)
    .sort((a, b) => (b.errorRate ?? 0) - (a.errorRate ?? 0) || b.errors - a.errors);
  lines.push(`## 判定できた商品の過半数が error の記事（${majority.length}本）`);
  lines.push('');
  if (majority.length === 0) {
    lines.push('なし。');
  } else {
    lines.push('| slug | error / 判定できた数 | unknown | error率 |');
    lines.push('|---|---:|---:|---:|');
    for (const a of majority) {
      lines.push(`| ${a.slug} | ${a.errors} / ${a.judged} | ${a.unknown} | ${pct(a.errorRate)} |`);
    }
  }
  lines.push('');

  lines.push(`## ルール未定義の記事（${summary.ruleMissing.length}本）`);
  lines.push('');
  lines.push('「ガードが最も弱い状態で動いている」という構造の指摘であり、商品が壊れている意味ではありません。');
  lines.push('');
  if (summary.ruleMissing.length === 0) {
    lines.push('なし。');
  } else {
    lines.push('| slug | category | 種別 |');
    lines.push('|---|---|---|');
    for (const row of summary.ruleMissing) {
      const kind = row.kind === 'no-category-rule' ? 'カテゴリ rule 自体が無い' : '兄弟とカテゴリ共有・記事別 rule 無し';
      lines.push(`| ${row.slug} | ${row.category} | ${kind} |`);
    }
  }
  lines.push('');

  lines.push('## 記事別の詳細（error / warn があるものだけ）');
  lines.push('');
  const detailed = articles.filter(a => a.errors > 0 || a.warns > 0)
    .sort((a, b) => b.errors - a.errors || (b.errorRate ?? 0) - (a.errorRate ?? 0) || (a.slug < b.slug ? -1 : 1));
  for (const article of detailed) {
    lines.push(`### ${article.slug}`);
    lines.push('');
    lines.push(`- category: \`${article.category}\` / baseKeyword: \`${article.baseKeyword}\``);
    lines.push(`- error ${article.errors} / warn ${article.warns} / 判定できた ${article.judged}（unknown ${article.unknown}）`);
    lines.push('');
    lines.push('| rank | 判定 | 段 | 理由 | score | 記事の商品名 | 実出品名 |');
    lines.push('|---:|---|---|---|---:|---|---|');
    for (const f of article.findings) {
      if (f.severity === 'ok') continue;
      const rank = f.rank === null ? '-' : String(f.rank);
      const score = f.score === null ? '-' : String(f.score);
      const itemName = f.itemName ? f.itemName.slice(0, 60).replace(/\|/g, '｜') : '(未集約)';
      lines.push(`| ${rank} | \`${f.code}\` | ${f.stage ?? '-'} | ${(f.reason ?? '').replace(/\|/g, '｜')} | ${score} | ${f.currentName.slice(0, 40).replace(/\|/g, '｜')} | ${itemName} |`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}
