import { describe, it, expect } from "vitest";
import { upsertYahooOfferInFrontmatter, markProviderOffersForReview } from "../scripts/lib/yahoo-offers";
import { upsertProviderOfferInFrontmatter } from "../scripts/lib/offers-frontmatter";

// ─── テスト用フィクスチャ ─────────────────────────────────────────────────────

const OLD_URL = "https://store.shopping.yahoo.co.jp/example/item-old.html";
const NEW_URL = "https://store.shopping.yahoo.co.jp/example/item-new.html";

function makeContent(offerOverrides: Record<string, unknown> | null) {
  const offersBlock = offerOverrides
    ? `    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: ${offerOverrides.price ?? 5100}
        url: "${offerOverrides.url ?? OLD_URL}"
        available: ${offerOverrides.available ?? true}${offerOverrides.matchStatus ? `\n        matchStatus: "${offerOverrides.matchStatus}"` : ""}
        updatedAt: "2026-05-01"`
    : "";
  return `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    capacity: "100m×60ロール"
    rakutenUrl: "https://hb.afl.rakuten.co.jp/example/"
    offers: []
${offerOverrides ? offersBlock.replace("    offers: []", "    offers:") : "    offers: []"}
---
本文
`.replace("    offers: []\n    offers:", "    offers:");
}

// matched offer を持つ content
const CONTENT_MATCHED = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: 5100
        url: "${OLD_URL}"
        available: true
        matchStatus: "matched"
        updatedAt: "2026-05-01"
---
本文
`;

// matchStatus なし offer（legacy）
const CONTENT_LEGACY = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: 5100
        url: "${OLD_URL}"
        available: true
        updatedAt: "2026-05-01"
---
本文
`;

// pending offer
const CONTENT_PENDING = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: 5100
        url: "${OLD_URL}"
        available: true
        matchStatus: "pending"
        updatedAt: "2026-05-01"
---
本文
`;

// review offer
const CONTENT_REVIEW = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: 5100
        url: "${OLD_URL}"
        available: false
        matchStatus: "review"
        updatedAt: "2026-05-01"
---
本文
`;

// offer なし
const CONTENT_NO_OFFER = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers: []
---
本文
`;

const candidateNewUrl = {
  provider: "yahoo" as const,
  label: "Yahoo!" as const,
  name: "テスト商品 Yahoo版",
  price: 5200,
  url: NEW_URL,
  imageUrl: null,
  available: true,
  sellerName: null,
};

const candidateSameUrl = {
  ...candidateNewUrl,
  url: OLD_URL,
};

const candidateWithRating = {
  ...candidateSameUrl,
  rating: 4.58,
  reviewCount: 246,
};

const candidateNewUrlWithRating = {
  ...candidateWithRating,
  url: NEW_URL,
};

const candidateWithoutRating = {
  ...candidateNewUrl,
  rating: null,
  reviewCount: null,
};

// ─── upsertYahooOfferInFrontmatter ────────────────────────────────────────────

describe("upsertYahooOfferInFrontmatter - 既存 matched / legacy 保護", () => {
  it("matched offerに別URL候補が来ても上書きしない", () => {
    const result = upsertYahooOfferInFrontmatter(CONTENT_MATCHED, "テスト商品", candidateNewUrl, "2026-05-19");
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/上書きしない/);
    expect(result.content).not.toContain(NEW_URL);
  });

  it("matchStatus なし (legacy) offerに別URL候補が来ても上書きしない", () => {
    const result = upsertYahooOfferInFrontmatter(CONTENT_LEGACY, "テスト商品", candidateNewUrl, "2026-05-19");
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/上書きしない/);
  });

  it("matched offerと同一URL候補なら価格・在庫・更新日を更新する", () => {
    const result = upsertYahooOfferInFrontmatter(CONTENT_MATCHED, "テスト商品", candidateSameUrl, "2026-05-19");
    expect(result.changed).toBe(true);
    expect(result.content).toContain("5200");
    expect(result.content).toContain("2026-05-19");
    // matchStatus は matched のまま維持
    expect(result.content).toContain('"matched"');
  });

  it("matchStatus なし (legacy) offerと同一URL候補なら更新する", () => {
    const result = upsertYahooOfferInFrontmatter(CONTENT_LEGACY, "テスト商品", candidateSameUrl, "2026-05-19");
    expect(result.changed).toBe(true);
    expect(result.content).toContain("5200");
  });
});

describe("upsertYahooOfferInFrontmatter - pending offer", () => {
  it("pending offerと同一URL候補なら更新する", () => {
    const result = upsertYahooOfferInFrontmatter(CONTENT_PENDING, "テスト商品", candidateSameUrl, "2026-05-19");
    expect(result.changed).toBe(true);
    expect(result.content).toContain("5200");
  });

  it("pending offerに別URL候補が来ても上書きしない", () => {
    const result = upsertYahooOfferInFrontmatter(CONTENT_PENDING, "テスト商品", candidateNewUrl, "2026-05-19");
    expect(result.changed).toBe(false);
  });
});

describe("upsertYahooOfferInFrontmatter - review/rejected は自動復活しない", () => {
  it("review offerは別URL候補でも同一URL候補でも変更しない", () => {
    const resultNew = upsertYahooOfferInFrontmatter(CONTENT_REVIEW, "テスト商品", candidateNewUrl, "2026-05-19");
    const resultSame = upsertYahooOfferInFrontmatter(CONTENT_REVIEW, "テスト商品", candidateSameUrl, "2026-05-19");
    expect(resultNew.changed).toBe(false);
    expect(resultSame.changed).toBe(false);
  });
});

describe("upsertYahooOfferInFrontmatter - 新規offer追加", () => {
  it("offer なしの商品に新規候補を pending として追加する", () => {
    const result = upsertYahooOfferInFrontmatter(CONTENT_NO_OFFER, "テスト商品", candidateNewUrl, "2026-05-19");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"pending"');
    expect(result.content).toContain(NEW_URL);
  });

  it("新規offerは matched ではなく pending として追加される", () => {
    const result = upsertYahooOfferInFrontmatter(CONTENT_NO_OFFER, "テスト商品", candidateNewUrl, "2026-05-19");
    expect(result.content).not.toContain('"matched"');
    expect(result.content).toContain('"pending"');
  });
});

describe("upsertProviderOfferInFrontmatter - rating/reviewCount", () => {
  it("新規 Yahoo offer に rating/reviewCount を書き込む", () => {
    const result = upsertProviderOfferInFrontmatter(
      CONTENT_NO_OFFER,
      "テスト商品",
      candidateNewUrlWithRating,
      "2026-05-19"
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain("rating: 4.58");
    expect(result.content).toContain("reviewCount: 246");
  });

  it("同一URL更新では rating/reviewCount を最新値で更新する", () => {
    const result = upsertProviderOfferInFrontmatter(
      CONTENT_MATCHED,
      "テスト商品",
      candidateWithRating,
      "2026-05-19"
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain("rating: 4.58");
    expect(result.content).toContain("reviewCount: 246");
  });

  it("pending の同一URL更新では rating/reviewCount を書き込む", () => {
    const result = upsertProviderOfferInFrontmatter(
      CONTENT_PENDING,
      "テスト商品",
      candidateWithRating,
      "2026-05-19"
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain("rating: 4.58");
    expect(result.content).toContain("reviewCount: 246");
  });

  it("pending のURL変更では検証済みの場合だけ rating/reviewCount を置換する", () => {
    const result = upsertProviderOfferInFrontmatter(
      CONTENT_PENDING,
      "テスト商品",
      candidateNewUrlWithRating,
      "2026-05-19",
      { capacityVerified: true }
    );

    expect(result.changed).toBe(true);
    expect(result.content).toContain(NEW_URL);
    expect(result.content).toContain("rating: 4.58");
    expect(result.content).toContain("reviewCount: 246");
  });

  it("評価 null の候補では新規 offer に rating/reviewCount を設定しない", () => {
    const result = upsertProviderOfferInFrontmatter(
      CONTENT_NO_OFFER,
      "テスト商品",
      candidateWithoutRating,
      "2026-05-19"
    );

    expect(result.changed).toBe(true);
    expect(result.content).not.toContain("rating:");
    expect(result.content).not.toContain("reviewCount:");
  });
});

// ─── markProviderOffersForReview ──────────────────────────────────────────────

describe("markProviderOffersForReview", () => {
  it("Yahoo offerを available: false かつ matchStatus: review にする", () => {
    const result = markProviderOffersForReview(CONTENT_MATCHED, "テスト商品", "yahoo", "テスト用メモ");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"review"');
    expect(result.content).toContain("false");
    expect(result.content).toContain("テスト用メモ");
  });

  it("すでに review のofferは再変更しない", () => {
    const result = markProviderOffersForReview(CONTENT_REVIEW, "テスト商品", "yahoo", "追加メモ");
    expect(result.changed).toBe(false);
  });

  it("offer なしの商品は変更しない", () => {
    const result = markProviderOffersForReview(CONTENT_NO_OFFER, "テスト商品", "yahoo", "メモ");
    expect(result.changed).toBe(false);
  });

  it("legacy matchStatus なしのofferもreview化できる", () => {
    const result = markProviderOffersForReview(CONTENT_LEGACY, "テスト商品", "yahoo", "商品差し替えメモ");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"review"');
    expect(result.content).toContain("false");
  });
});

// ─── 回帰テスト: 商品名変更後のreview化（Codex adversarial review指摘）─────
describe("markProviderOffersForReview - 商品名変更後の検索名問題（回帰）", () => {
  // updateProductInFrontmatter で newName 適用後のコンテンツを想定
  const CONTENT_RENAMED = `---
products:
  - rank: 1
    name: "テスト商品 新名称"
    price: 5000
    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: 5100
        url: "${OLD_URL}"
        available: true
        matchStatus: "matched"
        updatedAt: "2026-05-01"
---
本文
`;

  it("旧名称で検索すると見つからずchanged: falseになる（バグ再現）", () => {
    const result = markProviderOffersForReview(CONTENT_RENAMED, "テスト商品", "yahoo", "メモ");
    expect(result.changed).toBe(false);
  });

  it("新名称で検索するとreview化が成功する（正しい動作）", () => {
    const result = markProviderOffersForReview(CONTENT_RENAMED, "テスト商品 新名称", "yahoo", "商品名変更によりYahoo再確認が必要");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"review"');
    expect(result.content).toContain("false");
  });

  it("update-products.mjs の修正後: updates.newName ?? name を使えば正しくreview化される", () => {
    // updateProductInFrontmatter(content, "テスト商品", { newName: "テスト商品 新名称" }) 後に
    // markProviderOffersForReview(renamed, "テスト商品 新名称", ...) が呼ばれる想定
    const lookupName = "テスト商品 新名称"; // updates.newName ?? name の結果
    const result = markProviderOffersForReview(CONTENT_RENAMED, lookupName, "yahoo", "商品名変更によりYahoo再確認が必要");
    expect(result.changed).toBe(true);
  });
});
