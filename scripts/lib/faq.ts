// 記事本文（Markdown）から FAQ の Q/A ペアを抽出する純粋関数。
// inject-faq-frontmatter.mjs と tests/faq.test.ts の両方から import して使う。
// ⚠ Node ESM（--experimental-strip-types）解決のため、import 時は拡張子 .ts を必須にする。

export interface Faq {
  question: string;
  answer: string;
}

// 「## よくある質問（FAQ）」セクションの開始を検出する。
// 全角括弧・半角括弧の揺れ、（FAQ）注記の有無、見出し直後の改行を許容する。
const FAQ_SECTION_RE = /^##\s*よくある質問(?:\s*[（(]\s*FAQ\s*[）)])?/m;

// 新書式の Q/A ペア。**Q. 質問**（区切りは . / : / ．/ ：の揺れを許容）の
// 次の段落以降を回答とし、次の **Q か次の ## 見出し、または文末までを回答本文とする。
const QA_PAIR_RE = /\*\*Q[.:．：]\s*([\s\S]+?)\*\*\s*\n+([\s\S]+?)(?=\n\s*\*\*Q[.:．：]|\n##\s|$)/g;

// 旧書式の Q/A ペア。### 質問 見出し + 直後段落を回答とし、
// 次の ### か次の ## 見出し、または文末までを回答本文とする。
const OLD_QA_PAIR_RE = /^###\s+([^\n]+?)\s*\n+([\s\S]+?)(?=\n###\s|\n##\s|$)/gm;

// 太字のみ書式の Q/A ペア。Q ラベルが無く **質問？** の太字行（疑問符で終わる）+
// 直後段落を回答とする。誤検出を避けるため質問は ？/? 終端のものだけを対象にする。
const BOLD_Q_PAIR_RE = /^\*\*([^\n*]+[？?])\*\*\s*\n+([\s\S]+?)(?=\n\s*\*\*|\n##\s|$)/gm;

// 回答本文の先頭にある "A." ラベル（旧書式 "A." / 新書式 "**A.**" の両方）と
// 前後の空白を取り除く。旧書式の回答は "A." ラベルを持たないため、
// "A" の直後が区切り記号（.．:：）でない場合は削らない（先頭文字の誤除去防止）。
function cleanAnswer(raw: string): string {
  return raw
    .trim()
    .replace(/^\*{0,2}A[.．:：]\*{0,2}\s*/, "")
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

  // 書式ごとに優先順位で抽出する（1 セクション内で書式が混在する想定はない）。
  // 新書式（**Q. 質問**）→ 旧書式（### 質問）→ 太字のみ（**質問？**）の順。
  for (const re of [QA_PAIR_RE, OLD_QA_PAIR_RE, BOLD_Q_PAIR_RE]) {
    const faqs = collectPairs(section, re);
    if (faqs.length > 0) return faqs;
  }
  return [];
}

// 指定の正規表現で FAQ セクションから Q/A ペアを収集する。
function collectPairs(section: string, re: RegExp): Faq[] {
  const faqs: Faq[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(section)) !== null) {
    const question = match[1].trim();
    const answer = cleanAnswer(match[2]);
    if (question && answer) {
      faqs.push({ question, answer });
    }
  }
  return faqs;
}
