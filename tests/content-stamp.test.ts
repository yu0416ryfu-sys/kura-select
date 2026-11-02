import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeContentHash,
  normalizeTitleCount,
  stampContentDates,
  findStaleEntries,
  collectStampArticles,
  readContentDates,
  toJstDate,
} from "../scripts/lib/content-stamp.ts";
import { dumpFrontmatter, parseFrontmatter, syncTitleProductCount } from "../scripts/lib/frontmatter.ts";
import { buildArticleLastmod } from "../scripts/lib/sitemap-lastmod.mjs";

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const BASE = `---
title: "洗剤おすすめ3選【2026年】"
description: "人気の3商品を単価で比較。1商品あたりの容量も確認。"
category: "kitchen"
publishedAt: "2026-05-01"
updatedAt: "2026-10-01"
products:
  - name: "A"
    price: 500
    rank: 1
  - name: "B"
    price: 600
    rank: 2
  - name: "C"
    price: 700
    rank: 3
faqs:
  - question: "どれがいい？"
    answer: "用途で選びます。"
---

## はじめに

本文です。
`;

const hashOf = (s: string) => computeContentHash(s);

describe("computeContentHash", () => {
  it("価格・updatedAt・products[] だけ変えても不変", () => {
    const changed = BASE.replace("price: 500", "price: 450")
      .replace('updatedAt: "2026-10-01"', 'updatedAt: "2026-11-02"')
      .replace('name: "C"', 'name: "D"')
      .replace("rank: 1", "rank: 4");
    expect(hashOf(changed)).toBe(hashOf(BASE));
  });

  it("本文・description・faq を変えると変わる", () => {
    expect(hashOf(BASE.replace("本文です。", "本文を加筆しました。"))).not.toBe(hashOf(BASE));
    expect(hashOf(BASE.replace("単価で比較", "容量で比較"))).not.toBe(hashOf(BASE));
    expect(hashOf(BASE.replace("用途で選びます。", "価格で選びます。"))).not.toBe(hashOf(BASE));
  });

  it("title と description の件数（3選→2選・3商品→2商品）だけの変更では不変、それ以外の title 変更では変わる", () => {
    const counted = BASE.replace("3選", "2選").replace("3商品", "2商品");
    expect(hashOf(counted)).toBe(hashOf(BASE));
    expect(hashOf(BASE.replace("洗剤おすすめ", "食器用洗剤おすすめ"))).not.toBe(hashOf(BASE));
  });

  it("CRLF と LF で同じ", () => {
    expect(hashOf(BASE.replace(/\n/g, "\r\n"))).toBe(hashOf(BASE));
  });

  it("本文の先頭・末尾の空行だけの違いでは不変", () => {
    expect(hashOf(BASE + "\n\n")).toBe(hashOf(BASE));
  });

  it("frontmatter を再出力しただけ（引用符・改行の形が変わる）では不変", () => {
    // 手書きの単引用符・引用符なしを、update-products と同じ dumpFrontmatter で二重引用符に揃える
    const handWritten = BASE.replace('title: "洗剤おすすめ3選【2026年】"', "title: '洗剤おすすめ3選【2026年】'").replace('category: "kitchen"', 'category: kitchen');
    const parsed = parseFrontmatter(handWritten)!;
    const content = dumpFrontmatter(parsed.data, parsed.body);
    expect(content).not.toBe(handWritten);
    expect(hashOf(content)).toBe(hashOf(handWritten));
    expect(hashOf(handWritten)).toBe(hashOf(BASE));
  });

  it("frontmatter を parse できなければ null", () => {
    expect(hashOf("本文だけ")).toBeNull();
  });
});

describe("normalizeTitleCount", () => {
  it("syncTitleProductCount の書き換え前後で同じ値を返す", () => {
    const withTwo = BASE.replace(/  - name: "C"\n    price: 700\n    rank: 3\n/, "");
    const synced = syncTitleProductCount(withTwo);
    expect(synced.changed).toBe(true);
    expect(normalizeTitleCount(synced.after!)).toBe(normalizeTitleCount(synced.before!));
    expect(normalizeTitleCount(synced.descAfter!)).toBe(normalizeTitleCount(synced.descBefore!));
  });

  it("「1商品あたり」は件数として置き換えない", () => {
    expect(normalizeTitleCount("1商品あたりの容量")).toBe("1商品あたりの容量");
    expect(normalizeTitleCount("おすすめ１０選")).toBe("おすすめ#選");
  });
});

describe("stampContentDates", () => {
  const ledger = {
    keep: { hash: "h1", contentUpdatedAt: "2026-09-01" },
    edit: { hash: "h2", contentUpdatedAt: "2026-09-02" },
    gone: { hash: "h3", contentUpdatedAt: "2026-09-03" },
  };
  const articles = [
    { slug: "keep", hash: "h1", publishedAt: "2026-01-01" },
    { slug: "edit", hash: "h2-new", publishedAt: "2026-01-01" },
    { slug: "new", hash: "h4", publishedAt: "2026-10-30" },
  ];

  it("変更なし→据え置き / 変更あり→today / 新規→publishedAt / 削除→台帳から消える", () => {
    const result = stampContentDates(ledger, articles, "2026-11-03");
    expect(result.ledger).toEqual({
      edit: { hash: "h2-new", contentUpdatedAt: "2026-11-03" },
      keep: { hash: "h1", contentUpdatedAt: "2026-09-01" },
      new: { hash: "h4", contentUpdatedAt: "2026-10-30" },
    });
    expect(result.added).toEqual(["new"]);
    expect(result.changed).toEqual(["edit"]);
    expect(result.removed).toEqual(["gone"]);
    expect(Object.keys(result.ledger)).toEqual(["edit", "keep", "new"]);
  });

  it("keepDates ならハッシュだけ更新して日付は据え置く", () => {
    const result = stampContentDates(ledger, articles, "2026-11-03", { keepDates: true });
    expect(result.ledger.edit).toEqual({ hash: "h2-new", contentUpdatedAt: "2026-09-02" });
  });

  it("元の台帳を変更しない", () => {
    const copy = structuredClone(ledger);
    stampContentDates(ledger, articles, "2026-11-03");
    expect(ledger).toEqual(copy);
  });

  it("findStaleEntries は不一致・台帳に無い・台帳にだけある slug を返す", () => {
    expect(findStaleEntries(ledger, articles)).toEqual(["edit", "gone", "new"]);
  });
});

describe("toJstDate", () => {
  it("UTC 15:00 以降は JST の翌日", () => {
    expect(toJstDate(new Date("2026-11-02T14:59:59Z"))).toBe("2026-11-02");
    expect(toJstDate(new Date("2026-11-02T15:00:00Z"))).toBe("2026-11-03");
  });
});

// ---------------------------------------------------------------------------
// sitemap-lastmod（フィクスチャのディレクトリで直下と reviews/ を確認）
// ---------------------------------------------------------------------------

describe("buildArticleLastmod", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "content-stamp-"));
    fs.mkdirSync(path.join(dir, "reviews"));
    fs.writeFileSync(path.join(dir, "a-comparison.md"), BASE);
    fs.writeFileSync(path.join(dir, "b-comparison.md"), BASE.replace("2026-05-01", "2026-06-01"));
    fs.writeFileSync(path.join(dir, "reviews", "c-review.md"), BASE.replace("2026-05-01", "2026-07-01"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("台帳の contentUpdatedAt を使い、台帳に無い記事は publishedAt（updatedAt は使わない）", () => {
    const lastmod = buildArticleLastmod({
      articlesDir: dir,
      ledger: {
        "a-comparison": { hash: "x", contentUpdatedAt: "2026-09-10" },
        "reviews/c-review": { hash: "y", contentUpdatedAt: "2026-09-20" },
      },
    });
    expect(lastmod.get("a-comparison")).toBe(new Date("2026-09-10").toISOString());
    expect(lastmod.get("b-comparison")).toBe(new Date("2026-06-01").toISOString());
    expect(lastmod.get("reviews/c-review")).toBe(new Date("2026-09-20").toISOString());
  });

  it("collectStampArticles は reviews/ を含め、slug は article.id の形", () => {
    const slugs = collectStampArticles(dir).map((a) => a.slug).sort();
    expect(slugs).toEqual(["a-comparison", "b-comparison", "reviews/c-review"]);
  });
});

// ---------------------------------------------------------------------------
// 統合: 全公開記事のハッシュが台帳と一致する（台帳が無いブランチでは skip）
// ---------------------------------------------------------------------------

const ledgerOnDisk = readContentDates();

describe.skipIf(ledgerOnDisk === null)("data/content-dates.json と記事の一致", () => {
  it("記事を変えたら `pnpm content:stamp` を実行して台帳をコミットする", () => {
    const stale = findStaleEntries(ledgerOnDisk!, collectStampArticles());
    expect(
      stale,
      `台帳と内容がずれている記事: ${stale.join(", ")}\n→ \`pnpm content:stamp\` を実行して data/content-dates.json をコミットしてください`
    ).toEqual([]);
  });
});
