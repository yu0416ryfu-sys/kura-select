// フロントマター解析・更新ユーティリティ
import yaml from 'js-yaml';

// フロントマターを YAML としてパースし、data と body に分割する
function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
  if (!match) return null;
  try {
    const data = (yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>) ?? {};
    return { data, body: match[2] };
  } catch (e) {
    console.warn('YAML parse failed:', (e as Error).message);
    return null;
  }
}

// data を YAML に変換して Markdown フロントマターとして組み立てる
function dumpFrontmatter(data: Record<string, unknown>, body: string): string {
  const fm = yaml.dump(data, {
    indent: 2,
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: true,
    noRefs: true,
    noCompatMode: true,
    schema: yaml.JSON_SCHEMA,
    sortKeys: false,
  });
  return '---\n' + fm.trimEnd() + '\n---' + body;
}

/**
 * Markdownファイルのフロントマターから products 配列の name を抽出する
 */
export function extractProductNames(content: string): string[] {
  const parsed = parseFrontmatter(content);
  if (!parsed) return [];
  const products = parsed.data.products;
  if (!Array.isArray(products)) return [];
  return products.map((p: unknown) => (p as { name: string }).name).filter(Boolean);
}

/**
 * 商品名から楽天API検索キーワードを生成する（長すぎると0件になるため短縮）
 */
export function buildSearchKeyword(productName: string): string {
  let kw = productName
    .replace(/\s*[（(].+?[）)]/g, "")
    .replace(/\s*\d+[mMlLgG枚本袋個入パック巻]+.*$/g, "")
    .replace(/\s*(×|x|X)\s*\d+.*$/g, "")
    .replace(/\s*(大容量|超大型|超特大|特大|大型|レギュラー|ミニ)/g, "")
    .trim();

  if (kw.length > 40) {
    kw = kw.slice(0, 40);
  }

  if (kw.length < 3) {
    kw = productName.slice(0, 30);
  }

  return kw;
}

export interface ProductUpdates {
  price: number | null;
  rating: number | null;
  reviewCount: number | null;
  affiliateUrl: string | null;
  imageUrl: string | null;
  pricePerUnit?: string | null;
  newName?: string;     // name フィールドを置き換え（検索キーワード兼用）
  newCapacity?: string; // capacity フィールドを置き換え
}

/**
 * フロントマター内の特定商品ブロックのフィールドを更新する
 */
export function updateProductInFrontmatter(
  content: string,
  productName: string,
  updates: ProductUpdates
): string {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) return content;

  type P = Record<string, unknown>;
  const product = (parsed.data.products as P[]).find(p => p.name === productName);
  if (!product) return content;

  if (updates.price !== null)        product.price = updates.price;
  if (updates.rating !== null)       product.rating = updates.rating;
  if (updates.reviewCount !== null)  product.reviewCount = updates.reviewCount;
  if (updates.affiliateUrl)          product.rakutenUrl = updates.affiliateUrl;
  if (updates.imageUrl)              product.imageUrl = updates.imageUrl;
  if (updates.pricePerUnit != null)  product.pricePerUnit = updates.pricePerUnit;
  if (updates.newName)               product.name = updates.newName;
  if (updates.newCapacity)           product.capacity = updates.newCapacity;

  return dumpFrontmatter(parsed.data, parsed.body);
}

/**
 * フロントマター内の特定商品の capacity フィールドの値を取得する
 */
export function extractProductCapacity(content: string, productName: string): string | null {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) return null;
  const product = (parsed.data.products as Array<{ name: string; capacity?: string }>)
    .find(p => p.name === productName);
  return product?.capacity ?? null;
}

const CAPACITY_UNITS = 'mL|ml|kg|L|g|m|枚|本|個|袋|巻|回|粒';

/**
 * capacity フィールドの文字列から総量と単位を抽出する
 * 例: "60枚×48個（2,880枚）"         → { total: 2880, unit: "枚" }
 * 例: "43枚×8個×4セット（1,376枚）"  → { total: 1376, unit: "枚" }
 * 例: "660mL×2個"                   → { total: 1320, unit: "mL" }
 * 例: "30枚（携帯用）"               → { total: 30,   unit: "枚" }
 * 例: "500g"                        → { total: 500,  unit: "g"  }
 */
export function extractCapacityTotal(capacity: string): { total: number; unit: string } | null {
  // パターン1: 括弧内に明示された総量 "（1,376枚）"（最も信頼性が高い）
  const bracketRe = new RegExp(`[（(]([\\d,]+)\\s*(${CAPACITY_UNITS})[）)]`);
  const bracketM = capacity.match(bracketRe);
  if (bracketM) {
    const total = parseInt(bracketM[1].replace(/,/g, ''), 10);
    if (total > 0) return { total, unit: bracketM[2] };
  }

  // パターン2: "数値unit×数値" の掛け算 "660mL×2個"
  const mulRe = new RegExp(`^([\\d,]+)\\s*(${CAPACITY_UNITS})\\s*[×xX]\\s*([\\d,]+)`);
  const mulM = capacity.match(mulRe);
  if (mulM) {
    const perPack = parseInt(mulM[1].replace(/,/g, ''), 10);
    const count = parseInt(mulM[3].replace(/,/g, ''), 10);
    if (perPack > 0 && count > 0) return { total: perPack * count, unit: mulM[2] };
  }

  // パターン3: シンプルな単位 "30枚" "500g"
  const simpleRe = new RegExp(`^([\\d,]+)\\s*(${CAPACITY_UNITS})`);
  const simpleM = capacity.match(simpleRe);
  if (simpleM) {
    const total = parseInt(simpleM[1].replace(/,/g, ''), 10);
    if (total > 0) return { total, unit: simpleM[2] };
  }

  return null;
}

/**
 * price と capacity から pricePerUnit 文字列を計算する
 * 例: (7480, "60枚×48個（2,880枚）") → "約2.6円/枚"
 * 例: (250,  "30枚（携帯用）")        → "約8.3円/枚"
 */
export function calcPricePerUnit(price: number, capacity: string): string | null {
  const extracted = extractCapacityTotal(capacity);
  if (!extracted) return null;

  const perUnit = price / extracted.total;
  let formatted: string;
  if (perUnit >= 10) {
    formatted = Math.round(perUnit).toString();
  } else if (perUnit >= 1) {
    formatted = perUnit.toFixed(1);
  } else {
    formatted = perUnit.toFixed(2);
  }

  return `約${formatted}円/${extracted.unit}`;
}

/**
 * 楽天商品名から容量文字列を抽出する（extractCapacityTotal で解析可能な形式で返す）
 * 例: "スコッティ 200枚×5箱"      → "200枚×5箱"
 * 例: "ネピア 60枚（2,880枚）"    → "（2,880枚）"
 * 例: "ビオレ ボディウォッシュ 500mL" → "500mL"
 */
export function extractCapacityFromItemName(itemName: string): string | null {
  // パターン1: 掛け算 "200枚×5箱"（楽天名内を検索）
  const mulRe = new RegExp(`(\\d[\\d,]*)\\s*(${CAPACITY_UNITS})\\s*[×xX]\\s*(\\d[\\d,]*)\\s*(${CAPACITY_UNITS})?`);
  const mulM = itemName.match(mulRe);
  if (mulM) {
    const base = `${mulM[1]}${mulM[2]}×${mulM[3]}`;
    return mulM[4] ? `${base}${mulM[4]}` : base;
  }

  // パターン2: 括弧内総量 "（2,880枚）"
  const bracketRe = new RegExp(`[（(]([\\d,]+)\\s*(${CAPACITY_UNITS})[）)]`);
  const bracketM = itemName.match(bracketRe);
  if (bracketM) {
    return `（${bracketM[1]}${bracketM[2]}）`;
  }

  // パターン3: シンプル "500mL"（最初に見つかる数値+単位）
  const simpleRe = new RegExp(`(\\d[\\d,]*)\\s*(${CAPACITY_UNITS})`);
  const simpleM = itemName.match(simpleRe);
  if (simpleM) {
    return `${simpleM[1]}${simpleM[2]}`;
  }

  return null;
}

/**
 * フロントマターから指定商品ブロックを削除し、残りの rank を振り直す。
 * 最後の1商品の場合は削除せず null を返す。
 */
export function removeProductFromFrontmatter(content: string, productName: string): string | null {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) return null;

  type P = Record<string, unknown>;
  const products = parsed.data.products as P[];
  if (products.length <= 1) return null;

  const idx = products.findIndex(p => p.name === productName);
  if (idx === -1) return null;

  products.splice(idx, 1);
  products.forEach((p, i) => { p.rank = i + 1; });
  return dumpFrontmatter(parsed.data, parsed.body);
}

/**
 * フロントマターの updatedAt フィールドを指定日付で更新する（YYYY-MM-DD 形式）
 * updatedAt が存在しない場合は publishedAt の直後に挿入する
 */
export function updateUpdatedAt(content: string, date: string): string {
  if (/^updatedAt:\s+\S+/m.test(content)) {
    return content.replace(/^(updatedAt:)\s+\S+/m, `$1 ${date}`);
  }
  if (/^publishedAt:\s+\S+/m.test(content)) {
    return content.replace(/^(publishedAt:\s+\S+)/m, `$1\nupdatedAt: ${date}`);
  }
  // どちらもない場合はフロントマター末尾の closing --- 直前に追加
  return content.replace(/^(---\s*)$/m, `updatedAt: ${date}\n$1`);
}

/**
 * フロントマター内の全商品を pricePerUnit の安い順に並び替え、rank を振り直す。
 * 有効な pricePerUnit が2件未満、または単位が混在する場合はスキップ。
 */
export function reorderProductsByPricePerUnit(
  content: string
): { content: string; changed: boolean; log: string[] } {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) return { content, changed: false, log: [] };

  type P = Record<string, unknown>;
  const products = parsed.data.products as P[];
  if (products.length <= 1) return { content, changed: false, log: [] };

  const ppuRe = /約?([\d.]+)円\/(.+)/;
  const blockInfos = products.map((p, origIdx) => {
    const ppu = typeof p.pricePerUnit === 'string' ? p.pricePerUnit.match(ppuRe) : null;
    const ppuValue = ppu ? parseFloat(ppu[1]) : Infinity;
    return {
      product: p,
      ppuValue: isNaN(ppuValue) || ppuValue === 0 ? Infinity : ppuValue,
      unit: ppu?.[2] ?? '',
      origIdx,
      name: String(p.name ?? ''),
    };
  });

  const validBlocks = blockInfos.filter(b => b.ppuValue !== Infinity);
  if (validBlocks.length <= 1) return { content, changed: false, log: [] };

  const units = new Set(validBlocks.map(b => b.unit));
  if (units.size > 1) {
    return { content, changed: false, log: [`単位が混在しているため並び替えをスキップ: ${[...units].join(', ')}`] };
  }

  const sorted = [...blockInfos].sort((a, b) => a.ppuValue - b.ppuValue);
  const changed = sorted.some((b, i) => b.origIdx !== blockInfos[i].origIdx);
  if (!changed) return { content, changed: false, log: [] };

  const log: string[] = [];
  sorted.forEach((b, newIdx) => {
    b.product.rank = newIdx + 1;
    if (b.origIdx !== newIdx) log.push(`rank ${b.origIdx + 1} → rank ${newIdx + 1}: ${b.name}`);
  });
  parsed.data.products = sorted.map(b => b.product);
  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true, log };
}
