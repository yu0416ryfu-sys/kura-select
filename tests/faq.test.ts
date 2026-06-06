import { describe, it, expect } from "vitest";
import { extractFaqs } from "../scripts/lib/faq.ts";
import { setFaqsInFrontmatter } from "../scripts/lib/frontmatter.ts";

describe("extractFaqs", () => {
  it("FAQ セクションの Q/A ペアを抽出する", () => {
    const md = [
      "## 選び方",
      "",
      "本文。",
      "",
      "## よくある質問（FAQ）",
      "",
      "**Q. シングルとダブル、どっちがお得？**",
      "",
      "A. 1mあたりの価格ではシングルの方が安くなりやすいです。",
      "",
      "**Q. まとめ買いは何ロールがよい？**",
      "",
      "A. 48ロール前後がコスパを出しやすいです。",
      "",
    ].join("\n");

    const faqs = extractFaqs(md);
    expect(faqs).toEqual([
      {
        question: "シングルとダブル、どっちがお得？",
        answer: "1mあたりの価格ではシングルの方が安くなりやすいです。",
      },
      {
        question: "まとめ買いは何ロールがよい？",
        answer: "48ロール前後がコスパを出しやすいです。",
      },
    ]);
  });

  it("FAQ 見出しが無ければ空配列", () => {
    const md = "## 選び方\n\n本文のみ。\n";
    expect(extractFaqs(md)).toEqual([]);
  });

  it("FAQ 見出しがあっても Q/A が無ければ空配列", () => {
    const md = "## よくある質問（FAQ）\n\n準備中です。\n";
    expect(extractFaqs(md)).toEqual([]);
  });

  it("FAQ セクションの後の別見出しの **Q. を巻き込まない", () => {
    const md = [
      "## よくある質問（FAQ）",
      "",
      "**Q. 質問1**",
      "",
      "A. 回答1。",
      "",
      "## まとめ",
      "",
      "**Q. これは拾わない**",
      "",
      "本文。",
      "",
    ].join("\n");

    const faqs = extractFaqs(md);
    expect(faqs).toEqual([{ question: "質問1", answer: "回答1。" }]);
  });

  it("半角括弧 (FAQ) でも検出する", () => {
    const md = "## よくある質問(FAQ)\n\n**Q. 質問**\n\nA. 回答。\n";
    expect(extractFaqs(md)).toEqual([{ question: "質問", answer: "回答。" }]);
  });
});

describe("setFaqsInFrontmatter", () => {
  const base = [
    "---",
    'title: "テスト記事"',
    "articleType: comparison",
    "---",
    "",
    "本文。",
    "",
  ].join("\n");

  it("faqs を frontmatter に追記する", () => {
    const { content, changed } = setFaqsInFrontmatter(base, [
      { question: "Q1", answer: "A1" },
    ]);
    expect(changed).toBe(true);
    expect(content).toContain("faqs:");
    expect(content).toContain("Q1");
    expect(content).toContain("A1");
    expect(content).toContain("本文。");
  });

  it("空配列では何もしない", () => {
    const { content, changed } = setFaqsInFrontmatter(base, []);
    expect(changed).toBe(false);
    expect(content).toBe(base);
  });

  it("同一内容なら changed=false", () => {
    const { content: once } = setFaqsInFrontmatter(base, [
      { question: "Q1", answer: "A1" },
    ]);
    const { changed } = setFaqsInFrontmatter(once, [
      { question: "Q1", answer: "A1" },
    ]);
    expect(changed).toBe(false);
  });
});
