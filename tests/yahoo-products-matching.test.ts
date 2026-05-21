import { describe, it, expect } from "vitest";
import {
  extractCapacityFromItemName,
  extractCapacityTotal,
  normalizeCapacityTotal,
} from "../scripts/lib/frontmatter";

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
});
