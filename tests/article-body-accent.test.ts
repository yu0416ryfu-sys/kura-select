import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// 記事本文の青アクセント（計画書 IMPLEMENTATION_PLAN_article-body-accent-2026-10-24.md §3-3）
const css = readFileSync(path.join(__dirname, "..", "src", "styles", "global.css"), "utf-8");
const layout = readFileSync(path.join(__dirname, "..", "src", "layouts", "ArticleLayout.astro"), "utf-8");

function readToken(name: string): string {
  const m = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`${name} が global.css に無い`);
  return m[1];
}

// WCAG 2.x の相対輝度
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("記事本文の青アクセント", () => {
  it("--color-primary-strong は白と surface に対して 4.5:1 以上", () => {
    const strong = readToken("--color-primary-strong");
    expect(contrast(strong, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(strong, readToken("--color-surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("ArticleLayout の本文コンテナに article-body クラスがある", () => {
    expect(layout).toMatch(/<div class="article-body [^"]*"[^>]*>\s*<slot \/>/);
  });

  it("li の間隔は utility 側の [&_li]:mb-2（独立したクラスとして書かれている）", () => {
    expect(layout).toMatch(/\s\[&_li\]:mb-2\s/);
  });

  it("global.css に .article-body ul の list-style 指定がある", () => {
    expect(css).toMatch(/\.article-body ul\s*\{[^}]*list-style:\s*disc/);
  });
});
