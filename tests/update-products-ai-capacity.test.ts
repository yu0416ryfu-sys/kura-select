import { describe, expect, it } from "vitest";
import {
  applyAiCapacityToContent,
  buildProcessedAiCapacityFrozenProduct,
  buildCapacityReviewInputItem,
  classifyAiCapacityLine,
  computePendingFinalization,
  parseJsonlPreservingRaw,
} from "../scripts/lib/ai-capacity";
import { extractProductSnapshotByRank } from "../scripts/lib/frontmatter";

const ARTICLE = `---
title: "AI capacity test"
products:
  - rank: 1
    name: "オーガニックホホバオイル ゴールデン"
    price: 567
    capacity: "100mL"
    pricePerUnit: "約5.7円/mL"
    rakutenUrl: "https://item.rakuten.co.jp/shop/item/"
---
本文
`;

function match(overrides: Record<string, unknown> = {}) {
  return {
    articleFile: "src/content/articles/hair-oil-comparison.md",
    rank: 1,
    current: {
      name: "オーガニックホホバオイル ゴールデン",
      capacity: "100mL",
      price: 567,
      rakutenUrl: "https://item.rakuten.co.jp/shop/item/",
    },
    basis: {
      apiPrice: 567,
      itemUrl: "https://item.rakuten.co.jp/shop/item/",
      affiliateUrl: "https://item.rakuten.co.jp/shop/item/",
    },
    decision: "apply",
    newCapacity: "20mL",
    reason: "test",
    ...overrides,
  };
}

describe("ai-capacity helpers", () => {
  it("buildCapacityReviewInputItem includes stale guard fields", () => {
    const item = buildCapacityReviewInputItem({
      file: "hair-oil-comparison.md",
      category: "hair-oil",
      method: "[Item/Get]",
      currentSnapshot: extractProductSnapshotByRank(ARTICLE, 1),
      data: {
        name: "API item",
        price: 567,
        itemUrl: "https://item.rakuten.co.jp/shop/item/",
        affiliateUrl: "https://item.rakuten.co.jp/shop/item/",
      },
      capacityAnalysis: { confidence: "low" },
      extractedCap: "100mL",
      reviewReasons: ["multiple capacity variant"],
      action: "kept existing capacity; review recommended",
    });

    expect(item.rank).toBe(1);
    expect(item.current.price).toBe(567);
    expect(item.current.rakutenUrl).toBe("https://item.rakuten.co.jp/shop/item/");
    expect(item.basis).toEqual({
      apiPrice: 567,
      itemUrl: "https://item.rakuten.co.jp/shop/item/",
      affiliateUrl: "https://item.rakuten.co.jp/shop/item/",
    });
  });

  it("decision apply updates capacity and recalculates pricePerUnit", () => {
    const result = applyAiCapacityToContent(ARTICLE, match(), "mL");

    expect(result.outcome).toBe("processed");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('capacity: "20mL"');
    expect(result.content).toContain('pricePerUnit: "約28円/mL"');
    expect(result.frozenProduct).toMatchObject({
      articleFile: "src/content/articles/hair-oil-comparison.md",
      rank: 1,
      name: "オーガニックホホバオイル ゴールデン",
    });
  });

  it("buildProcessedAiCapacityFrozenProduct keeps a processed keep decision despite price changes", () => {
    const currentProduct = {
      ...extractProductSnapshotByRank(ARTICLE, 1)!,
      price: 600,
    };

    const result = buildProcessedAiCapacityFrozenProduct(match({ decision: "keep", newCapacity: undefined }), currentProduct);

    expect(result).toMatchObject({
      articleFile: "src/content/articles/hair-oil-comparison.md",
      rank: 1,
      name: "オーガニックホホバオイル ゴールデン",
      rakutenUrl: "https://item.rakuten.co.jp/shop/item/",
    });
  });

  it("buildProcessedAiCapacityFrozenProduct ignores a keep decision when capacity changed", () => {
    const currentProduct = {
      ...extractProductSnapshotByRank(ARTICLE, 1)!,
      capacity: "120mL",
    };

    const result = buildProcessedAiCapacityFrozenProduct(match({ decision: "keep", newCapacity: undefined }), currentProduct);

    expect(result).toBeNull();
  });

  it("decision clear explicitly disables capacity and pricePerUnit", () => {
    const result = applyAiCapacityToContent(ARTICLE, match({ decision: "clear", newCapacity: undefined }), "mL");

    expect(result.outcome).toBe("processed");
    expect(result.content).toContain('capacity: "-"');
    expect(result.content).toContain('pricePerUnit: "-"');
  });

  it("price mismatch is sent to review", () => {
    const result = applyAiCapacityToContent(
      ARTICLE,
      match({ current: { ...match().current, price: 999 } }),
      "mL"
    );

    expect(result.outcome).toBe("review");
    expect(result.content).toBe(ARTICLE);
  });

  it("different rakuten item URL is sent to review", () => {
    const result = applyAiCapacityToContent(
      ARTICLE,
      match({ current: { ...match().current, rakutenUrl: "https://item.rakuten.co.jp/shop/other/" } }),
      "mL"
    );

    expect(result.outcome).toBe("review");
    expect(result.content).toBe(ARTICLE);
  });

  it("old JSONL missing current.price is sent to review", () => {
    const current = { ...match().current };
    delete (current as Record<string, unknown>).price;

    const result = applyAiCapacityToContent(ARTICLE, match({ current }), "mL");

    expect(result.outcome).toBe("review");
    expect(result.content).toBe(ARTICLE);
  });

  it("parseJsonlPreservingRaw keeps raw lines and original line numbers", () => {
    const lines = parseJsonlPreservingRaw('{"ok":true}\n\n{broken}\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ lineNo: 1, raw: '{"ok":true}', ok: true, empty: false });
    expect(lines[1]).toMatchObject({ lineNo: 2, raw: "", ok: true, empty: true });
    expect(lines[2]).toMatchObject({ lineNo: 3, raw: "{broken}", ok: false, empty: false });
  });

  it("classifyAiCapacityLine keeps --file対象外行 as pending", () => {
    const parsed = parseJsonlPreservingRaw(JSON.stringify(match()))[0];
    const classified = classifyAiCapacityLine(parsed, extractProductSnapshotByRank(ARTICLE, 1), false);

    expect(classified.outcome).toBe("pending");
    expect(classified.raw).toBe(JSON.stringify(match()));
  });

  it("computePendingFinalization writes only pending raw lines", () => {
    const result = computePendingFinalization([
      { outcome: "processed", raw: '{"a":1}' },
      { outcome: "review", raw: '{"b":2}' },
      { outcome: "failed", raw: "{broken}" },
      { outcome: "pending", raw: '{"keep":true}' },
    ]);

    expect(result.hasPending).toBe(true);
    expect(result.shouldArchiveSource).toBe(false);
    expect(result.pendingText).toBe('{"keep":true}\n');
  });
});
