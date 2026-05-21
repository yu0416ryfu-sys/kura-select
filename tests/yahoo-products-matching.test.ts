import { describe, it, expect } from "vitest";
import {
  extractCapacityFromItemName,
  extractCapacityTotal,
  normalizeCapacityTotal,
} from "../scripts/lib/frontmatter";
import { upsertYahooOfferInFrontmatter } from "../scripts/lib/yahoo-offers";

// update-yahoo-products.mjs の helper と同じロジックをここで検証する
function toComparableCapacity(capacity: string | null | undefined) {
  return normalizeCapacityTotal(extractCapacityTotal(capacity ?? ""));
}

function isSameComparableCapacity(a: string | null | undefined, b: string | null | undefined): boolean {
  const aTotal = toComparableCapacity(a);
  const bTotal = toComparableCapacity(b);
  return Boolean(
    aTotal &&
    bTotal &&
    aTotal.total === bTotal.total &&
    aTotal.unit.toLowerCase() === bTotal.unit.toLowerCase()
  );
}

describe("Yahoo候補の容量照合", () => {
  describe("isSameComparableCapacity", () => {
    it("70枚×12個 と 70枚x10コパック は不一致", () => {
      const candidateCap = extractCapacityFromItemName("大王製紙 グーン やわらか素材のおしりふき 70枚x10コパック");
      expect(isSameComparableCapacity("70枚×12個", candidateCap)).toBe(false);
    });

    it("76枚×32個 と 1520枚（76枚×20個パック）は不一致", () => {
      const candidateCap = extractCapacityFromItemName("おしりふき 1520枚（76枚×20個パック）");
      expect(isSameComparableCapacity("76枚×32個", candidateCap)).toBe(false);
    });

    it("80枚×40個 と 【80枚×40個】おしりナップ は一致", () => {
      const candidateCap = extractCapacityFromItemName("【80枚×40個】おしりナップ やわらかタイプ");
      expect(isSameComparableCapacity("80枚×40個", candidateCap)).toBe(true);
    });

    it("容量抽出不可の候補（ウェットティッシュケース）は null になり不一致", () => {
      const candidateCap = extractCapacityFromItemName("フレッシュロック ウェットティッシュケース ホワイト");
      // 容量表記がない商品名から抽出した結果は null か、あっても総量が一致しない
      const result = isSameComparableCapacity("70枚×12個", candidateCap);
      expect(result).toBe(false);
    });

    it("capacity が null の場合は false", () => {
      expect(isSameComparableCapacity(null, "70枚×10個")).toBe(false);
      expect(isSameComparableCapacity("70枚×10個", null)).toBe(false);
    });
  });

  describe("toComparableCapacity", () => {
    it("70枚×12個 → 840枚", () => {
      const result = toComparableCapacity("70枚×12個");
      expect(result?.total).toBe(840);
      expect(result?.unit).toBe("枚");
    });

    it("76枚×32個 → 2432枚", () => {
      const result = toComparableCapacity("76枚×32個");
      expect(result?.total).toBe(2432);
      expect(result?.unit).toBe("枚");
    });

    it("空文字 → null", () => {
      expect(toComparableCapacity("")).toBeNull();
    });

    it("null → null", () => {
      expect(toComparableCapacity(null)).toBeNull();
    });
  });

  describe("extractCapacityFromItemName: 【N個】前置きタグの除去", () => {
    it("【12個】グーン...70枚×12P → 12個ではなく 70枚×12 を返す", () => {
      const cap = extractCapacityFromItemName(
        "【12個】グーン 肌にやさしいおしりふきつめかえ用 GOO.N 大王製紙 70枚×12P 送料無料"
      );
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(840);
      expect(total?.unit).toBe("枚");
    });

    it("【12個】除去後の結果は楽天 70枚×12個 と一致する", () => {
      const candidateCap = extractCapacityFromItemName(
        "【12個】グーン 肌にやさしいおしりふきつめかえ用 GOO.N 大王製紙 70枚×12P 送料無料"
      );
      expect(isSameComparableCapacity("70枚×12個", candidateCap)).toBe(true);
    });

    it("× を含む【80枚×40個】は除去しない", () => {
      const cap = extractCapacityFromItemName("【80枚×40個】おしりナップ やわらか厚手仕上げ");
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(3200);
      expect(total?.unit).toBe("枚");
    });

    it("【100枚】など容量単位は除去しない", () => {
      const cap = extractCapacityFromItemName("【100枚】おしりふき やわらかタイプ");
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(100);
      expect(total?.unit).toBe("枚");
    });

    it("【500mL】など計量単位は除去しない", () => {
      const cap = extractCapacityFromItemName("【500mL】ビオレ ボディウォッシュ");
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(500);
      expect(total?.unit).toBe("mL");
    });

    it("【2個】ビオレ 500mL → 乗数を折り込み 1000mL を返す", () => {
      const cap = extractCapacityFromItemName("【2個】ビオレ ボディウォッシュ 500mL");
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(1000);
      expect(total?.unit).toBe("mL");
    });

    it("【2個】ビオレ 500mL は楽天 500mL と一致しない", () => {
      const candidateCap = extractCapacityFromItemName("【2個】ビオレ ボディウォッシュ 500mL");
      expect(isSameComparableCapacity("500mL", candidateCap)).toBe(false);
    });
  });

  describe("upsertYahooOfferInFrontmatter: pending 差し替え", () => {
    const BASE_FM = `---
title: "テスト"
products:
  - name: "商品A"
    rank: 1
    capacity: "76枚×32個"
    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: 3000
        url: "https://example.com/old"
        available: true
        matchStatus: "pending"
        updatedAt: "2026-01-01"
---
本文
`;

    const candidate = {
      provider: "yahoo" as const,
      label: "Yahoo!" as const,
      name: "商品A 76枚×32個",
      price: 2800,
      url: "https://example.com/new",
      imageUrl: null,
      available: true,
      sellerName: null,
    };

    it("capacityVerified: false のとき別URL候補は拒否する", () => {
      const result = upsertYahooOfferInFrontmatter(BASE_FM, "商品A", candidate, "2026-05-21", { capacityVerified: false });
      expect(result.changed).toBe(false);
      expect(result.reason).toContain("pending");
    });

    it("capacityVerified: true のとき別URL候補で pending を差し替える", () => {
      const result = upsertYahooOfferInFrontmatter(BASE_FM, "商品A", candidate, "2026-05-21", { capacityVerified: true });
      expect(result.changed).toBe(true);
      expect(result.content).toContain("https://example.com/new");
    });

    it("URL変更時に candidate.price が null なら price フィールドを省略する", () => {
      const nullPriceCandidate = { ...candidate, price: null };
      const result = upsertYahooOfferInFrontmatter(BASE_FM, "商品A", nullPriceCandidate, "2026-05-21", { capacityVerified: true });
      expect(result.changed).toBe(true);
      // 旧 offer の price: 3000 を引き継がない
      expect(result.content).not.toMatch(/price:\s*3000/);
      // null をそのまま書き込まない（スキーマ違反防止）
      expect(result.content).not.toContain("price: null");
    });
  });
});
