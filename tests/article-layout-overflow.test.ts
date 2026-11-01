import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// 記事ページの横あふれ防止の目印（計画書 IMPLEMENTATION_PLAN_ARTICLE_GRID_OVERFLOW_2026-10-31.md §4-4）
// レイアウトの実動作は Vitest で測れないので、壊すと気づけないクラスだけをソースで検査する
function read(...segments: string[]): string {
  return readFileSync(path.join(__dirname, "..", "src", ...segments), "utf-8");
}

const layout = read("layouts", "ArticleLayout.astro");
const productCard = read("components", "product", "ProductCard.astro");
const comparisonTable = read("components", "product", "ComparisonTableSort.tsx");
const serviceTable = read("components", "service", "ServiceTable.astro");

// ボタンは w-full なので、flex-wrap だけ足すと全幅で縦積みになる
const buttonRow = /sm:flex-row sm:flex-wrap sm:\[&>a\]:w-auto sm:\[&>a\]:flex-1/;

describe("記事ページの横あふれ防止", () => {
  it("<article> は min-w-0 でグリッドの列を押し広げない", () => {
    expect(layout).toContain('<article class="min-w-0">');
  });

  it("商品カードのボタン行は、幅を上書きしたうえで折り返す", () => {
    expect(productCard).toMatch(buttonRow);
  });

  it("「この記事の結論」はボタンに押されて文字列が潰れない", () => {
    expect(layout).toMatch(buttonRow);
    expect(layout).toContain("flex-1 min-w-0 sm:min-w-[240px]");
  });

  it("サービスカードは本文列が狭い幅で2列にしない", () => {
    expect(layout).toContain("grid grid-cols-1 xl:grid-cols-2 gap-6");
  });

  it("比較表の容量は折り返せる", () => {
    const cell = comparisonTable.match(/<div class="[^"]*">\{p\.capacity\}<\/div>/);
    expect(cell).not.toBeNull();
    expect(cell![0]).not.toContain("whitespace-nowrap");
  });

  it("PC の比較表は容量とコスパを1列にまとめ、コスパで並べ替えられる", () => {
    const th = comparisonTable.match(/<th[\s\S]*?容量・コスパ/);
    expect(th).not.toBeNull();
    const merged = th![0].slice(th![0].lastIndexOf("<th"));
    expect(merged).toContain('handleSort("pricePerUnit")');
    expect(merged).toContain('ariaSortAttr("pricePerUnit")');
    expect(comparisonTable).not.toMatch(/>容量<\/th>/);
    // コスパと容量が同じセルにある（間に <td が入らない）
    const cell = comparisonTable.match(/\{unit\}[\s\S]*?\{p\.capacity\}/);
    expect(cell).not.toBeNull();
    expect(cell![0]).not.toContain("<td");
  });

  it("統合列の見出しは矢印が出ても広がらず、商品名は4行まで見える", () => {
    // 126px を下回ると、並べ替えたときだけ列幅が変わる
    expect(comparisonTable).toContain("min-w-[126px]");
    expect(comparisonTable).toContain("line-clamp-4 hover:line-clamp-none");
  });

  it("サービス比較表の詳細列は横スクロールしても右端に残る", () => {
    expect(serviceTable.match(/md:sticky md:right-0/g)).toHaveLength(2);
  });
});
