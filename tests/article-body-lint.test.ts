import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, basename, join } from "node:path";
import {
  lintArticleBody,
  getErrorViolations,
  productNameKeys,
} from "../scripts/lib/article-body-lint";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTICLES_DIR = join(__dirname, "../src/content/articles");

// frontmatter + body をまとめた記事フィクスチャを組み立てる。
function article(body: string, frontmatterExtra = ""): string {
  return `---
title: "テスト記事"
description: "テスト用"
category: test
publishedAt: 2026-06-30
products:
  - rank: 1
    name: "商品A 1000mL"
    price: 1280
    pricePerUnit: "約1.28円/mL"
${frontmatterExtra}---

${body}
`;
}

describe("lintArticleBody（ユニット）", () => {
  it("単価表記（円/mL）を error として検出する", () => {
    const v = lintArticleBody(article("緑の魔女は約0.64円/mLでコスパ良好です。"));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "unit-price", area: "body", severity: "error" });
    expect(v[0].line).toBeGreaterThan(0);
  });

  it("手書き価格表（パイプ行）を error として検出する", () => {
    const body = [
      "| 商品 | 価格 | 単価 |",
      "|---|---|---|",
      "| 緑の魔女 5L | 3,180円 | 約0.64円 |",
    ].join("\n");
    const v = lintArticleBody(article(body));
    const tableRows = v.filter((x) => x.kind === "price-table");
    expect(tableRows.length).toBeGreaterThanOrEqual(1);
    expect(tableRows.every((x) => x.severity === "error")).toBe(true);
  });

  it("価格表記（桁数を問わず）は既定 warn、priceAsError で error", () => {
    const body = "この洗剤はおよそ2,680円で購入できます。";
    expect(lintArticleBody(article(body))[0]).toMatchObject({ kind: "price", severity: "warn" });
    expect(lintArticleBody(article(body), { priceAsError: true })[0]).toMatchObject({
      kind: "price",
      severity: "error",
    });
  });

  // 2026-09-04 の定型H2 是正で取りこぼした実例に対応（room-dry-detergent / bathroom-cleaner）。
  it.each([
    ["小数価格", "1mLあたり12.9円で計算すると割安です。"],
    ["2桁価格", "1回あたり31円ほどかかります。"],
    ["1桁価格", "1回5円で使えます。"],
  ])("%s も price/warn として検出する", (_label, body) => {
    const v = lintArticleBody(article(body));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "price", area: "body", severity: "warn" });
    expect(lintArticleBody(article(body), { priceAsError: true })[0]).toMatchObject({
      severity: "error",
    });
  });

  it.each([
    ["円錐（数字が直前にない）", "円錐形のフィルターを選びます。"],
    ["半径の円（間に助詞が入る）", "半径3の円で囲みます。"],
    ["許可コメント付き", "1回5円で使えます。<!-- lint-allow-number -->"],
  ])("%s は検出しない", (_label, body) => {
    expect(lintArticleBody(article(body))).toHaveLength(0);
  });

  it("単価表記は price と二重計上されない（unit-price を優先）", () => {
    const v = lintArticleBody(article("詰め替えは約0.72円/mLです。"));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "unit-price", severity: "error" });
  });

  it("faqs[].answer の 2 桁価格も area:'faq' で検出する", () => {
    const faqs = `faqs:
  - question: "1回いくら？"
    answer: "1回あたり31円ほどです。"
`;
    const v = lintArticleBody(article("選び方の解説。", faqs));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "price", area: "faq", severity: "warn", line: null });
  });

  it("frontmatter products[] の単価は検査しない（誤検知回避）", () => {
    // 本文は数値なし。products[].pricePerUnit に 円/mL があっても検出されない。
    const v = lintArticleBody(article("選び方は容量単位で考えるのが基本です。"));
    expect(v).toHaveLength(0);
  });

  it("faqs[].answer の単価表記を area:'faq'・line:null で検出する", () => {
    const faqs = `faqs:
  - question: "コスパは？"
    answer: "大容量タイプは約0.47円/mLと割安です。"
`;
    const v = lintArticleBody(article("選び方の解説。", faqs));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "unit-price", area: "faq", severity: "error", line: null });
  });

  it("「円錐」など価格でない円を含むテーブル行は誤検知しない", () => {
    const body = [
      "| タイプ | 特徴 | 価格イメージ |",
      "|---|---|---|",
      "| 円錐・無漂白（ハリオ V60） | スペシャルティ向け | やや高め |",
    ].join("\n");
    expect(lintArticleBody(article(body))).toHaveLength(0);
  });

  it("一般目安（割合・年数）と許可コメント行は除外する", () => {
    const body = [
      "まとめ買いで30〜50%安くなる傾向があります。",
      "未開封なら約3年は品質を保てます。",
      "出典: 2026年6月時点の調査で 1,980円 でした。<!-- lint-allow-number -->",
    ].join("\n");
    expect(lintArticleBody(article(body))).toHaveLength(0);
  });

  it("比較表の構成・順位に依存する表現を error として検出する", () => {
    const lines = [
      "比較表の上位に並ぶのは、大きく次の3系統です。",
      "単価が下位に並ぶ商品には詰め替え用が含まれます。",
      "| サイズ | 比較表の商品の例 | 選び方 |",
      "なお、現在の比較表にはエコ素材の袋は入っていません。",
      "## 上部の3商品の読み方",
      "## 比較表の10商品を3グループで読み分ける",
    ];
    for (const line of lines) {
      expect(lintArticleBody(article(line)), line).toMatchObject([
        { kind: "table-composition", area: "body", severity: "error" },
      ]);
    }
  });

  it("構成に依存しない比較表への言及は誤検知しない", () => {
    const body = [
      "最新の単価と順位はページ上部の比較表（自動更新）でご確認ください。",
      "比較表には両方が並ぶことがあるので、どちらが欲しいのかを先に決めてください。",
      "| 重視すること | 商品名の目印 | 確認するところ |",
    ].join("\n");
    expect(lintArticleBody(article(body))).toHaveLength(0);
  });

  it("掲載商品名（先頭2語）の直書きを warn で検出し、checkProductNames: false で止める", () => {
    const body = "商品A 1000mL は詰め替えに向いています。";
    expect(lintArticleBody(article(body))).toMatchObject([
      { kind: "product-name", area: "body", severity: "warn" },
    ]);
    expect(lintArticleBody(article(body), { checkProductNames: false })).toHaveLength(0);
  });

  it("商品名キーは先頭2語から作り、1語だけの商品名は使わない", () => {
    expect(
      productNameKeys([
        { name: "シック ハイドロ5 カスタム 替刃" },
        { name: "エリエール" },
        { name: "A B 100枚" },
      ]),
    ).toEqual(["シック ハイドロ5"]);
  });
});

describe("lintArticleBody（統合: 全記事）", () => {
  // 将来 .mdx 追加時も漏らさないよう拡張子を許容する。
  const files = readdirSync(ARTICLES_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))
    .map((f) => join(ARTICLES_DIR, f));

  // SEO 測定中・監視中のため本文クリーンアップを一時保留している記事（2026-06-30 時点）。
  // 7月初旬の回復再判定後に順次浄化し、このリストから外す。詳細は
  // docs/IMPLEMENTATION_PLAN_BODY_NUMERIC_SINGLE_SOURCE.md / メモリ参照。
  // 測定凍結中のため table-composition の是正を保留している記事。解除日を過ぎたら直してここから外す。
  // tissue-paper: 「## 上部の3商品の読み方…」（凍結は data/measurement-holds.json で 2026-11-07 解除）
  const COMPOSITION_EXEMPT = new Set(["tissue-paper-comparison.md:table-composition"]);

  it("記事ファイルが取得できている", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("全記事に error レベルの手書き数値違反が無い", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const errors = getErrorViolations(lintArticleBody(content)).filter(
        (e) => !COMPOSITION_EXEMPT.has(`${basename(file)}:${e.kind}`),
      );
      for (const e of errors) {
        offenders.push(`${basename(file)}${e.line ? `:${e.line}` : " (faq)"} [${e.kind}] ${e.snippet}`);
      }
    }
    expect(offenders, `\n${offenders.join("\n")}\n`).toHaveLength(0);
  });
});
