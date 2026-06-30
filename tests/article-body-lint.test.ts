import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, basename, join } from "node:path";
import {
  lintArticleBody,
  getErrorViolations,
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

  it("税込価格（3桁以上+円）は既定 warn、priceAsError で error", () => {
    const body = "この洗剤はおよそ2,680円で購入できます。";
    expect(lintArticleBody(article(body))[0]).toMatchObject({ kind: "price", severity: "warn" });
    expect(lintArticleBody(article(body), { priceAsError: true })[0]).toMatchObject({
      kind: "price",
      severity: "error",
    });
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
});

describe("lintArticleBody（統合: 全記事）", () => {
  // 将来 .mdx 追加時も漏らさないよう拡張子を許容する。
  const files = readdirSync(ARTICLES_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))
    .map((f) => join(ARTICLES_DIR, f));

  // SEO 測定中・監視中のため本文クリーンアップを一時保留している記事（2026-06-30 時点）。
  // 7月初旬の回復再判定後に順次浄化し、このリストから外す。詳細は
  // docs/IMPLEMENTATION_PLAN_BODY_NUMERIC_SINGLE_SOURCE.md / メモリ参照。
  const MEASUREMENT_HOLD = new Set(
    [
      "conditioner",
      "cotton",
      "fabric-softener",
      "floor-cleaner",
      "garbage-bag",
      "hair-treatment",
      "kitchen-sponge",
      "laundry-detergent",
      "mask",
      "sanitary-napkin",
      "tissue-paper",
      "wet-tissue",
    ].map((s) => `${s}-comparison.md`),
  );

  it("記事ファイルが取得できている", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("測定保留を除く全記事に error レベルの手書き数値違反が無い", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (MEASUREMENT_HOLD.has(basename(file))) continue;
      const content = readFileSync(file, "utf-8");
      const errors = getErrorViolations(lintArticleBody(content));
      for (const e of errors) {
        offenders.push(`${basename(file)}${e.line ? `:${e.line}` : " (faq)"} [${e.kind}] ${e.snippet}`);
      }
    }
    expect(offenders, `\n${offenders.join("\n")}\n`).toHaveLength(0);
  });
});
