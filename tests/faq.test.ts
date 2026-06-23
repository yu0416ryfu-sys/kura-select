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

  it("（FAQ）注記が無い見出し（## よくある質問）でも検出する", () => {
    const md = [
      "## よくある質問",
      "",
      "### 無洗米は洗わなくていい？",
      "基本的には洗米せずに炊けます。",
      "",
      "## まとめ",
      "",
    ].join("\n");
    expect(extractFaqs(md)).toEqual([
      { question: "無洗米は洗わなくていい？", answer: "基本的には洗米せずに炊けます。" },
    ]);
  });

  it("新書式の **A.** 接頭辞を除去する", () => {
    const md = [
      "## よくある質問（FAQ）",
      "",
      "**Q. 予洗いは必要？**",
      "",
      "**A.** 強い洗剤なら予洗いなしでも落ちます。",
      "",
    ].join("\n");
    expect(extractFaqs(md)).toEqual([
      { question: "予洗いは必要？", answer: "強い洗剤なら予洗いなしでも落ちます。" },
    ]);
  });

  it("旧書式（### 質問 + 回答段落）を抽出する", () => {
    const md = [
      "## よくある質問（FAQ）",
      "",
      "### 新生児から使える？",
      "紹介する3商品すべて新生児から使用可能です。",
      "",
      "### 大容量パックはどのくらい保つ？",
      "平均的な家庭で1〜2ヶ月持つ目安です。",
      "",
      "## まとめ",
      "",
      "本文。",
      "",
    ].join("\n");
    expect(extractFaqs(md)).toEqual([
      { question: "新生児から使える？", answer: "紹介する3商品すべて新生児から使用可能です。" },
      { question: "大容量パックはどのくらい保つ？", answer: "平均的な家庭で1〜2ヶ月持つ目安です。" },
    ]);
  });

  it("**Q: 質問** コロン区切り + A: 回答 を抽出する", () => {
    const md = [
      "## よくある質問（FAQ）",
      "",
      "**Q: 交換頻度は？**",
      "A: 1〜3ヶ月が目安です。",
      "",
    ].join("\n");
    expect(extractFaqs(md)).toEqual([
      { question: "交換頻度は？", answer: "1〜3ヶ月が目安です。" },
    ]);
  });

  it("太字のみ書式（**質問？** + 回答段落）を抽出する", () => {
    const md = [
      "## よくある質問（FAQ）",
      "",
      "**洗濯ネットはいつ交換すべきですか？**",
      "ファスナーが壊れたら交換のタイミングです。",
      "",
      "**ドラム式でも使えますか？**",
      "ほとんどの製品は対応しています。",
      "",
    ].join("\n");
    expect(extractFaqs(md)).toEqual([
      { question: "洗濯ネットはいつ交換すべきですか？", answer: "ファスナーが壊れたら交換のタイミングです。" },
      { question: "ドラム式でも使えますか？", answer: "ほとんどの製品は対応しています。" },
    ]);
  });

  it("旧書式の回答先頭が 'A' で始まっても誤って削らない", () => {
    const md = [
      "## よくある質問（FAQ）",
      "",
      "### Amazonでも買える？",
      "Amazonでも購入できますが、本記事では楽天価格を掲載しています。",
      "",
    ].join("\n");
    expect(extractFaqs(md)).toEqual([
      {
        question: "Amazonでも買える？",
        answer: "Amazonでも購入できますが、本記事では楽天価格を掲載しています。",
      },
    ]);
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
