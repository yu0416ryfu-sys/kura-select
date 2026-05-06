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
  // name/capacity は他フィールドより後に処理（ブロック特定は旧名で済んでいる）
  if (updates.newName) {
    block = block.replace(/^    name: ".+"$/m, `    name: "${updates.newName}"`);
  }
  if (updates.newCapacity) {
    block = block.replace(/^    capacity: ".+"$/m, `    capacity: "${updates.newCapacity}"`);
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
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return null;

  const prefix = fmMatch[1];
  let fm = fmMatch[2];
  const suffix = fmMatch[3];
  const rest = content.slice(prefix.length + fm.length + suffix.length);

  // 最後の1商品は削除しない
  const rankCount = (fm.match(/^  - rank:/gm) ?? []).length;
  if (rankCount <= 1) return null;

  const nameIdx = fm.indexOf(`    name: "${productName}"`);
  if (nameIdx === -1) return null;

  const blockStart = fm.lastIndexOf('  - rank:', nameIdx);
  if (blockStart === -1) return null;

  const nextBlockIdx = fm.indexOf('  - rank:', blockStart + 1);
  const blockEnd = nextBlockIdx === -1 ? fm.length : nextBlockIdx;

  // ブロックを除去
  fm = fm.slice(0, blockStart) + fm.slice(blockEnd);

  // rank を 1 から振り直す（split + 再組み立て方式）
  const sep = '  - rank:';
  const firstSepIdx = fm.indexOf(sep);
  if (firstSepIdx !== -1) {
    const preProducts = fm.slice(0, firstSepIdx);
    const productBlocks = fm.slice(firstSepIdx).split(sep).slice(1);
    const renumbered = productBlocks.map((block, i) => {
      const nlIdx = block.indexOf('\n');
      const restOfBlock = nlIdx !== -1 ? block.slice(nlIdx) : block;
      return `${sep} ${i + 1}${restOfBlock}`;
    }).join('');
    fm = preProducts + renumbered;
  }

  return prefix + fm + suffix + rest;
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
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return { content, changed: false, log: [] };

  const prefix = fmMatch[1];
  let fm = fmMatch[2];
  const suffix = fmMatch[3];
  const rest = content.slice(prefix.length + fm.length + suffix.length);

  const sep = '  - rank:';
  const sepIdx = fm.indexOf(sep);
  if (sepIdx === -1) return { content, changed: false, log: [] };

  const preProducts = fm.slice(0, sepIdx);
  const productBlocks = fm.slice(sepIdx).split(sep).slice(1); // parts[0]="" を除去

  if (productBlocks.length <= 1) return { content, changed: false, log: [] };

  const ppuRe = /^\s*pricePerUnit:\s*"約?([\d.]+)円\/(.+?)"$/m;
  const nameRe = /^\s*name:\s*"(.+?)"$/m;

  const blockInfos = productBlocks.map((block) => {
    const ppuMatch = block.match(ppuRe);
    const nameMatch = block.match(nameRe);
    let ppuValue = Infinity;
    let unit = '';
    if (ppuMatch) {
      ppuValue = parseFloat(ppuMatch[1]);
      if (isNaN(ppuValue) || ppuValue === 0) ppuValue = Infinity;
      unit = ppuMatch[2];
    }
    return { rawBlock: block, ppuValue, unit, name: nameMatch?.[1] ?? '' };
  });

  const validBlocks = blockInfos.filter(b => b.ppuValue !== Infinity);
  if (validBlocks.length <= 1) return { content, changed: false, log: [] };

  const units = new Set(validBlocks.map(b => b.unit));
  if (units.size > 1) {
    return { content, changed: false, log: [`単位が混在しているため並び替えをスキップ: ${[...units].join(', ')}`] };
  }

  const sorted = [...blockInfos].sort((a, b) => a.ppuValue - b.ppuValue);
  if (sorted.every((b, i) => b === blockInfos[i])) return { content, changed: false, log: [] };

  const log: string[] = [];
  const newProductsSection = sorted.map((b, newIdx) => {
    const oldIdx = blockInfos.indexOf(b);
    const nlIdx = b.rawBlock.indexOf('\n');
    const restOfBlock = nlIdx !== -1 ? b.rawBlock.slice(nlIdx) : b.rawBlock;
    if (oldIdx !== newIdx) {
      log.push(`rank ${oldIdx + 1} → rank ${newIdx + 1}: ${b.name}`);
    }
    return `${sep} ${newIdx + 1}${restOfBlock}`;
  }).join('');

  fm = preProducts + newProductsSection;
  return { content: prefix + fm + suffix + rest, changed: true, log };
}
