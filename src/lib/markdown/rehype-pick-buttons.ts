import {
  AFFILIATE_ICON_CLASS,
  AFFILIATE_ICON_PATH,
  EXTERNAL_ICON_CLASS,
  EXTERNAL_ICON_PATH,
  buildAffiliateLinkAttrs,
} from "../affiliate-link";

// 本文の HTML コメントマーカーを、商品ごとの楽天ボタン（2択など）に置き換える rehype プラグイン。
//   <!-- kura:pick-buttons items="ドでか無香空間;イオン消臭プラス" -->
// items は `;` 区切りの部分文字列。products[] を rank 昇順に見て、name に含む最初の商品を選ぶ
// （cron の価格更新で rank が入れ替わっても同じ商品を指すよう、rank では指定しない）。
// マーカーが無い記事では何もしない。解決できない項目は描画せず warn だけ出す（ビルドは止めない）。

export const PICK_BUTTONS_PLACEMENT = "verdict_cta";

const MARKER_RE = /^\s*(?:<!--)?\s*kura:pick-buttons\s+items="([^"]*)"\s*(?:-->)?\s*$/;

// 依存を増やさないための最小限の hast 型
interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
}
interface HastOther {
  type: string;
  value?: string;
  children?: HastNode[];
}
type HastNode = HastText | HastElement | HastOther;
interface HastParent {
  type: string;
  children: HastNode[];
}

export interface PickProduct {
  rank: number;
  name: string;
  rakutenUrl?: string;
}

type Warn = (message: string) => void;

const defaultWarn: Warn = (message) => console.warn(`[rehype-pick-buttons] ${message}`);

/** マーカーなら items 配列を返す。raw（`<!-- ... -->` 込み）と comment（中身のみ）の両方を扱う */
export function parsePickMarker(node: { type: string; value?: string }): string[] | null {
  if ((node.type !== "raw" && node.type !== "comment") || typeof node.value !== "string") return null;
  if (node.type === "raw" && !node.value.trim().startsWith("<!--")) return null;
  const m = node.value.match(MARKER_RE);
  if (!m) return null;
  return m[1]
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function resolvePickItems(
  products: readonly PickProduct[],
  items: readonly string[],
  warn: Warn = defaultWarn
): PickProduct[] {
  const sorted = [...products].sort((a, b) => a.rank - b.rank);
  const resolved: PickProduct[] = [];
  for (const item of items) {
    const hit = sorted.find((p) => p.name.includes(item) && Boolean(p.rakutenUrl));
    if (hit) {
      resolved.push(hit);
    } else {
      warn(`items="${item}" に一致する商品（rakutenUrl あり）が見つからないため描画しません`);
    }
  }
  return resolved;
}

function el(tagName: string, properties: Record<string, unknown>, children: HastNode[] = []): HastElement {
  return { type: "element", tagName, properties, children };
}

function renderButton(product: PickProduct): HastElement {
  const attrs = buildAffiliateLinkAttrs({
    href: product.rakutenUrl!,
    provider: "rakuten",
    productName: product.name,
    gaPlacement: PICK_BUTTONS_PLACEMENT,
  });
  const dataset: Record<string, string> = {
    dataGaEvent: attrs.dataset.gaEvent,
    dataGaProvider: attrs.dataset.gaProvider,
  };
  if (attrs.dataset.gaProduct) dataset.dataGaProduct = attrs.dataset.gaProduct;
  if (attrs.dataset.gaPlacement) dataset.dataGaPlacement = attrs.dataset.gaPlacement;

  return el(
    "a",
    {
      href: attrs.href,
      rel: attrs.rel.split(" "),
      target: attrs.target,
      ariaLabel: attrs.ariaLabel,
      // 本文コンテナの [&_a] 下線・文字色を打ち消す（AffiliateLink.astro 側の HTML は変えない）
      className: [...attrs.className.split(" "), "no-underline!", "text-white!"],
      ...dataset,
    },
    [
      el("svg", { className: AFFILIATE_ICON_CLASS.split(" "), fill: "currentColor", viewBox: "0 0 24 24", ariaHidden: "true" }, [
        el("path", { d: AFFILIATE_ICON_PATH }),
      ]),
      { type: "text", value: attrs.label },
      el(
        "svg",
        { className: EXTERNAL_ICON_CLASS.split(" "), fill: "none", stroke: "currentColor", viewBox: "0 0 24 24", ariaHidden: "true" },
        [el("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2", d: EXTERNAL_ICON_PATH })]
      ),
    ]
  );
}

export function renderPickButtons(products: readonly PickProduct[]): HastElement {
  return el(
    "div",
    { className: ["grid", "grid-cols-1", "sm:grid-cols-2", "gap-3", "my-6"], dataPickButtons: "" },
    products.map((product) =>
      el("div", { className: ["flex", "flex-col", "justify-between", "gap-3", "rounded-lg", "border", "border-[var(--color-border)]", "p-4"] }, [
        el("p", { className: ["text-sm", "font-semibold", "text-[var(--color-text)]", "mb-0!"] }, [
          { type: "text", value: product.name },
        ]),
        renderButton(product),
      ])
    )
  );
}

function getProducts(file: unknown): PickProduct[] | null {
  const products = (file as { data?: { astro?: { frontmatter?: { products?: unknown } } } } | undefined)?.data?.astro
    ?.frontmatter?.products;
  if (!Array.isArray(products)) return null;
  return products.filter(
    (p): p is PickProduct => typeof p === "object" && p !== null && typeof (p as PickProduct).name === "string"
  );
}

function hasChildren(node: HastNode | HastParent): node is HastParent {
  return Array.isArray((node as HastParent).children);
}

/** マーカーを置き換えた件数を返す。マーカーが無ければ木は変更しない */
export function transformPickButtons(tree: HastParent, file: unknown, warn: Warn = defaultWarn): number {
  let products: PickProduct[] | null | undefined;
  let count = 0;

  const walk = (parent: HastParent) => {
    for (let i = 0; i < parent.children.length; i++) {
      const node = parent.children[i];
      const items = parsePickMarker(node as { type: string; value?: string });
      if (items) {
        // frontmatter は最初のマーカーを見つけたときだけ読む（MDX などで無ければ何もしない）
        if (products === undefined) products = getProducts(file);
        if (!products) {
          warn("frontmatter.products が取得できないためマーカーを無視します");
          continue;
        }
        const resolved = resolvePickItems(products, items, warn);
        parent.children[i] = resolved.length > 0 ? renderPickButtons(resolved) : { type: "text", value: "" };
        count++;
        continue;
      }
      if (hasChildren(node)) walk(node);
    }
  };
  walk(tree);
  return count;
}

export default function rehypePickButtons() {
  return (tree: HastParent, file: unknown) => {
    transformPickButtons(tree, file);
  };
}
