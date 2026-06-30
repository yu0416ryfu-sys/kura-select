// 記事本文・FAQ の「更新で壊れる手書き数値」を検出する純粋関数群。
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
  | 'price-table'; // 価格を含む Markdown テーブル行

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
}

// 単価表記: 「円/mL」「円 / g」など。商品単価の劣化コピーになりやすい高シグナル。
const UNIT_PRICE_RE = /円\s*[/／]\s*(?:mL|ml|g|kg|L|枚|個|本|回|組|包|錠|袋|巻|粒|日)/;

// 税込価格: 3 桁以上の数値 + 円（例 2,880円）。一般記述（送料無料の閾値等）の誤検知が出やすく既定 warn。
const PRICE_RE = /[0-9０-９][0-9０-９,，]{2,}\s*円/;

// 価格を含む Markdown テーブル行（パイプ行）。手書き価格表の本体。
// 「円錐」など価格でない「円」を含む語の誤検知を避けるため、価格らしい円
// （数字+円 / 円+単位スラッシュ）を含む行に限定する。
const TABLE_PRICE_RE = /^\s*\|.*(?:[0-9０-９]\s*円|円\s*[/／]).*\|/;

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
  for (let i = bodyStart; i < lines.length; i++) {
    const v = lintBodyLine(lines[i], i + 1, priceAsError);
    if (v) violations.push(v);
  }

  // 2) frontmatter の faqs[].answer のみを走査（products[] 等の他フィールドは対象外）。
  const parsed = parseFrontmatter(content);
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
