import { describe, it, expect } from "vitest";
import {
  extractCapacityTotal,
  calcPricePerUnit,
} from "../src/lib/capacity.ts";

// docs/IMPLEMENTATION_PLAN_CAPACITY_PARSER_2026-08-15.md の §4 に対応する。
// 既存パターン1〜4が null を返したときだけ走るフォールバック（パターン5〜7）を検証する。

// ─── パターン5: 寸法トークン除去 ─────────────────────────────────────────
describe("extractCapacityTotal / 寸法トークンを除去して残りを解析する", () => {
  it("幅cm×長さm は長さを分母にする", () => {
    expect(extractCapacityTotal("30cm×50m")).toEqual({ total: 50, unit: "m" });
  });

  it("幅cm×長さm×N本 は本数を掛ける", () => {
    expect(extractCapacityTotal("30cm×50m×3本")).toEqual({ total: 150, unit: "m" });
  });

  it("クッキングシートの 33cm×30m を解析する", () => {
    expect(extractCapacityTotal("33cm×30m")).toEqual({ total: 30, unit: "m" });
  });

  it("寸法のあとに枚数が続く表記は枚数を採用する", () => {
    expect(extractCapacityTotal("40×60cm 1枚")).toEqual({ total: 1, unit: "枚" });
  });

  it("寸法が2つスラッシュで並ぶ表記でも枚数を採用する", () => {
    expect(extractCapacityTotal("40×60cm / 50×80cm 1枚")).toEqual({ total: 1, unit: "枚" });
  });

  it("mm 表記の寸法も除去する", () => {
    expect(extractCapacityTotal("400×800mm 1枚")).toEqual({ total: 1, unit: "枚" });
  });

  it("寸法のあとの「N枚入」を解析する", () => {
    expect(extractCapacityTotal("38cm×80cm 2枚入")).toEqual({ total: 2, unit: "枚" });
  });

  it("スラッシュ区切りで個数が続く表記を解析する", () => {
    expect(extractCapacityTotal("16cm / 1個")).toEqual({ total: 1, unit: "個" });
  });

  it("「約」付きの容量を解析する", () => {
    expect(extractCapacityTotal("18cm / 約1.3L")).toEqual({ total: 1.3, unit: "L" });
  });

  it("小数の寸法を含んでも容量側を解析する", () => {
    expect(extractCapacityTotal("21.5cm / 約0.98L")).toEqual({ total: 0.98, unit: "L" });
  });
});

// ─── パターン6: 替刃 ────────────────────────────────────────────────────
describe("extractCapacityTotal / 本体＋替刃は替刃側を分母にする", () => {
  it("本体1個＋替刃16個 は替刃の16個を採用する（本体の1個ではない）", () => {
    expect(extractCapacityTotal("本体1個＋替刃16個")).toEqual({ total: 16, unit: "個" });
  });

  it("替刃8個 を解析する", () => {
    expect(extractCapacityTotal("替刃8個")).toEqual({ total: 8, unit: "個" });
  });

  it("「替え」表記も解析する", () => {
    expect(extractCapacityTotal("本体+替え24個")).toEqual({ total: 24, unit: "個" });
  });
});

// ─── パターン7: 先頭ラベル除去 ──────────────────────────────────────────
describe("extractCapacityTotal / 先頭ラベルを除去して解析する", () => {
  it("サイズ名が先頭に付く表記を解析する", () => {
    expect(extractCapacityTotal("レギュラー 800枚")).toEqual({ total: 800, unit: "枚" });
  });

  it("空白なしのサイズ名も解析する", () => {
    expect(extractCapacityTotal("スーパーワイド100枚")).toEqual({ total: 100, unit: "枚" });
  });

  it("括弧内は内訳なので総量として採用しない", () => {
    // "（25枚×4パック）" は内訳。100枚が総量であり 25枚 ではない
    expect(extractCapacityTotal("スーパーワイド 100枚（25枚×4パック）")).toEqual({
      total: 100,
      unit: "枚",
    });
  });

  it("括弧内の内訳が総量と一致する場合も総量を採用する", () => {
    expect(extractCapacityTotal("レギュラー 1200枚（100枚×12パック）")).toEqual({
      total: 1200,
      unit: "枚",
    });
  });

  it("Mサイズ 1個 を解析する", () => {
    expect(extractCapacityTotal("Mサイズ 1個")).toEqual({ total: 1, unit: "個" });
  });

  it("サイズ違いをスラッシュで並べた表記は解析しない（総量が定まらない）", () => {
    expect(extractCapacityTotal("新生児144枚/S132枚/M132枚")).toBeNull();
    expect(extractCapacityTotal("新生児144枚/S132枚/M116枚")).toBeNull();
  });
});

// ─── 単位辞書の拡張 ─────────────────────────────────────────────────────
describe("extractCapacityTotal / 追加した単位", () => {
  it("「周」を単位として扱う", () => {
    expect(extractCapacityTotal("70周×8袋")).toEqual({ total: 560, unit: "周" });
  });

  it("「足」を単位として扱う", () => {
    expect(extractCapacityTotal("6足")).toEqual({ total: 6, unit: "足" });
  });
});

// ─── 括弧パターンの「計」許容 ───────────────────────────────────────────
describe("extractCapacityTotal / 括弧内の合計表記", () => {
  it("「（計20g）」を総量として抽出する", () => {
    expect(extractCapacityTotal("パウダー5g + ペースト15g（計20g）")).toEqual({
      total: 20,
      unit: "g",
    });
  });
});

// ─── 回帰: 既存の挙動を壊さない ─────────────────────────────────────────
describe("extractCapacityTotal / 回帰", () => {
  it("数字を含まない表記は null のまま", () => {
    expect(extractCapacityTotal("詰め替え用")).toBeNull();
  });

  it("容量情報が無いハイフンは null のまま", () => {
    expect(extractCapacityTotal("-")).toBeNull();
  });

  it("括弧内の「組」を総量と誤認しない", () => {
    expect(extractCapacityTotal("500枚(250組)")).toEqual({ total: 500, unit: "枚" });
  });

  it("括弧内が「N巻M周」でも先頭の巻数を採用する", () => {
    expect(extractCapacityTotal("3巻（1巻70周）")).toEqual({ total: 3, unit: "巻" });
  });

  it("括弧内総量パターンは従来どおり優先される", () => {
    expect(extractCapacityTotal("70カット×16ロール（1120枚）")).toEqual({
      total: 1120,
      unit: "枚",
    });
  });

  it("フォールバックは既存パターンが成立する場合には走らない", () => {
    // "1200mL×2袋" はパターン2で確定するため、寸法除去やラベル除去に到達しない
    expect(extractCapacityTotal("1200mL×2袋")).toEqual({ total: 2400, unit: "mL" });
  });
});

// ─── calcPricePerUnit ───────────────────────────────────────────────────
describe("calcPricePerUnit / フォールバック経由の単価", () => {
  it("ペットシーツの単価を計算する", () => {
    // 4280 / 800 = 5.35。toFixed(1) は二進浮動小数の丸めで "5.3" になる
    expect(calcPricePerUnit(4280, "レギュラー 800枚")).toBe("約5.3円/枚");
  });

  it("ラップの単価を計算する", () => {
    expect(calcPricePerUnit(455, "30cm×50m")).toBe("約9.1円/m");
  });

  it("替刃の単価は本体を分母に含めない", () => {
    expect(calcPricePerUnit(3546, "本体1個＋替刃16個")).toBe("約222円/個");
  });

  it("解析できない容量では null を返す", () => {
    expect(calcPricePerUnit(1000, "-")).toBeNull();
  });
});
