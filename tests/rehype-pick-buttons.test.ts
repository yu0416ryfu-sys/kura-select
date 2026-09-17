import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import {
  parsePickMarker,
  resolvePickItems,
  transformPickButtons,
  type PickProduct,
} from "../src/lib/markdown/rehype-pick-buttons";

const products: PickProduct[] = [
  { rank: 1, name: "ドでか無香空間 無香料 つめ替用 1600g", rakutenUrl: "https://example.test/a" },
  { rank: 2, name: "消臭力 イオン消臭プラス 詰め替え 1.5kg", rakutenUrl: "https://example.test/b" },
  { rank: 3, name: "無香空間 本体 315g", rakutenUrl: "https://example.test/c" },
];

const fileWith = (p: unknown) => ({ data: { astro: { frontmatter: { products: p } } } });

const rawMarker = { type: "raw", value: '<!-- kura:pick-buttons items="ドでか無香空間;イオン消臭プラス" -->' };
const commentMarker = { type: "comment", value: ' kura:pick-buttons items="ドでか無香空間;イオン消臭プラス" ' };

// hast 要素から a 要素を集める
function findAll(node: any, tag: string, out: any[] = []): any[] {
  if (node?.type === "element" && node.tagName === tag) out.push(node);
  for (const c of node?.children ?? []) findAll(c, tag, out);
  return out;
}

describe("resolvePickItems", () => {
  it("部分文字列で rank 昇順の最初の商品を選ぶ", () => {
    const r = resolvePickItems(products, ["無香空間", "イオン消臭プラス"], () => {});
    expect(r.map((p) => p.rank)).toEqual([1, 2]);
  });

  it("rank の並びが変わっても同じ商品名を指す", () => {
    const shuffled = [
      { ...products[1], rank: 1 },
      { ...products[0], rank: 2 },
      products[2],
    ];
    const r = resolvePickItems(shuffled, ["ドでか無香空間", "イオン消臭プラス"], () => {});
    expect(r.map((p) => p.name)).toEqual([products[0].name, products[1].name]);
  });

  it("一致が無い項目は除外して warn を出す", () => {
    const warn = vi.fn();
    const r = resolvePickItems(products, ["存在しない", "イオン消臭プラス"], warn);
    expect(r).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("parsePickMarker", () => {
  it("raw ノードと comment ノードの両方を検出する", () => {
    expect(parsePickMarker(rawMarker)).toEqual(["ドでか無香空間", "イオン消臭プラス"]);
    expect(parsePickMarker(commentMarker)).toEqual(["ドでか無香空間", "イオン消臭プラス"]);
  });

  it("他のコメント・raw は対象外", () => {
    expect(parsePickMarker({ type: "comment", value: " ふつうのコメント " })).toBeNull();
    expect(parsePickMarker({ type: "raw", value: "<div>kura:pick-buttons items=\"x\"</div>" })).toBeNull();
    expect(parsePickMarker({ type: "text", value: 'kura:pick-buttons items="x"' })).toBeNull();
  });
});

describe("transformPickButtons", () => {
  it("マーカーが無い木は変更しない", () => {
    const tree = {
      type: "root",
      children: [
        { type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: "本文" }] },
        { type: "comment", value: " 別のコメント " },
      ],
    };
    const before = structuredClone(tree);
    expect(transformPickButtons(tree, fileWith(products))).toBe(0);
    expect(tree).toEqual(before);
  });

  it("frontmatter が無い（MDX 想定）場合は例外を投げず木をそのまま返す", () => {
    const tree = { type: "root", children: [{ ...rawMarker }] };
    const before = structuredClone(tree);
    expect(() => transformPickButtons(tree, {}, () => {})).not.toThrow();
    expect(tree).toEqual(before);
    expect(() => transformPickButtons(tree, undefined, () => {})).not.toThrow();
  });

  for (const marker of [rawMarker, commentMarker]) {
    it(`${marker.type} マーカーを楽天ボタン2件に置き換える`, () => {
      const tree = { type: "root", children: [{ type: "element", tagName: "div", properties: {}, children: [{ ...marker }] }] };
      expect(transformPickButtons(tree, fileWith(products), () => {})).toBe(1);
      const links = findAll(tree, "a");
      expect(links).toHaveLength(2);
      for (const a of links) {
        expect(a.properties.rel).toEqual(["sponsored", "nofollow", "noopener"]);
        expect(a.properties.target).toBe("_blank");
        expect(a.properties.dataGaPlacement).toBe("verdict_cta");
        expect(a.properties.dataGaEvent).toBe("click_rakuten_link");
        expect(a.properties.dataGaProvider).toBe("rakuten");
      }
      expect(links.map((a) => a.properties.href)).toEqual(["https://example.test/a", "https://example.test/b"]);
      expect(links[0].properties.dataGaProduct).toBe(products[0].name);
    });
  }
});

describe("実記事: mukokukan-vs-shoshuriki-comparison", () => {
  it("マーカーの全項目が現在の products[] で解決できる", () => {
    const md = readFileSync("src/content/articles/mukokukan-vs-shoshuriki-comparison.md", "utf8");
    const fm = yaml.load(md.split(/^---\s*$/m)[1]) as { products: PickProduct[] };
    const markers = [...md.matchAll(/<!--\s*kura:pick-buttons[^>]*-->/g)].map((m) =>
      parsePickMarker({ type: "raw", value: m[0] })
    );
    expect(markers).toHaveLength(1);
    const items = markers[0]!;
    const warn = vi.fn();
    const resolved = resolvePickItems(fm.products, items, warn);
    expect(warn).not.toHaveBeenCalled();
    expect(resolved).toHaveLength(items.length);
  });
});
