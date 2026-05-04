// フロントマター解析・更新ユーティリティ

/**
 * Markdownファイルのフロントマターから products 配列の name を抽出する
 */
export function extractProductNames(content: string): string[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [];

  const names: string[] = [];
  const nameRe = /^    name:\s*"(.+?)"\r?$/gm;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(match[1])) !== null) {
    names.push(m[1]);
  }
  return names;
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
}

/**
 * フロントマター内の特定商品ブロックのフィールドを更新する
 */
export function updateProductInFrontmatter(
  content: string,
  productName: string,
  updates: ProductUpdates
): string {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return content;

  const prefix = fmMatch[1];
  let fm = fmMatch[2];
  const suffix = fmMatch[3];
  const rest = content.slice(prefix.length + fm.length + suffix.length);

  const nameIdx = fm.indexOf(`    name: "${productName}"`);
  if (nameIdx === -1) {
    return content;
  }

  const blockStart = fm.lastIndexOf("  - rank:", nameIdx);
  if (blockStart === -1) return content;

  const nextBlockIdx = fm.indexOf("  - rank:", blockStart + 1);
  const blockEnd = nextBlockIdx === -1 ? fm.length : nextBlockIdx;

  let block = fm.slice(blockStart, blockEnd);

  if (updates.price !== null) {
    block = block.replace(/^    price: .+$/m, `    price: ${updates.price}`);
  }
  if (updates.rating !== null) {
    block = block.replace(/^    rating: .+$/m, `    rating: ${updates.rating}`);
  }
  if (updates.reviewCount !== null) {
    block = block.replace(
      /^    reviewCount: .+$/m,
      `    reviewCount: ${updates.reviewCount}`
    );
  }
  if (updates.affiliateUrl) {
    block = block.replace(
      /^    rakutenUrl: ".+"$/m,
      `    rakutenUrl: "${updates.affiliateUrl}"`
    );
  }
  if (updates.imageUrl) {
    block = block.replace(
      /^    imageUrl: ".*"$/m,
      `    imageUrl: "${updates.imageUrl}"`
    );
  }
  if (updates.pricePerUnit != null) {
    block = block.replace(
      /^    pricePerUnit: ".+"$/m,
      `    pricePerUnit: "${updates.pricePerUnit}"`
    );
  }

  fm = fm.slice(0, blockStart) + block + fm.slice(blockEnd);
  return prefix + fm + suffix + rest;
}

/**
 * フロントマター内の特定商品の capacity フィールドの値を取得する
 */
export function extractProductCapacity(content: string, productName: string): string | null {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1];
  const nameIdx = fm.indexOf(`    name: "${productName}"`);
  if (nameIdx === -1) return null;

  const blockStart = fm.lastIndexOf("  - rank:", nameIdx);
  if (blockStart === -1) return null;

  const nextBlockIdx = fm.indexOf("  - rank:", blockStart + 1);
  const blockEnd = nextBlockIdx === -1 ? fm.length : nextBlockIdx;
  const block = fm.slice(blockStart, blockEnd);

  const m = block.match(/^    capacity:\s*"(.+?)"$/m);
  return m ? m[1] : null;
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
