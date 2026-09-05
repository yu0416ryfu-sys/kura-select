// 楽天 genreId によるカテゴリ混入検出（判定のみ）。
//
// 記事 frontmatter の products[].genreId（楽天が返した事実）と
// data/article-genres.json の期待ジャンル（人間の判断）を突き合わせる。
// ファイル I/O と CLI 出力は scripts/check-genre-fit.mjs が持つ。
//
// 計画書: docs/IMPLEMENTATION_PLAN_RAKUTEN_GENRE_ID_2026-09-05.md §3.5
import { normalizeGenreId } from './frontmatter.ts';

/** 外れ率の閾値。これ以下なら混入候補、超えたら記事設計の問題として扱う */
export const CONTAMINATION_MAX_RATIO = 0.25;

export type GenreFitCode = 'clean' | 'contamination' | 'design-review' | 'unconfigured' | 'no-data';

export const GENRE_FIT_CODES: readonly GenreFitCode[] = [
  'clean', 'contamination', 'design-review', 'unconfigured', 'no-data',
];

export interface GenreProduct { rank: number | null; name: string; genreId: string | null; }
export interface ArticleGenrePolicy { expected: string[]; note?: string; }

export interface GenreFinding {
  rank: number | null; name: string; genreId: string | null; isOutlier: boolean;
}

export interface ArticleGenreFit {
  slug: string;
  code: GenreFitCode;
  expected: string[];
  /** 期待ジャンル未設定のとき多数派から提案する値。設定済みなら null */
  proposedExpected: string[] | null;
  total: number;
  withGenre: number;
  outliers: number;
  outlierRatio: number | null;
  distribution: Array<{ genreId: string; count: number }>;
  findings: GenreFinding[];
  /** data/measurement-holds.json 由来。凍結中なら着手可能日、期限なし凍結なら 'open-ended'、でなければ null */
  heldUntil: string | null;
}

export interface GenreFitSummary {
  articles: number;
  products: number;
  withGenre: number;
  /** code 別の記事数。すべての GenreFitCode をキーに持つ（0 件でもキーを落とさない） */
  byCode: Record<GenreFitCode, number>;
  /** contamination 記事のうち凍結中でないもの＝今すぐ着手できる件数 */
  actionable: number;
}

/** genreId の出現数を件数降順（同数は genreId 昇順）で数える。genreId なしは数えない */
export function tallyGenres(products: readonly GenreProduct[]): Array<{ genreId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const product of products) {
    const genreId = normalizeGenreId(product.genreId);
    if (!genreId) continue;
    counts.set(genreId, (counts.get(genreId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([genreId, count]) => ({ genreId, count }))
    .sort((a, b) => (b.count - a.count) || a.genreId.localeCompare(b.genreId));
}

/**
 * 期待ジャンル未設定の記事に提案する値。最多件数のジャンル（同数なら全部）を返す。
 * ⚠️ 多数派＝正ではない（計画書 §2 の反例）。人間の承認を前提とした提案値でしかない。
 */
export function proposeExpectedGenres(products: readonly GenreProduct[]): string[] {
  const tally = tallyGenres(products);
  if (tally.length === 0) return [];
  const top = tally[0].count;
  return tally.filter(entry => entry.count === top).map(entry => entry.genreId);
}

/**
 * data/article-genres.json の1件を正規化する。
 * expected が number で書かれていても文字列に寄せる（手書き JSON を許容する）。
 * expected が空配列 / 欠落なら null を返し、呼び出し側は unconfigured として扱う。
 */
export function normalizePolicy(raw: unknown): ArticleGenrePolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const rawExpected = record.expected;
  if (!Array.isArray(rawExpected)) return null;
  const expected = rawExpected
    .map(value => normalizeGenreId(value))
    .filter((value): value is string => value !== null);
  if (expected.length === 0) return null;
  const note = typeof record.note === 'string' ? record.note : undefined;
  return note === undefined ? { expected } : { expected, note };
}

export function judgeArticleGenres(input: {
  slug: string;
  products: readonly GenreProduct[];
  policy: ArticleGenrePolicy | null;
  heldUntil: string | null;
}): ArticleGenreFit {
  const { slug, products, policy, heldUntil } = input;
  const distribution = tallyGenres(products);
  const total = products.length;
  const withGenre = distribution.reduce((sum, entry) => sum + entry.count, 0);
  const expected = policy?.expected ?? [];

  const findings: GenreFinding[] = products.map(product => {
    const genreId = normalizeGenreId(product.genreId);
    return {
      rank: product.rank,
      name: product.name,
      genreId,
      // genreId が取れない商品は外れにも分母にも数えない
      isOutlier: genreId !== null && expected.length > 0 && !expected.includes(genreId),
    };
  });

  const outliers = findings.filter(finding => finding.isOutlier).length;
  // 分母は withGenre（genreId が取れた商品数）。total だと未取得商品で率が薄まる
  const outlierRatio = withGenre === 0 ? null : outliers / withGenre;

  const base = {
    slug, expected, total, withGenre, outliers, outlierRatio, distribution, findings, heldUntil,
  };

  if (withGenre === 0) {
    return { ...base, code: 'no-data', proposedExpected: null };
  }
  if (policy === null) {
    return { ...base, code: 'unconfigured', proposedExpected: proposeExpectedGenres(products) };
  }
  if (outliers === 0) {
    return { ...base, code: 'clean', proposedExpected: null };
  }
  if ((outlierRatio as number) <= CONTAMINATION_MAX_RATIO) {
    return { ...base, code: 'contamination', proposedExpected: null };
  }
  return { ...base, code: 'design-review', proposedExpected: null };
}

export function summarizeGenreFit(articles: readonly ArticleGenreFit[]): GenreFitSummary {
  const byCode = Object.fromEntries(GENRE_FIT_CODES.map(code => [code, 0])) as Record<GenreFitCode, number>;
  let products = 0;
  let withGenre = 0;
  let actionable = 0;

  for (const article of articles) {
    byCode[article.code] += 1;
    products += article.total;
    withGenre += article.withGenre;
    if (article.code === 'contamination' && article.heldUntil === null) actionable += 1;
  }

  return { articles: articles.length, products, withGenre, byCode, actionable };
}

/** 凍結表示。releaseDate は「この日から編集してよい日」なので「解除日」とは書かない */
function formatHold(heldUntil: string | null): string {
  if (heldUntil === null) return '着手可';
  if (heldUntil === 'open-ended') return '凍結中（期限なし）';
  return `${heldUntil} 以降に着手可`;
}

function formatRatio(ratio: number | null): string {
  return ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`;
}

function formatSection(
  title: string,
  articles: readonly ArticleGenreFit[],
  renderRow: (article: ArticleGenreFit) => string[]
): string[] {
  const lines = [`## ${title}（${articles.length}件）`, ''];
  if (articles.length === 0) {
    lines.push('該当なし', '');
    return lines;
  }
  for (const article of articles) {
    lines.push(...renderRow(article), '');
  }
  return lines;
}

function formatDistribution(article: ArticleGenreFit): string {
  return article.distribution.map(entry => `${entry.genreId}×${entry.count}`).join(', ') || '—';
}

export function formatGenreFitReport(
  articles: readonly ArticleGenreFit[],
  summary: GenreFitSummary,
  meta: { today: string }
): string {
  const byCode = (code: GenreFitCode) => articles.filter(article => article.code === code);

  const lines: string[] = [
    `# 楽天ジャンル適合レポート（${meta.today}）`,
    '',
    `対象 ${summary.articles} 記事 / ${summary.products} 商品（genreId 取得済み ${summary.withGenre}）`,
    '',
    `- 混入候補 ${summary.byCode.contamination} 件（うち今すぐ着手可 ${summary.actionable} 件）`,
    `- 記事設計の要判断 ${summary.byCode['design-review']} 件 / 適合 ${summary.byCode.clean} 件`,
    `- 期待ジャンル未設定 ${summary.byCode.unconfigured} 件 / genreId 未取得 ${summary.byCode['no-data']} 件`,
    '',
    `外れ率の閾値: ${(CONTAMINATION_MAX_RATIO * 100).toFixed(0)}% 以下を混入候補、超過は記事設計の問題として扱う。`,
    '分母は genreId が取れた商品数（未取得商品は外れにも分母にも数えない）。',
    '',
    '⚠️ 凍結判定は `data/measurement-holds.json` の `holds[]` のみを読む。`prohibitions`（商品追加の禁止）は含めていない。',
    '混入是正は商品構成の変更（CLAUDE.md §5.0.3 区分D）にあたるため、着手前にメモリ `project_measurement_holds` で最終確認すること。',
    '',
  ];

  lines.push(...formatSection('混入候補', byCode('contamination'), article => [
    `### ${article.slug} — ${formatHold(article.heldUntil)}`,
    '',
    `期待 ${article.expected.join(' / ')} ／ 外れ ${article.outliers}/${article.withGenre}（${formatRatio(article.outlierRatio)}）`,
    '',
    ...article.findings
      .filter(finding => finding.isOutlier)
      .map(finding => `- rank ${finding.rank ?? '?'}: ${finding.name}（genreId ${finding.genreId}）`),
  ]));

  lines.push(...formatSection('記事設計の要判断', byCode('design-review'), article => [
    `### ${article.slug} — 外れ ${article.outliers}/${article.withGenre}（${formatRatio(article.outlierRatio)}）`,
    '',
    `期待 ${article.expected.join(' / ')} ／ 分布 ${formatDistribution(article)}`,
  ]));

  lines.push(...formatSection('期待ジャンル未設定（提案のみ・判定なし）', byCode('unconfigured'), article => [
    `- ${article.slug}: 提案 ${article.proposedExpected?.join(' / ') ?? '—'}（分布 ${formatDistribution(article)}）`,
  ]));

  const clean = byCode('clean');
  const noData = byCode('no-data');
  lines.push(
    `## 適合（${clean.length}件）`,
    '',
    clean.length ? clean.map(article => article.slug).join(', ') : '該当なし',
    '',
    `## genreId 未取得（${noData.length}件）`,
    '',
    noData.length ? noData.map(article => article.slug).join(', ') : '該当なし',
    '',
  );

  return lines.join('\n');
}
