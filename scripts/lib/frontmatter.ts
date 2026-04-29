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
      /^    imageUrl: ".+"$/m,
      `    imageUrl: "${updates.imageUrl}"`
    );
  }

  fm = fm.slice(0, blockStart) + block + fm.slice(blockEnd);
  return prefix + fm + suffix + rest;
}
