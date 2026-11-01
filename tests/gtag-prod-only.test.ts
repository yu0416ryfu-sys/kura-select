import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// gtag を本番ドメインだけで送信する（計画書 IMPLEMENTATION_PLAN_GTAG_PROD_ONLY_2026-10-31.md §3）
// 分岐を誤ると本番の GA4 が止まるので、否定と代入の位置まで固定して検査する
const layout = readFileSync(path.join(__dirname, "..", "src", "layouts", "BaseLayout.astro"), "utf-8");

const branch = layout.match(
  /if \(!\/(.+)\/\.test\(location\.hostname\)\) \{\s*window\['ga-disable-G-9ZPLHX62KS'\] = true;\s*\}/
);

describe("gtag の本番ドメイン限定", () => {
  it("無効化フラグは本番ドメイン以外のときだけ立てる", () => {
    expect(branch).not.toBeNull();
    expect(layout.match(/ga-disable-G-9ZPLHX62KS/g)).toHaveLength(1);
  });

  it("無効化フラグは gtag の最初の呼び出しより前に立てる", () => {
    expect(layout.indexOf("ga-disable-G-9ZPLHX62KS")).toBeLessThan(layout.indexOf("gtag('js'"));
  });

  it("本番ドメインだけが判定に一致する", () => {
    const production = new RegExp(branch![1]);
    for (const host of ["www.kura-select.com", "kura-select.com"]) {
      expect(production.test(host)).toBe(true);
    }
    for (const host of ["localhost", "127.0.0.1", "evil-kura-select.com", "kura-select.com.example.com"]) {
      expect(production.test(host)).toBe(false);
    }
  });
});
