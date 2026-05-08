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

/**
 * フロントマター内の特定商品の rakutenUrl フィールドの値を取得する
 */
export function extractProductRakutenUrl(content: string, productName: string): string | null {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) return null;
  const product = (parsed.data.products as Array<{ name: string; rakutenUrl?: string }>)
    .find(p => p.name === productName);
  return product?.rakutenUrl ?? null;
}

const CAPACITY_UNITS = 'mL|ml|kg|L|g|m|枚|本|個|袋|巻|回|粒|包|錠';
const PACK_UNITS = 'ロール|パック|セット|箱|缶|ケース';

function normalizeItemName(s: string): string {
  return s.replace(/[ａ-ｚＡ-Ｚ０-９]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
  );
}

/**
 * capacity フィールドの文字列から総量と単位を抽出する
 * 例: "60枚×48個（2,880枚）"         → { total: 2880, unit: "枚" }
 * 例: "43枚×8個×4セット（1,376枚）"  → { total: 1376, unit: "枚" }
 * 例: "660mL×2個"                   → { total: 1320, unit: "mL" }
 * 例: "30枚（携帯用）"               → { total: 30,   unit: "枚" }
 * 例: "500g"                        → { total: 500,  unit: "g"  }
 * 例: "48ロール"                     → { total: 48,   unit: "ロール" }
 * 例: "12ロール×4パック"             → { total: 48,   unit: "ロール" }
 */
export function extractCapacityTotal(capacity: string): { total: number; unit: string } | null {
  capacity = normalizeItemName(capacity);
  // パターン1: 括弧内に明示された総量 "（1,376枚）"（最も信頼性が高い）
  const bracketRe = new RegExp(`[（(]([\\d,]+)\\s*(${CAPACITY_UNITS})[）)]`);
  const bracketM = capacity.match(bracketRe);
  if (bracketM) {
    const total = parseInt(bracketM[1].replace(/,/g, ''), 10);
    if (total > 0) return { total, unit: bracketM[2] };
  }

  // パターン2: "数値unit×N1[×N2...]" の掛け算（複数因子対応）
  // 例: "660mL×2個"           → 660×2=1320mL
  // 例: "500枚×60箱"           → 500×60=30000枚
  // 例: "500枚×5箱×12パック"   → 500×5×12=30000枚
  const mulBaseRe = new RegExp(`^([\\d,]+)\\s*(${CAPACITY_UNITS})(.*)`);
  const mulBaseM = capacity.match(mulBaseRe);
  if (mulBaseM) {
    const base = parseInt(mulBaseM[1].replace(/,/g, ''), 10);
    const unit = mulBaseM[2];
    const factors = [...mulBaseM[3].matchAll(/[×xX]\s*([\d,]+)/g)];
    if (base > 0 && factors.length > 0) {
      const multiplier = factors.reduce((acc, f) => acc * parseInt(f[1].replace(/,/g, ''), 10), 1);
      if (multiplier > 1) return { total: base * multiplier, unit };
    }
  }

  // パターン3: シンプルな単位 "30枚" "500g"
  const simpleRe = new RegExp(`^([\\d,]+)\\s*(${CAPACITY_UNITS})`);
  const simpleM = capacity.match(simpleRe);
  if (simpleM) {
    const total = parseInt(simpleM[1].replace(/,/g, ''), 10);
    if (total > 0) return { total, unit: simpleM[2] };
  }

  // パターン4: PACK_UNITS が基底単位（例: "48ロール", "12ロール×4パック"）
  // CAPACITY_UNITS パターンがすべて不一致の場合のフォールバック
  const mulPackRe = new RegExp(`^([\\d,]+)\\s*(${PACK_UNITS})(.*)`);
  const mulPackM = capacity.match(mulPackRe);
  if (mulPackM) {
    const base = parseInt(mulPackM[1].replace(/,/g, ''), 10);
    const unit = mulPackM[2];
    const factors = [...mulPackM[3].matchAll(/[×xX]\s*([\d,]+)/g)];
    if (base > 0 && factors.length > 0) {
      const multiplier = factors.reduce((acc, f) => acc * parseInt(f[1].replace(/,/g, ''), 10), 1);
      if (multiplier > 1) return { total: base * multiplier, unit };
    }
    if (base > 0) return { total: base, unit };
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
  itemName = normalizeItemName(itemName);
  // パターン1: × 区切り乗算チェーン（複数因子対応）"200枚×5箱" "50m×12ロール×6パック"
  // CAPACITY_UNITS および PACK_UNITS（ロール・パック・箱等）の両方を単位として認識する
  // PACK_UNITS も起点として認識する（例: "（12ロール×6個セット）" で 12ロール を先に捕捉）
  const mulRe = new RegExp(`(\\d[\\d,]*)\\s*(${CAPACITY_UNITS}|${PACK_UNITS})`);
  const mulM = itemName.match(mulRe);
  if (mulM && mulM.index !== undefined) {
    const capacityUnitRe = new RegExp(`^(${CAPACITY_UNITS}|${PACK_UNITS})`);
    let result = mulM[1] + mulM[2];
    let pos = mulM.index + mulM[0].length;
    let foundChain = false;
    while (pos < itemName.length) {
      const ahead = itemName.slice(pos);
      // 非数字・非×文字を読み飛ばして次の × を探す
      const xMatch = ahead.match(/^([^×xX\d]*)[×xX]\s*(\d[\d,]*)/);
      if (!xMatch) break;
      // × より前に数字が混入していたら別の数値表現として中断
      if (/\d/.test(xMatch[1])) break;
      result += '×' + xMatch[2];
      pos += xMatch[0].length;
      // × 直後に CAPACITY_UNITS が続く場合は含める
      const unitM = itemName.slice(pos).match(capacityUnitRe);
      if (unitM) {
        result += unitM[1];
        pos += unitM[1].length;
      }
      foundChain = true;
    }
    if (foundChain) return result;

    // パターン1c: スペース区切り PACK_UNIT から始まり × チェーンが続くケース
    // 例: "100m 12ロール×4パック" → "100m×12ロール×4パック"
    // 数量1の集合単位（"1パック" 等）は Pattern 1d に委譲するため qty > 1 のみ対象
    const remaining = itemName.slice(pos);
    const packStartRe = new RegExp(`^\\s+(\\d[\\d,]*)\\s*(${PACK_UNITS})`);
    const packStartM = remaining.match(packStartRe);
    if (packStartM && parseInt(packStartM[1].replace(/,/g, ''), 10) > 1) {
      let chainResult = result + '×' + packStartM[1] + packStartM[2];
      let chainPos = pos + packStartM[0].length;
      while (chainPos < itemName.length) {
        const ahead = itemName.slice(chainPos);
        const xMatch = ahead.match(/^([^×xX\d]*)[×xX]\s*(\d[\d,]*)/);
        if (!xMatch || /\d/.test(xMatch[1])) break;
        chainResult += '×' + xMatch[2];
        chainPos += xMatch[0].length;
        const unitM = itemName.slice(chainPos).match(capacityUnitRe);
        if (unitM) {
          chainResult += unitM[1];
          chainPos += unitM[1].length;
        }
      }
      return chainResult;
    }

    // パターン1d: 括弧内に PACK_UNITS の乗算チェーンがある場合
    // 例: "50m ケース販売(12ロール×6パック入)" → "50m×12ロール×6パック"
    const parenFactorRe = /[（(]([^）)]+)[）)]/g;
    let parenMatch: RegExpExecArray | null;
    while ((parenMatch = parenFactorRe.exec(itemName)) !== null) {
      const packFactors = [...parenMatch[1].matchAll(new RegExp(`(\\d[\\d,]*)\\s*(${PACK_UNITS})`, 'g'))];
      if (packFactors.length >= 1) {
        for (const f of packFactors) result += '×' + f[1] + f[2];
        return result;
      }
    }
  }

  // パターン1b: スペース区切りの数量表現 "50m 72ロール" → "50m×72ロール"
  // × を使わず「長さ ロール数」と並べる楽天商品名（例: "50m 72ロール ダブル"）に対応
  const spaceMulRe = new RegExp(`(\\d[\\d,]*)\\s*(${CAPACITY_UNITS})\\s+(\\d[\\d,]*)\\s*(ロール|パック|セット)`);
  const spaceMulM = itemName.match(spaceMulRe);
  if (spaceMulM) {
    return `${spaceMulM[1]}${spaceMulM[2]}×${spaceMulM[3]}${spaceMulM[4]}`;
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

  // パターン4: PACK_UNITS のみの単独表記（例: "48ロール"）
  // CAPACITY_UNITS パターンがすべて不一致の場合のフォールバック
  const simplePackRe = new RegExp(`(\\d[\\d,]*)\\s*(${PACK_UNITS})`);
  const simplePackM = itemName.match(simplePackRe);
  if (simplePackM) {
    return `${simplePackM[1]}${simplePackM[2]}`;
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
 * 全商品の name に埋め込まれた容量が capacity と食い違う場合、
 * name 内の容量を capacity の値で上書きする。
 * × を含む複合表記・単位不一致はスキップ（安全側）。
 */
export function fixNameCapacityConflicts(
  content: string
): { content: string; changed: boolean; log: string[] } {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) {
    return { content, changed: false, log: [] };
  }

  type P = Record<string, unknown>;
  const products = parsed.data.products as P[];
  let changed = false;
  const log: string[] = [];

  for (const product of products) {
    const rank = typeof product.rank === 'number' ? product.rank : '?';
    const name = typeof product.name === 'string' ? product.name : null;
    const capacity = typeof product.capacity === 'string' ? product.capacity : null;
    if (!name || !capacity) continue;

    const embeddedCap = extractCapacityFromItemName(name);
    if (!embeddedCap) continue;
    if (embeddedCap === capacity) continue;
    // × 含む複合表記は置換が危険（例: "300mL×2個" → capacity "290mL" は意味が変わる）
    if (/[×xX]/.test(embeddedCap)) continue;

    const embeddedParsed = extractCapacityTotal(embeddedCap);
    const capacityParsed = extractCapacityTotal(capacity);
    if (!embeddedParsed || !capacityParsed) continue;
    if (embeddedParsed.unit !== capacityParsed.unit) continue;
    if (embeddedParsed.total === capacityParsed.total) continue;

    // indexOf/slice で置換（capacity に $ が含まれる場合の String.replace 誤動作を回避）
    const idx = name.indexOf(embeddedCap);
    if (idx === -1) continue;

    product.name = name.slice(0, idx) + capacity + name.slice(idx + embeddedCap.length);
    log.push(`rank ${rank}: name の ${embeddedCap} を ${capacity} に修正`);
    changed = true;
  }

  if (!changed) return { content, changed: false, log };
  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true, log };
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
