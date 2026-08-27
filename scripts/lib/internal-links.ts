/**
 * 記事間の内部リンクをビルド成果物から数える。
 *
 * 低順位記事の底上げ Phase 2（`docs/IMPLEMENTATION_PLAN_LOW_RANK_ARTICLE_LIFT_2026-08-23.md` §5）。
 *
 * **リンク生成ロジックを再現しない。** v1（本文リンクのみ）と v2（fallback 除外）は
 * どちらも再現しようとして過小評価した（実測で「孤立」が 62本/54%）。
 * v4 以降は `pnpm build` 後の dist/articles 配下の index.html を数える。
 *
 * 本文リンクと自動関連リンクの判別は **「最初の `<aside>` より前＝本文、以降＝自動関連」**。
 * `<article>` は境界にならない（実測で1記事ページに11個ある。`<aside>` は1個）。
 */

/** `href="/articles/"` ちょうどは header の nav 由来なので数えない（実測で1ページ2件） */
const ARTICLES_INDEX_HREF = '/articles/';

export interface PageLinks {
  /** リンク元ページの slug */
  slug: string;
  /** 本文（最初の <aside> より前）から出ている記事リンクの slug */
  body: string[];
  /** 自動関連（最初の <aside> 以降）から出ている記事リンクの slug */
  auto: string[];
  /** このページに <aside> があったか。無い場合は全体を本文として数える */
  hasAside: boolean;
}

/** `/articles/foo-comparison/` → `foo-comparison`。記事一覧・別セクションは null */
export function hrefToSlug(href: string): string | null {
  if (!href.startsWith(ARTICLES_INDEX_HREF)) return null;
  const rest = href.slice(ARTICLES_INDEX_HREF.length).split(/[?#]/)[0];
  const trimmed = rest.replace(/\/+$/, '');
  if (!trimmed) return null; // href="/articles/" ちょうど
  return trimmed;
}

function collectSlugs(html: string): string[] {
  const slugs: string[] = [];
  for (const match of html.matchAll(/href="(\/articles\/[^"]*)"/g)) {
    const slug = hrefToSlug(match[1]);
    if (slug) slugs.push(slug);
  }
  return slugs;
}

/**
 * 1ページの HTML から出リンクを取り出す。
 * 自分自身へのリンクは数えない（被リンクの水増しになるため）。
 */
export function extractPageLinks(slug: string, html: string): PageLinks {
  const asideAt = html.indexOf('<aside');
  const hasAside = asideAt !== -1;
  const bodyHtml = hasAside ? html.slice(0, asideAt) : html;
  const autoHtml = hasAside ? html.slice(asideAt) : '';

  const notSelf = (target: string) => target !== slug;
  return {
    slug,
    body: collectSlugs(bodyHtml).filter(notSelf),
    auto: collectSlugs(autoHtml).filter(notSelf),
    hasAside,
  };
}

export interface LinkStats {
  slug: string;
  /** 本文から張られた被リンク数（重複リンク元は1と数える） */
  inboundBody: number;
  /** 自動関連から張られた被リンク数 */
  inboundAuto: number;
  /** 本文から出ている記事リンク数 */
  outboundBody: number;
  outboundAuto: number;
  inboundBodyFrom: string[];
  /** 優先順位。1=孤立 / 2=本文被リンクなし / 3=出リンクなし / null=問題なし */
  priority: 1 | 2 | 3 | null;
  /** comparison 記事か（reviews / ガイド記事と分けて数えるため） */
  isComparison: boolean;
}

export interface LinkGraph {
  pages: PageLinks[];
  stats: LinkStats[];
}

export function isComparisonSlug(slug: string): boolean {
  return slug.endsWith('-comparison');
}

/** 被リンクは「リンク元ページ数」で数える。同じページから2本張られても1と数える */
export function buildLinkGraph(pages: readonly PageLinks[]): LinkGraph {
  const inboundBody = new Map<string, Set<string>>();
  const inboundAuto = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, target: string, source: string) => {
    const set = map.get(target) ?? new Set<string>();
    set.add(source);
    map.set(target, set);
  };

  for (const page of pages) {
    for (const target of new Set(page.body)) add(inboundBody, target, page.slug);
    for (const target of new Set(page.auto)) add(inboundAuto, target, page.slug);
  }

  const stats = pages.map(page => {
    const bodyFrom = [...(inboundBody.get(page.slug) ?? [])].sort();
    const autoCount = (inboundAuto.get(page.slug) ?? new Set()).size;
    const outboundBody = new Set(page.body).size;
    let priority: 1 | 2 | 3 | null = null;
    if (bodyFrom.length === 0 && autoCount === 0) priority = 1;
    else if (bodyFrom.length === 0) priority = 2;
    else if (outboundBody === 0) priority = 3;

    return {
      slug: page.slug,
      inboundBody: bodyFrom.length,
      inboundAuto: autoCount,
      outboundBody,
      outboundAuto: new Set(page.auto).size,
      inboundBodyFrom: bodyFrom,
      priority,
      isComparison: isComparisonSlug(page.slug),
    };
  });

  stats.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || a.inboundBody - b.inboundBody || (a.slug < b.slug ? -1 : 1));
  return { pages: [...pages], stats };
}

export interface LinkSummary {
  pages: number;
  comparisonPages: number;
  /** 本文リンクの総数（延べ） */
  bodyLinks: number;
  autoLinks: number;
  /** comparison 記事のうち priority 別の本数 */
  isolated: number;
  noInboundBody: number;
  noOutboundBody: number;
  /** 孤立率（comparison 記事に対する割合）。20% 超なら分類をやり直す（§5.4） */
  isolatedRate: number;
  pagesWithoutAside: string[];
}

export function summarizeLinks(graph: LinkGraph): LinkSummary {
  const comparison = graph.stats.filter(s => s.isComparison);
  const isolated = comparison.filter(s => s.priority === 1).length;
  return {
    pages: graph.stats.length,
    comparisonPages: comparison.length,
    bodyLinks: graph.pages.reduce((sum, p) => sum + p.body.length, 0),
    autoLinks: graph.pages.reduce((sum, p) => sum + p.auto.length, 0),
    isolated,
    noInboundBody: comparison.filter(s => s.priority === 2).length,
    noOutboundBody: comparison.filter(s => s.priority === 3).length,
    isolatedRate: comparison.length ? isolated / comparison.length : 0,
    pagesWithoutAside: graph.pages.filter(p => !p.hasAside).map(p => p.slug),
  };
}

/** 凍結台帳。`data/measurement-holds.json` が未整備の間は空で動かす */
export interface HoldsLookup {
  /** 凍結中の slug。リンクを足す「元」にできない */
  frozenSlugs: Set<string>;
  /** 台帳ファイルが存在したか。false ならレポートに「凍結判定なし」と明記する */
  available: boolean;
}

export interface LinkSuggestion {
  /** リンクを増やしたい記事 */
  target: string;
  /** 推奨するリンク元（同一カテゴリ・凍結対象外） */
  sources: string[];
  /** 同一カテゴリに凍結対象外の記事が無い場合の理由 */
  note: string | null;
}

/** リンク追加候補を絞るための記事メタ（frontmatter 由来） */
export interface ArticleMeta {
  category: string | null;
  tags: string[];
}

/**
 * 主題を区別しない汎用タグを見つける。
 * 全記事の `genericTagRatio` を超える割合に付いているタグは候補の絞り込みに使わない。
 */
export function findGenericTags(
  metaBySlug: Map<string, ArticleMeta>,
  ratio: number
): Set<string> {
  const total = metaBySlug.size;
  if (total === 0) return new Set();
  const freq = new Map<string, number>();
  for (const meta of metaBySlug.values()) {
    for (const tag of new Set(meta.tags)) freq.set(tag, (freq.get(tag) ?? 0) + 1);
  }
  return new Set([...freq.entries()].filter(([, count]) => count / total > ratio).map(([tag]) => tag));
}

/**
 * リンク追加候補を出す。リンク元の本文を編集するので、
 * **リンク元が凍結中なら候補にしない**（リンク先の凍結状態は問わない・§5.5）。
 *
 * 絞り込みは **同一カテゴリ → タグ重複が多い順** の2段。
 * KuraSelect はカテゴリが細かく、**孤立記事の多くはカテゴリに1本しかない**ため、
 * カテゴリだけでは候補が出ない（実測: 26件中25件が「同一カテゴリに他の記事が無い」）。
 *
 * タグは **出現頻度が高いものを無視する**。実測のタグ分布は
 * `まとめ買い` 50記事 / `コスパ` 39 / `日用品` 30 / `節約` 26 に対し、
 * 次点は6記事で、上位4つは主題を区別しない汎用タグ。これを混ぜると
 * 「猫砂 ← ニキビパッチ」のような無関係な候補が上位に来る。
 */
export function suggestLinkSources(
  stats: readonly LinkStats[],
  metaBySlug: Map<string, ArticleMeta>,
  holds: HoldsLookup,
  { maxSources = 3, genericTagRatio = 0.1 }: { maxSources?: number; genericTagRatio?: number } = {}
): LinkSuggestion[] {
  const targets = stats.filter(s => s.isComparison && (s.priority === 1 || s.priority === 2));
  const candidates = stats.filter(s => s.isComparison);
  const genericTags = findGenericTags(metaBySlug, genericTagRatio);

  return targets.map(target => {
    const meta = metaBySlug.get(target.slug);
    const usable = (slug: string) => !holds.frozenSlugs.has(slug) && !target.inboundBodyFrom.includes(slug);
    const others = candidates.filter(s => s.slug !== target.slug);

    // category が未解決のときに undefined === undefined で全記事が同一カテゴリ扱いに
    // なるのを防ぐため、カテゴリが引けないときは同一カテゴリ判定をしない
    const sameCategory = meta?.category
      ? others.filter(s => metaBySlug.get(s.slug)?.category === meta.category).map(s => s.slug)
      : [];

    const targetTags = new Set((meta?.tags ?? []).filter(tag => !genericTags.has(tag)));
    const byTagOverlap = targetTags.size === 0 ? [] : others
      .map(s => ({
        slug: s.slug,
        overlap: (metaBySlug.get(s.slug)?.tags ?? []).filter(tag => targetTags.has(tag)).length,
      }))
      .filter(row => row.overlap > 0)
      // 重複が多い順。同数なら被リンクが多い記事＝ハブ側から張るほうが自然
      .sort((a, b) => b.overlap - a.overlap || (a.slug < b.slug ? -1 : 1))
      .map(row => row.slug);

    const ordered = [...sameCategory.filter(usable), ...byTagOverlap.filter(usable)];
    const sources = [...new Set(ordered)].slice(0, maxSources);

    let note: string | null = null;
    if (!meta) note = '記事メタが引けない';
    else if (sources.length === 0) {
      if (sameCategory.length === 0 && byTagOverlap.length === 0) note = '同一カテゴリ・固有タグ重複の記事が無い';
      else note = '候補がすべて凍結中またはリンク済み';
    } else if (sameCategory.filter(usable).length === 0) {
      note = `同一カテゴリ（${meta.category ?? '不明'}）に候補が無いため固有タグの重複で選出`;
    }

    return { target: target.slug, sources, note };
  });
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function formatLinkReport(
  graph: LinkGraph,
  summary: LinkSummary,
  suggestions: readonly LinkSuggestion[],
  holds: HoldsLookup,
  { today, builtAt }: { today: string; builtAt: string }
): string {
  const lines: string[] = [];
  lines.push(`# 内部リンクグラフ（${today}）`);
  lines.push('');
  lines.push(`- 集計対象: \`dist/articles/**/index.html\` **${summary.pages}ページ**（うち comparison ${summary.comparisonPages}本）`);
  lines.push(`- **dist のビルド時刻: ${builtAt}**`);
  lines.push(`- 本文リンク ${summary.bodyLinks} 本 / 自動関連リンク ${summary.autoLinks} 本`);
  lines.push('');
  lines.push('> 本文と自動関連の判別は「最初の `<aside>` より前＝本文、以降＝自動関連」。');
  lines.push('> `href="/articles/"` ちょうど（header の nav 由来）と自己リンクは数えない。');
  lines.push('> 被リンクは**リンク元ページ数**で数える（同じページから2本張られても1）。');
  if (!holds.available) {
    lines.push('>');
    lines.push('> ⚠️ **`data/measurement-holds.json` が無いため凍結判定をしていない。**');
    lines.push('> リンク追加候補の「リンク元」に凍結中の記事が混ざりうる。');
    lines.push('> 実際に足す前にメモリ `project_measurement_holds` を必ず開くこと。');
  }
  lines.push('');

  lines.push('## サマリ（comparison 記事）');
  lines.push('');
  lines.push('| 優先 | 状態 | 本数 |');
  lines.push('|---|---|---:|');
  lines.push(`| 1 | **孤立**（本文も自動関連も被リンク0） | ${summary.isolated}（${pct(summary.isolatedRate)}） |`);
  lines.push(`| 2 | 本文被リンクなし（自動関連のみ） | ${summary.noInboundBody} |`);
  lines.push(`| 3 | 出リンクなし（本文から他記事へ張っていない） | ${summary.noOutboundBody} |`);
  lines.push('');
  if (summary.isolatedRate > 0.2) {
    lines.push('⚠️ **孤立が 20% を超えている。** §5.4 の受け入れ確認により、指標がトリアージとして');
    lines.push('機能していない可能性が高い。リンクを足す前に分類方法を見直すこと。');
    lines.push('');
  }
  if (summary.pagesWithoutAside.length > 0) {
    lines.push(`> \`<aside>\` が無いページ ${summary.pagesWithoutAside.length} 件は全体を本文として数えた: ${summary.pagesWithoutAside.join(', ')}`);
    lines.push('');
  }

  for (const [priority, title] of [[1, '孤立（最優先）'], [2, '本文被リンクなし'], [3, '出リンクなし']] as const) {
    const rows = graph.stats.filter(s => s.isComparison && s.priority === priority);
    lines.push(`## 優先${priority}: ${title}（${rows.length}本）`);
    lines.push('');
    if (rows.length === 0) {
      lines.push('なし。');
    } else {
      lines.push('| slug | 本文被リンク | 自動関連被リンク | 本文出リンク |');
      lines.push('|---|---:|---:|---:|');
      for (const row of rows) {
        lines.push(`| ${row.slug} | ${row.inboundBody} | ${row.inboundAuto} | ${row.outboundBody} |`);
      }
    }
    lines.push('');
  }

  lines.push(`## リンク追加候補（${suggestions.length}件）`);
  lines.push('');
  lines.push('リンク元の**本文を編集する**ので、リンク元が凍結中なら実施できない（リンク先の凍結状態は問わない）。');
  lines.push('絞り込みは「同一カテゴリ → 固有タグの重複が多い順」。`まとめ買い` / `コスパ` / `日用品` / `節約` のように');
  lines.push('多数の記事に付いている汎用タグは、主題を区別しないので使わない。');
  lines.push('');
  lines.push('> **候補が出ない行が多いのはタグ設計の問題**。タグ340種のうち310種が1記事にしか付いておらず、');
  lines.push('> カテゴリも1記事しか持たないものが多い。候補が出ない記事は手でリンク元を選ぶこと。');
  lines.push('');
  lines.push('| リンク先（増やしたい記事） | 推奨リンク元（同一カテゴリ・凍結対象外） |');
  lines.push('|---|---|');
  for (const suggestion of suggestions) {
    const sources = suggestion.sources.length > 0
      ? suggestion.sources.join(' / ') + (suggestion.note ? `（${suggestion.note}）` : '')
      : `— ${suggestion.note ?? '候補なし'}`;
    lines.push(`| ${suggestion.target} | ${sources} |`);
  }
  lines.push('');

  return lines.join('\n') + '\n';
}
