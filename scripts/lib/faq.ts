// 記事本文（Markdown）から FAQ の Q/A ペアを抽出する純粋関数。
// inject-faq-frontmatter.mjs と tests/faq.test.ts の両方から import して使う。
// ⚠ Node ESM（--experimental-strip-types）解決のため、import 時は拡張子 .ts を必須にする。

export interface Faq {
  question: string;
  answer: string;
}

// 「## よくある質問（FAQ）」セクションの開始を検出する。
// 全角括弧・半角括弧の揺れと、見出し直後の改行を許容する。
const FAQ_SECTION_RE = /^##\s*よくある質問\s*[（(]\s*FAQ\s*[）)]/m;

// Q/A ペア。**Q. 質問** の次の段落以降を回答とし、
// 次の **Q. か次の ## 見出し、または文末までを回答本文とする。
const QA_PAIR_RE = /\*\*Q\.\s*([\s\S]+?)\*\*\s*\n+([\s\S]+?)(?=\n\s*\*\*Q\.|\n##\s|$)/g;

// 回答本文の先頭にある "A." ラベルと前後の空白を取り除く。
function cleanAnswer(raw: string): string {
  return raw
    .trim()
    .replace(/^A[.．:：]\s*/, "")
    .trim();
}

/**
 * Markdown 本文から FAQ の Q/A ペアを抽出する。
 * - FAQ セクション見出しが無い場合は空配列を返す。
 * - 見出しはあるが Q/A が 1 件も無い場合も空配列を返す（呼び出し側で空配列は書き込まない想定）。
 */
export function extractFaqs(markdown: string): Faq[] {
  const sectionMatch = FAQ_SECTION_RE.exec(markdown);
  if (!sectionMatch) return [];

  // FAQ 見出し以降だけを対象にする（本文中の別箇所の **Q. を拾わないため）。
  const sectionStart = sectionMatch.index;
  // 次の ## 見出し（FAQ 見出し自身は除く）までをセクション範囲とする。
  const afterHeading = markdown.slice(sectionStart + sectionMatch[0].length);
  const nextHeadingRe = /\n##\s/;
  const nextHeading = nextHeadingRe.exec(afterHeading);
  const section = nextHeading
    ? afterHeading.slice(0, nextHeading.index)
    : afterHeading;

  const faqs: Faq[] = [];
  QA_PAIR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QA_PAIR_RE.exec(section)) !== null) {
    const question = match[1].trim();
    const answer = cleanAnswer(match[2]);
    if (question && answer) {
      faqs.push({ question, answer });
    }
  }
  return faqs;
}
