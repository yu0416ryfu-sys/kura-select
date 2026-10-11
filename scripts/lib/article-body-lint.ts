// 記事本文・FAQ の「更新で壊れる手書き数値・商品構成への言及」を検出する純粋関数群。
// 数値の真実は frontmatter products[] の 1 か所だけ。本文（Markdown）と faqs[].answer には
// 価格・単価・レビュー件数・順位などの「更新で変わる数値」を書かない、という単一ソース原則を
// 自動ガードするための lint。tests/ から import して全記事を走査する。
//
// ⚠ Node ESM（--experimental-strip-types で実行）解決のため相対 import は拡張子 .ts を必須にする。
import { parseFrontmatter } from './frontmatter.ts';

// 違反の種別。
export type LintKind =
  | 'unit-price' // 単価表記（円/mL 等）
  | 'price' // 税込価格水準（3 桁以上 + 円）
  | 'price-table' // 価格を含む Markdown テーブル行
  | 'table-composition' // 比較表の構成・順位に依存する表現（「比較表の上位に」「比較表の商品の例」等）
  | 'product-name'; // 掲載商品名（products[].name の先頭2語）の本文への直書き

export type LintArea = 'body' | 'faq';

// error: ビルド前に落とす（assert 失敗）。warn: 可視化のみ（誤検知が多いパターンの段階導入用）。
export type LintSeverity = 'error' | 'warn';

export interface LintViolation {
  line: number | null; // body は 1-origin のファイル行。faq は YAML パースで行が失われるため null。
  kind: LintKind;
  area: LintArea;
  severity: LintSeverity;
  snippet: string;
}

export interface LintOptions {
  // 税込価格パターン（price）を error に昇格するか。既定 false（warn）。
  // 段階導入: まず warn で全件可視化 → 誤検知を許可コメント/ホワイトリストで潰す → 安定後に true。
  priceAsError?: boolean;
  // 掲載商品名の直書き（product-name）を検査するか。既定 true。
  // vs 記事は2商品の比較そのものが本文なので、呼び出し側で false にする。
  checkProductNames?: boolean;
}

// 単価表記: 「円/mL」「円 / g」など。商品単価の劣化コピーになりやすい高シグナル。
const UNIT_PRICE_RE = /円\s*[/／]\s*(?:mL|ml|g|kg|L|枚|個|本|回|組|包|錠|袋|巻|粒|日)/;

// 価格表記: 数値 + 円。桁数を問わず拾う（例 2,880円 / 31円 / 12.9円 / 5円）。
// 桁数下限を外したのは 2026-09-04 の実測で 2 桁・小数の手書き単価を取りこぼしていたため
// （room-dry-detergent の 12.9円 / 31円、bathroom-cleaner の 1回5円）。
// 「円錐」「円形」等は直前に数字が要る条件で排除される。既定の severity は warn のまま。
const PRICE_RE = /[0-9０-９][0-9０-９,，]*(?:[.．][0-9０-９]+)?\s*円/;

// 価格を含む Markdown テーブル行（パイプ行）。手書き価格表の本体。
// 「円錐」など価格でない「円」を含む語の誤検知を避けるため、価格らしい円
// （数字+円 / 円+単位スラッシュ）を含む行に限定する。
const TABLE_PRICE_RE = /^\s*\|.*(?:[0-9０-９]\s*円|円\s*[/／]).*\|/;

// 比較表の構成・順位に依存する表現。比較表は update-products や AI 照合で商品が入れ替わるため、
// 「比較表の上位に並ぶ」「現在の比較表には」「上部の3商品」のような記述はすぐ嘘になる。
// 2026-10-11 実測で全記事 5 件・すべて真陽性。
const TABLE_COMPOSITION_RE =
  /比較表の(?:商品の例|[上下]位|前半|後半|最下位|[0-9０-９]+(?:商品|選))|(?:現在|いま)の比較表|比較表は(?:いま|現在)|上部の[0-9０-９]+(?:商品|選)|[上下]位に(?:ある|並ぶ|入っている)/;

// 許可コメント: 行末に置けばその行をスキップ（景表法上の出典明記など正当な数値用）。
const ALLOW_COMMENT_RE = /<!--\s*lint-allow-number\s*-->/;

// 一般目安ホワイトリスト（特定商品非依存・更新で壊れない定型）。最小限に保つ。
// これらにのみマッチし、かつ円表記を伴わない行は除外する。
const GENERAL_GUIDE_RES: RegExp[] = [
  /\d+\s*[〜~]\s*\d+\s*%/, // 30〜50%
  /約\d+\s*年/, // 約3年
  /99\.9\s*%/, // 99.9%
];

// 円・単価を含まず一般目安のみの行か（割合・年数など）。
function isGeneralGuideOnly(line: string): boolean {
  if (/円/.test(line)) return false;
  return GENERAL_GUIDE_RES.some((re) => re.test(line));
}

// frontmatter を除いた本文の開始行（0-origin の配列 index）を返す。
function findBodyStartIndex(lines: string[]): number {
  if (lines.length === 0 || lines[0].replace(/\r$/, '') !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') return i + 1;
  }
  return 0; // 閉じ --- が無ければ全体を本文扱い（壊れた frontmatter）
}

// 本文 1 行を検査して違反を返す（無ければ null）。
function lintBodyLine(raw: string, lineNo: number, priceAsError: boolean): LintViolation | null {
  const line = raw.replace(/\r$/, '');
  if (ALLOW_COMMENT_RE.test(line)) return null;
  if (isGeneralGuideOnly(line)) return null;

  if (TABLE_PRICE_RE.test(line)) {
    return { line: lineNo, kind: 'price-table', area: 'body', severity: 'error', snippet: line.trim().slice(0, 120) };
  }
  if (UNIT_PRICE_RE.test(line)) {
    return { line: lineNo, kind: 'unit-price', area: 'body', severity: 'error', snippet: line.trim().slice(0, 120) };
  }
  if (TABLE_COMPOSITION_RE.test(line)) {
    return { line: lineNo, kind: 'table-composition', area: 'body', severity: 'error', snippet: line.trim().slice(0, 120) };
  }
  if (PRICE_RE.test(line)) {
    return {
      line: lineNo,
      kind: 'price',
      area: 'body',
      severity: priceAsError ? 'error' : 'warn',
      snippet: line.trim().slice(0, 120),
    };
  }
  return null;
}

// products[].name から本文照合用のキー（先頭2語）を作る。「シック ハイドロ5 カスタム 替刃」→「シック ハイドロ5」。
// 1語だけ・短すぎるキーはブランド名単体の一般的な言及（「エリエールは…」）と区別できないので使わない。
export function productNameKeys(products: unknown): string[] {
  if (!Array.isArray(products)) return [];
  const keys = new Set<string>();
  for (const p of products) {
    const name = (p as { name?: unknown })?.name;
    if (typeof name !== 'string') continue;
    const tokens = name.trim().split(/[\s　]+/);
    if (tokens.length >= 2 && tokens[0].length + tokens[1].length >= 4) keys.add(`${tokens[0]} ${tokens[1]}`);
  }
  return [...keys];
}

// faqs[].answer 文字列を検査する（行番号は YAML パースで失われるため null）。
function lintFaqAnswer(answer: string, priceAsError: boolean): LintViolation[] {
  const out: LintViolation[] = [];
  const snippet = answer.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (UNIT_PRICE_RE.test(answer)) {
    out.push({ line: null, kind: 'unit-price', area: 'faq', severity: 'error', snippet });
  } else if (PRICE_RE.test(answer) && !isGeneralGuideOnly(answer)) {
    // unit-price を優先（同一 answer で二重計上しない）。
    out.push({ line: null, kind: 'price', area: 'faq', severity: priceAsError ? 'error' : 'warn', snippet });
  }
  return out;
}

// 記事ファイル全体の文字列を受け取り、本文 + faqs[].answer の手書き数値違反を返す。
export function lintArticleBody(content: string, options: LintOptions = {}): LintViolation[] {
  const priceAsError = options.priceAsError ?? false;
  const violations: LintViolation[] = [];

  // 1) 本文（frontmatter を除く）を行単位で走査。
  const lines = content.split('\n');
  const bodyStart = findBodyStartIndex(lines);
  const parsed = parseFrontmatter(content);
  const nameKeys = (options.checkProductNames ?? true) ? productNameKeys(parsed?.data?.products) : [];
  for (let i = bodyStart; i < lines.length; i++) {
    const v = lintBodyLine(lines[i], i + 1, priceAsError);
    if (v) {
      violations.push(v);
      continue;
    }
    // 掲載商品名の直書きは warn（2026-10-11 時点で 22 記事・69 行。表の行や #product-N アンカーなど
    // 正当な用途もあるため段階導入。新しく書く本文では商品名ではなく「商品名の目印」で説明する）。
    const line = lines[i].replace(/\r$/, '');
    const key = nameKeys.find((k) => line.includes(k));
    if (key) {
      violations.push({ line: i + 1, kind: 'product-name', area: 'body', severity: 'warn', snippet: `[${key}] ${line.trim().slice(0, 100)}` });
    }
  }

  // 2) frontmatter の faqs[].answer のみを走査（products[] 等の他フィールドは対象外）。
  const faqs = parsed?.data?.faqs;
  if (Array.isArray(faqs)) {
    for (const faq of faqs) {
      const answer = (faq as { answer?: unknown })?.answer;
      if (typeof answer === 'string') {
        violations.push(...lintFaqAnswer(answer, priceAsError));
      }
    }
  }

  return violations;
}

// error レベルのみ抽出（統合テストの assert 用）。
export function getErrorViolations(violations: LintViolation[]): LintViolation[] {
  return violations.filter((v) => v.severity === 'error');
}
