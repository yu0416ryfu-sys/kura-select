import { describe, it, expect } from "vitest";
import {
  upsertProviderOfferInFrontmatter,
  markProviderOffersForReview,
} from "../scripts/lib/offers-frontmatter";

const AMAZON_URL_OLD = "https://www.amazon.co.jp/dp/B0EXAMPLE0?tag=testtag-22";
const AMAZON_URL_NEW = "https://www.amazon.co.jp/dp/B0EXAMPLE1?tag=testtag-22";

const candidateAmazon = {
  provider: "amazon" as const,
  label: "Amazon" as const,
  asin: "B0EXAMPLE0",
  name: "テスト商品 Amazon版",
  price: 4800,
  url: AMAZON_URL_OLD,
  imageUrl: "https://m.media-amazon.com/images/I/example.jpg",
  available: true,
  sellerName: null,
};

const candidateAmazonNewUrl = {
  ...candidateAmazon,
  asin: "B0EXAMPLE1",
  url: AMAZON_URL_NEW,
};

// ─── テスト用 frontmatter フィクスチャ ────────────────────────────────────────

const CONTENT_NO_OFFER = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers: []
---
本文
`;

const CONTENT_AMAZON_MATCHED = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers:
      - provider: "amazon"
        label: "Amazon"
        asin: "B0EXAMPLE0"
        url: "${AMAZON_URL_OLD}"
        matchStatus: "matched"
        updatedAt: "2026-05-01T03:00:00.000Z"
---
本文
`;

const CONTENT_AMAZON_PENDING = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers:
      - provider: "amazon"
        label: "Amazon"
        asin: "B0EXAMPLE0"
        url: "${AMAZON_URL_OLD}"
        matchStatus: "pending"
        updatedAt: "2026-05-01T03:00:00.000Z"
---
本文
`;

const CONTENT_AMAZON_REVIEW = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers:
      - provider: "amazon"
        label: "Amazon"
        asin: "B0EXAMPLE0"
        url: "${AMAZON_URL_OLD}"
        available: false
        matchStatus: "review"
        updatedAt: "2026-05-01T03:00:00.000Z"
---
本文
`;

// ─── Amazon offer 新規追加 ────────────────────────────────────────────────────

describe("Amazon offer 新規追加", () => {
  it("offer なしの商品に pending として追加する", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_NO_OFFER, "テスト商品", candidateAmazon, "2026-05-22T03:00:00.000Z");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"pending"');
    expect(result.content).toContain(AMAZON_URL_OLD);
    expect(result.content).toContain('"B0EXAMPLE0"');
  });

  it("新規 Amazon offer には price/available/imageUrl を保存しない", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_NO_OFFER, "テスト商品", candidateAmazon, "2026-05-22T03:00:00.000Z");
    expect(result.changed).toBe(true);
    expect(result.content).not.toContain("4800");
    expect(result.content).not.toContain("available");
    expect(result.content).not.toContain("imageUrl");
  });

  it("updatedAt は ISO datetime 文字列で保存される（日付のみに潰れない）", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_NO_OFFER, "テスト商品", candidateAmazon, "2026-05-22T03:00:00.000Z");
    expect(result.content).toContain("2026-05-22T03:00:00.000Z");
  });
});

// ─── Amazon matched offer 更新 ────────────────────────────────────────────────

describe("Amazon matched/legacy offer の保護と更新", () => {
  it("matched offer と同一 URL の更新は許可する（updatedAt を更新）", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_AMAZON_MATCHED, "テスト商品", candidateAmazon, "2026-05-22T03:00:00.000Z");
    expect(result.changed).toBe(true);
    expect(result.content).toContain("2026-05-22T03:00:00.000Z");
  });

  it("matched offer への更新でも price/available/imageUrl を保存しない", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_AMAZON_MATCHED, "テスト商品", candidateAmazon, "2026-05-22T03:00:00.000Z");
    expect(result.content).not.toContain("4800");
    expect(result.content).not.toContain("available");
    expect(result.content).not.toContain("imageUrl");
  });

  it("matched offer に別 URL 候補が来ても上書きしない", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_AMAZON_MATCHED, "テスト商品", candidateAmazonNewUrl, "2026-05-22T03:00:00.000Z");
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/上書きしない/);
    expect(result.content).not.toContain(AMAZON_URL_NEW);
  });
});

// ─── Amazon pending offer ─────────────────────────────────────────────────────

describe("Amazon pending offer", () => {
  it("pending と同一 URL の更新は許可する", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_AMAZON_PENDING, "テスト商品", candidateAmazon, "2026-05-22T03:00:00.000Z");
    expect(result.changed).toBe(true);
  });

  it("pending に別 URL 候補が来ても capacityVerified なしは上書きしない", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_AMAZON_PENDING, "テスト商品", candidateAmazonNewUrl, "2026-05-22T03:00:00.000Z");
    expect(result.changed).toBe(false);
  });

  it("pending + 同一 URL + capacityVerified + strictMatch で matched に昇格する", () => {
    const result = upsertProviderOfferInFrontmatter(
      CONTENT_AMAZON_PENDING,
      "テスト商品",
      candidateAmazon,
      "2026-05-22T03:00:00.000Z",
      { capacityVerified: true, strictMatch: true }
    );
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"matched"');
  });
});

// ─── Amazon review/rejected は自動復活しない ─────────────────────────────────

describe("Amazon review offer は変更しない", () => {
  it("review offer は同一 URL でも別 URL でも変更しない", () => {
    const resultSame = upsertProviderOfferInFrontmatter(CONTENT_AMAZON_REVIEW, "テスト商品", candidateAmazon, "2026-05-22T03:00:00.000Z");
    const resultNew = upsertProviderOfferInFrontmatter(CONTENT_AMAZON_REVIEW, "テスト商品", candidateAmazonNewUrl, "2026-05-22T03:00:00.000Z");
    expect(resultSame.changed).toBe(false);
    expect(resultNew.changed).toBe(false);
  });
});

// ─── markProviderOffersForReview (Amazon) ────────────────────────────────────

describe("markProviderOffersForReview - Amazon", () => {
  it("Amazon offer を review 状態にする", () => {
    const result = markProviderOffersForReview(CONTENT_AMAZON_MATCHED, "テスト商品", "amazon", "Amazon商品差し替え");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"review"');
    expect(result.content).toContain("false");
    expect(result.content).toContain("Amazon商品差し替え");
  });

  it("すでに review の offer は再変更しない", () => {
    const result = markProviderOffersForReview(CONTENT_AMAZON_REVIEW, "テスト商品", "amazon", "追加メモ");
    expect(result.changed).toBe(false);
  });
});

// ─── Yahoo offer の既存テストが offers-frontmatter 経由で通ること ─────────────

describe("Yahoo offer - offers-frontmatter 共通化後の回帰", () => {
  const yahooUrl = "https://store.shopping.yahoo.co.jp/example/item.html";
  const yahooCandidate = {
    provider: "yahoo" as const,
    label: "Yahoo!" as const,
    name: "テスト商品 Yahoo版",
    price: 5200,
    url: yahooUrl,
    imageUrl: null,
    available: true,
    sellerName: null,
  };

  const CONTENT_YAHOO_NO_OFFER = `---
products:
  - rank: 1
    name: "テスト商品"
    price: 5000
    offers: []
---
本文
`;

  it("Yahoo offer を新規 pending として追加できる", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_YAHOO_NO_OFFER, "テスト商品", yahooCandidate, "2026-05-22");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"pending"');
    expect(result.content).toContain(yahooUrl);
  });

  it("Yahoo offer は price/available/imageUrl を保存する（Amazon と異なる）", () => {
    const result = upsertProviderOfferInFrontmatter(CONTENT_YAHOO_NO_OFFER, "テスト商品", yahooCandidate, "2026-05-22");
    expect(result.content).toContain("5200");
    expect(result.content).toContain("available");
  });
});
