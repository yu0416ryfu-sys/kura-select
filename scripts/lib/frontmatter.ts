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
    .replace(/\s*[【\[].+?[】\]]/g, "")
    .replace(/\s*[（(].+?[）)]/g, "")
    .replace(/\s*\d+[mMlLgG枚本袋個入パック巻]+.*$/g, "")
    .replace(/\s*(×|x|X)\s*\d+.*$/g, "")
    .replace(/\s*(大容量|超大型|超特大|特大|大型|レギュラー|ミニ)/g, "")
    .split(/\s+/)
    .filter(token => !/^[A-Za-z]$/.test(token))
    .join(" ")
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

export interface ProductSnapshot {
  name: string;
  price: number | null;
  rating: number | null;
  reviewCount: number | null;
  rakutenUrl: string | null;
  imageUrl: string | null;
  capacity: string | null;
  pricePerUnit: string | null;
}

export function extractProductSnapshot(content: string, productName: string): ProductSnapshot | null {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) return null;

  const product = (parsed.data.products as Array<Record<string, unknown>>)
    .find(p => p.name === productName);
  if (!product) return null;

  return {
    name: typeof product.name === 'string' ? product.name : '',
    price: typeof product.price === 'number' ? product.price : null,
    rating: typeof product.rating === 'number' ? product.rating : null,
    reviewCount: typeof product.reviewCount === 'number' ? product.reviewCount : null,
    rakutenUrl: typeof product.rakutenUrl === 'string' ? product.rakutenUrl : null,
    imageUrl: typeof product.imageUrl === 'string' ? product.imageUrl : null,
    capacity: typeof product.capacity === 'string' ? product.capacity : null,
    pricePerUnit: typeof product.pricePerUnit === 'string' ? product.pricePerUnit : null,
  };
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
const MULTIPLY_RE_CHAR_CLASS = '×xX*＊';
const SALES_QUANTITY_UNITS = '枚|個|本|袋|セット|パック|箱|ケース';
const MEASURE_UNITS = 'mL|ml|L|g|kg';

function normalizeItemName(s: string): string {
  return s.replace(/[ａ-ｚＡ-Ｚ０-９]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSalesQuantityUnit(unit: string): boolean {
  return new RegExp(`^(${SALES_QUANTITY_UNITS})$`).test(unit);
}

export function isSalesQuantityCapacity(capacity: string | null | undefined): boolean {
  if (!capacity || capacity === '-') return false;
  const normalized = normalizeItemName(capacity);
  const extracted = extractCapacityTotal(normalized);
  if (!extracted || !isSalesQuantityUnit(extracted.unit)) return false;
  return !new RegExp(`\\d[\\d,]*\\s*(${MEASURE_UNITS})`, 'i').test(normalized);
}

export function hasMeasureCapacity(capacity: string | null | undefined): boolean {
  if (!capacity || capacity === '-') return false;
  return new RegExp(`\\d[\\d,]*\\s*(${MEASURE_UNITS})`, 'i').test(normalizeItemName(capacity));
}

export function mergeExistingMeasureWithSalesQuantity(
  existingCapacity: string | null | undefined,
  extractedCapacity: string
): string | null {
  if (!existingCapacity || existingCapacity === '-') return null;

  const normalizedExisting = normalizeItemName(existingCapacity);
  const normalizedExtracted = normalizeItemName(extractedCapacity);
  const extracted = extractCapacityTotal(normalizedExtracted);
  if (!extracted || !isSalesQuantityCapacity(normalizedExtracted)) return null;

  const unit = escapeRegExp(extracted.unit);
  const re = new RegExp(`(\\d[\\d,]*\\s*(?:${MEASURE_UNITS}))(\\s*[${MULTIPLY_RE_CHAR_CLASS}]\\s*)(\\d[\\d,]*)(\\s*${unit})`, 'i');
  const match = normalizedExisting.match(re);
  if (!match) return null;

  const oldQuantity = parseInt(match[3].replace(/,/g, ''), 10);
  if (!Number.isFinite(oldQuantity) || oldQuantity <= 0) return null;

  return normalizedExisting.replace(re, `${match[1]}${match[2]}${extracted.total}${match[4]}`);
}

export function isSameMeasureBaseWithExistingQuantity(
  existingCapacity: string | null | undefined,
  extractedCapacity: string | null | undefined
): boolean {
  if (!existingCapacity || existingCapacity === '-' || !extractedCapacity || extractedCapacity === '-') return false;

  const normalizedExisting = normalizeItemName(existingCapacity);
  const normalizedExtracted = normalizeItemName(extractedCapacity);
  const measure = `([\\d,]+)\\s*(${MEASURE_UNITS})`;
  const extractedRe = new RegExp(`^${measure}\\s*$`, 'i');
  const existingRe = new RegExp(`^${measure}\\s*[${MULTIPLY_RE_CHAR_CLASS}]\\s*\\d`, 'i');
  const extractedM = normalizedExtracted.match(extractedRe);
  const existingM = normalizedExisting.match(existingRe);
  if (!extractedM || !existingM) return false;

  const extractedTotal = normalizeCapacityTotal({
    total: parseInt(extractedM[1].replace(/,/g, ''), 10),
    unit: extractedM[2],
  });
  const existingBase = normalizeCapacityTotal({
    total: parseInt(existingM[1].replace(/,/g, ''), 10),
    unit: existingM[2],
  });

  return Boolean(
    extractedTotal &&
    existingBase &&
    extractedTotal.total === existingBase.total &&
    extractedTotal.unit.toLowerCase() === existingBase.unit.toLowerCase()
  );
}

export function isLikelySalesQuantityCapacityMisread(itemName: string, extractedCapacity: string): boolean {
  const normalizedName = normalizeItemName(itemName);
  const normalizedCapacity = normalizeItemName(extractedCapacity);
  const extracted = extractCapacityTotal(normalizedCapacity);
  if (!extracted) return false;
  if (!isSalesQuantityUnit(extracted.unit)) return false;
  if (new RegExp(`\\d[\\d,]*\\s*(${MEASURE_UNITS})`, 'i').test(normalizedCapacity)) return false;
  return new RegExp(`\\d[\\d,]*\\s*(${MEASURE_UNITS})`, 'i').test(normalizedName);
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
    // 括弧内（注釈・内訳）の × は乗数ではないため除外する
    const restWithoutBrackets = mulBaseM[3].replace(/[（(][^）)]*[）)]/g, '');
    const factors = [...restWithoutBrackets.matchAll(new RegExp(`[${MULTIPLY_RE_CHAR_CLASS}]\\s*([\\d,]+)`, 'g'))];
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
    const factors = [...mulPackM[3].matchAll(new RegExp(`[${MULTIPLY_RE_CHAR_CLASS}]\\s*([\\d,]+)`, 'g'))];
    if (base > 0 && factors.length > 0) {
      const multiplier = factors.reduce((acc, f) => acc * parseInt(f[1].replace(/,/g, ''), 10), 1);
      if (multiplier > 1) return { total: base * multiplier, unit };
    }
    if (base > 0) return { total: base, unit };
  }

  return null;
}

/**
 * 容量比較用に同系単位を基準単位へ正規化する。
 * 例: 3kg → 3000g, 1L → 1000mL
 */
export function normalizeCapacityTotal(
  capacity: { total: number; unit: string } | null
): { total: number; unit: string } | null {
  if (!capacity || !Number.isFinite(capacity.total) || capacity.total <= 0) return null;

  const unit = capacity.unit.trim();
  const lowerUnit = unit.toLowerCase();

  if (lowerUnit === 'kg') return { total: capacity.total * 1000, unit: 'g' };
  if (lowerUnit === 'g') return { total: capacity.total, unit: 'g' };
  if (lowerUnit === 'l') return { total: capacity.total * 1000, unit: 'mL' };
  if (lowerUnit === 'ml') return { total: capacity.total, unit: 'mL' };

  return { total: capacity.total, unit };
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
 * 楽天の容量選択式商品名かどうかを判定する。
 * 例: "2kg 5kg 10kg" は価格が最小容量側を指すことがあるため自動単価更新を避ける。
 */
export function isMultiMeasureVariantItemName(itemName: string): boolean {
  const normalized = normalizeItemName(itemName);
  const matches = [...normalized.matchAll(new RegExp(`(\\d[\\d,]*)\\s*(${MEASURE_UNITS})`, 'gi'))];
  const totalsByUnit = new Map<string, Set<number>>();

  for (const match of matches) {
    const parsed = normalizeCapacityTotal({
      total: parseInt(match[1].replace(/,/g, ''), 10),
      unit: match[2],
    });
    if (!parsed) continue;
    const unitKey = parsed.unit.toLowerCase();
    const totals = totalsByUnit.get(unitKey) ?? new Set<number>();
    totals.add(parsed.total);
    totalsByUnit.set(unitKey, totals);
  }

  return [...totalsByUnit.values()].some(totals => totals.size >= 2);
}

/**
 * 楽天商品名から容量文字列を抽出する（extractCapacityTotal で解析可能な形式で返す）
 * 例: "スコッティ 200枚×5箱"      → "200枚×5箱"
 * 例: "ネピア 60枚（2,880枚）"    → "（2,880枚）"
 * 例: "ビオレ ボディウォッシュ 500mL" → "500mL"
 */
export function extractCapacityFromItemName(itemName: string): string | null {
  itemName = normalizeItemName(itemName);
  // パターン0: 括弧内に総枚数と内訳があるケース
  // 例: "45L 1セット（1000枚：100枚×10パック）" → "（1000枚）"
  const bracketTotalWithBreakdownRe = new RegExp(`[（(][^）)]*?([\\d,]+)\\s*(${CAPACITY_UNITS})\\s*[：:][^）)]*[）)]`);
  const bracketTotalWithBreakdownM = itemName.match(bracketTotalWithBreakdownRe);
  if (bracketTotalWithBreakdownM) {
    return `（${bracketTotalWithBreakdownM[1]}${bracketTotalWithBreakdownM[2]}）`;
  }

  // パターン0a: ラップ・ホイル系の幅×長さ表記
  // 例: "30cm×50m(1コ入*3コセット)" → "50m×3個"
  // 幅の cm は単価計算対象ではないため、長さ m と販売数量だけを抽出する。
  const widthLengthRe = new RegExp(`\\d[\\d,]*\\s*cm\\s*[${MULTIPLY_RE_CHAR_CLASS}]\\s*(\\d[\\d,]*)\\s*m`, 'i');
  const widthLengthM = itemName.match(widthLengthRe);
  if (widthLengthM) {
    const after = itemName.slice((widthLengthM.index ?? 0) + widthLengthM[0].length);
    const qtyMatches = [...after.matchAll(new RegExp(`(?:[${MULTIPLY_RE_CHAR_CLASS}]|[（(][^）)]*?)(\\d[\\d,]*)\\s*(?:個|コ|本|セット)`, 'gi'))]
      .map(match => parseInt(match[1].replace(/,/g, ''), 10))
      .filter(qty => qty > 1);
    const multiplier = qtyMatches.length > 0 ? qtyMatches.reduce((acc, qty) => acc * qty, 1) : 1;
    return multiplier > 1 ? `${widthLengthM[1]}m×${multiplier}個` : `${widthLengthM[1]}m`;
  }

  // パターン1: × / * 区切り乗算チェーン（複数因子対応）"200枚×5箱" "400ml*3袋"
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
      // 非数字・非乗算記号文字を読み飛ばして次の乗算記号を探す
      const xMatch = ahead.match(new RegExp(`^([^${MULTIPLY_RE_CHAR_CLASS}\\d]*)[${MULTIPLY_RE_CHAR_CLASS}]\\s*(\\d[\\d,]*)`));
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

    // パターン1a: ティッシュ系の内訳注釈を含む販売数量
    // 例: "200枚（100組）×12箱" → "200枚（100組）×12箱"
    const tissueBreakdownRe = new RegExp(`^\\s*[（(]\\s*\\d[\\d,]*\\s*組\\s*[）)]\\s*[${MULTIPLY_RE_CHAR_CLASS}]\\s*(\\d[\\d,]*)\\s*(${PACK_UNITS})`);
    const tissueBreakdownM = itemName.slice(pos).match(tissueBreakdownRe);
    if (tissueBreakdownM && mulM[2] === '枚') {
      return `${result}${tissueBreakdownM[0].trim()}`;
    }

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
        const xMatch = ahead.match(new RegExp(`^([^${MULTIPLY_RE_CHAR_CLASS}\\d]*)[${MULTIPLY_RE_CHAR_CLASS}]\\s*(\\d[\\d,]*)`));
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
      // 括弧内に実数量がある場合は内訳注釈として扱う。
      // 例: "200枚(50枚束×4セット)" は総量200枚で、200枚×4セットではない。
      if (new RegExp(`\\d[\\d,]*\\s*(${CAPACITY_UNITS})`).test(parenMatch[1])) {
        continue;
      }
      const packFactors = [...parenMatch[1].matchAll(new RegExp(`(\\d[\\d,]*)\\s*(${PACK_UNITS})`, 'g'))];
      if (packFactors.length >= 1) {
        // 単一因子かつ result 末尾と同一単位で整数倍の場合は合計括弧とみなしてスキップ
        // 例: result="12ロール" のとき "(48ロール)" は 12×4=48 の合計 → 因子ではない
        if (packFactors.length === 1) {
          const fVal = parseInt(packFactors[0][1].replace(/,/g, ''), 10);
          const fUnit = packFactors[0][2];
          const rEndM = result.match(new RegExp(`(\\d[\\d,]*)\\s*(${PACK_UNITS})$`));
          if (rEndM) {
            const rVal = parseInt(rEndM[1].replace(/,/g, ''), 10);
            if (rEndM[2] === fUnit && fVal > rVal && fVal % rVal === 0) continue;
          }
        }
        for (const f of packFactors) result += '×' + f[1] + f[2];
        return result;
      }
    }

    // パターン1e: PACK×PACK 乗算チェーンと CAPACITY_UNIT が別々に出現するケースを結合
    // 例: "12ロール(シングル) 12ロール×4パック(48ロール) 100m" → "100m×12ロール×4パック"
    // Pattern 1/1c/1d が CAPACITY_UNIT 起点のチェーンを拾えなかった場合のフォールバック
    const packXpackRe = new RegExp(`(\\d[\\d,]*)\\s*(${PACK_UNITS})\\s*[${MULTIPLY_RE_CHAR_CLASS}]\\s*(\\d[\\d,]*)\\s*(${PACK_UNITS})`);
    const packXpackM = itemName.match(packXpackRe);
    if (packXpackM) {
      const capUnitSearchRe = new RegExp(`(\\d[\\d,]*)\\s*(${CAPACITY_UNITS})`);
      const capUnitM = itemName.match(capUnitSearchRe);
      if (capUnitM) {
        return `${capUnitM[1]}${capUnitM[2]}×${packXpackM[1]}${packXpackM[2]}×${packXpackM[3]}${packXpackM[4]}`;
      }
    }
  }

  // パターン1b: スペース区切りの数量表現 "50m 72ロール" → "50m×72ロール"
  // × を使わず「長さ ロール数」と並べる楽天商品名（例: "50m 72ロール ダブル"）に対応
  const spaceMulRe = new RegExp(`(\\d[\\d,]*)\\s*(${CAPACITY_UNITS})\\s+(\\d[\\d,]*)\\s*(ロール|パック|セット)`);
  const spaceMulM = itemName.match(spaceMulRe);
  if (spaceMulM && parseInt(spaceMulM[3].replace(/,/g, ''), 10) > 1) {
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
export type CapacityConfidence = "high" | "medium" | "low";

export interface CapacityAnalysis {
  capacity: string | null;
  total: { total: number; unit: string } | null;
  normalizedTotal: { total: number; unit: string } | null;
  confidence: CapacityConfidence;
  reasons: string[];
  shouldAutoUpdate: boolean;
}

const AMBIGUOUS_CAPACITY_TERMS = [
  "選べる",
  "選択",
  "セット",
  "詰め合わせ",
  "詰合せ",
  "本体+詰替",
  "本体＋詰替",
  "本体 詰替",
  "詰替",
  "お試し",
  "各種",
  "サイズ選択",
  "バリエーション",
  "アソート",
  "ランダム",
  "福袋",
  "よりどり",
];

function getCapacityCandidateTotals(itemName: string): Array<{ raw: string; total: { total: number; unit: string }; normalizedTotal: { total: number; unit: string } | null }> {
  const normalized = normalizeItemName(itemName);
  const re = new RegExp(`(\\d[\\d,]*)\\s*(${CAPACITY_UNITS}|${PACK_UNITS})`, 'gi');
  return [...normalized.matchAll(re)]
    .map(match => {
      const raw = `${match[1]}${match[2]}`;
      const total = extractCapacityTotal(raw);
      if (!total) return null;
      return { raw, total, normalizedTotal: normalizeCapacityTotal(total) };
    })
    .filter((v): v is { raw: string; total: { total: number; unit: string }; normalizedTotal: { total: number; unit: string } | null } => Boolean(v));
}

function hasExplicitBracketTotalWithBreakdown(itemName: string): boolean {
  const normalized = normalizeItemName(itemName);
  return new RegExp(`[（(][^）)]*?[\\d,]+\\s*(${CAPACITY_UNITS})\\s*[：:][^）)]*[）)]`).test(normalized);
}

function isMeasureUnit(unit: string): boolean {
  return new RegExp(`^(${MEASURE_UNITS})$`, 'i').test(unit);
}

export function analyzeCapacityFromItemName(itemName: string): CapacityAnalysis {
  const normalizedName = normalizeItemName(itemName);
  const capacity = extractCapacityFromItemName(normalizedName);
  const total = capacity ? extractCapacityTotal(capacity) : null;
  const normalizedTotal = normalizeCapacityTotal(total);
  const reasons: string[] = [];

  if (!capacity || !total) {
    reasons.push("API商品名からcapacityを抽出できない");
    return {
      capacity,
      total,
      normalizedTotal,
      confidence: "low",
      reasons,
      shouldAutoUpdate: false,
    };
  }

  const explicitBracketTotal = hasExplicitBracketTotalWithBreakdown(normalizedName);
  const ambiguousTerms = AMBIGUOUS_CAPACITY_TERMS
    .filter(term => normalizedName.includes(term))
    .filter(term => !(term === "セット" && explicitBracketTotal));
  if (ambiguousTerms.length > 0) {
    reasons.push(`曖昧語を含む: ${ambiguousTerms.slice(0, 3).join(", ")}`);
  }

  if (isMultiMeasureVariantItemName(normalizedName)) {
    reasons.push("複数の実容量候補を含む");
  }

  const distinctTotals = new Set(
    getCapacityCandidateTotals(normalizedName)
      .filter(candidate => {
        const comparable = candidate.normalizedTotal ?? candidate.total;
        const extractedComparable = normalizedTotal ?? total;

        if (
          isSalesQuantityUnit(extractedComparable.unit) &&
          (isMeasureUnit(comparable.unit) || new RegExp(`^(${PACK_UNITS})$`).test(comparable.unit))
        ) {
          return false;
        }

        if (
          comparable.unit.toLowerCase() === extractedComparable.unit.toLowerCase() &&
          comparable.total < extractedComparable.total &&
          extractedComparable.total % comparable.total === 0
        ) {
          return false;
        }

        return true;
      })
      .map(candidate => candidate.normalizedTotal ?? candidate.total)
      .map(candidate => `${candidate.total}:${candidate.unit.toLowerCase()}`)
  );
  if (distinctTotals.size > 1) {
    reasons.push("複数のcapacity候補を含む");
  }

  const confidence: CapacityConfidence = reasons.length > 0 ? "low" : "high";
  if (confidence === "high") {
    reasons.push("単一のcapacity候補として解析可能");
  }

  return {
    capacity,
    total,
    normalizedTotal,
    confidence,
    reasons,
    shouldAutoUpdate: confidence === "high",
  };
}

export function removeCapacityFromProductName(productName: string, capacity?: string | null): string {
  const embeddedCapacity = extractCapacityFromItemName(productName);
  const capacityWithoutNote = capacity?.replace(/[（(].*$/, '').trim() ?? null;
  const candidates = [embeddedCapacity, capacityWithoutNote, capacity]
    .filter((v): v is string => Boolean(v && v !== '-'));

  for (const candidate of candidates) {
    const idx = productName.indexOf(candidate);
    if (idx === -1) continue;
    return (productName.slice(0, idx) + productName.slice(idx + candidate.length))
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  return productName;
}

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
 * 単位が混在する場合は同一単位グループ内で並び替え、グループ単位でランキングする。
 */
function normalizePricePerUnit(value: number, unit: string): { value: number; unit: string } | null {
  const normalizedUnit = unit.trim();
  const lowerUnit = normalizedUnit.toLowerCase();
  if (!Number.isFinite(value) || value <= 0 || !normalizedUnit) return null;

  if (lowerUnit === 'ml') return { value, unit: 'mL' };
  if (lowerUnit === 'l') return { value: value / 1000, unit: 'mL' };
  if (lowerUnit === 'g') return { value, unit: 'g' };
  if (lowerUnit === 'kg') return { value: value / 1000, unit: 'g' };

  return { value, unit: normalizedUnit };
}

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
    const normalized = ppu ? normalizePricePerUnit(ppuValue, ppu[2]) : null;
    return {
      product: p,
      ppuValue: normalized?.value ?? Infinity,
      unit: normalized?.unit ?? '',
      price: typeof p.price === 'number' ? p.price : Infinity,
      reviewCount: typeof p.reviewCount === 'number' ? p.reviewCount : null,
      origIdx,
      name: String(p.name ?? ''),
    };
  });

  const validBlocks = blockInfos.filter(b => b.ppuValue !== Infinity);
  if (validBlocks.length === 0) return { content, changed: false, log: [] };

  const groups = new Map<string, typeof validBlocks>();
  for (const block of validBlocks) {
    const group = groups.get(block.unit) ?? [];
    group.push(block);
    groups.set(block.unit, group);
  }

  const sortedGroups = [...groups.entries()]
    .map(([unit, items]) => ({
      unit,
      firstOrigIdx: Math.min(...items.map(item => item.origIdx)),
      items: [...items].sort((a, b) => a.ppuValue - b.ppuValue || a.price - b.price || a.origIdx - b.origIdx),
    }))
    .sort((a, b) => {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;

      const maxLen = Math.max(a.items.length, b.items.length);
      for (let i = 0; i < maxLen; i++) {
        const aReview = a.items[i]?.reviewCount;
        const bReview = b.items[i]?.reviewCount;
        if (typeof aReview !== 'number' || typeof bReview !== 'number') continue;
        if (bReview !== aReview) return bReview - aReview;
      }

      const aPrice = a.items[0]?.price ?? Infinity;
      const bPrice = b.items[0]?.price ?? Infinity;
      if (aPrice !== bPrice) return aPrice - bPrice;
      return a.firstOrigIdx - b.firstOrigIdx;
    });

  const invalidBlocks = blockInfos.filter(b => b.ppuValue === Infinity);
  const sorted = [...sortedGroups.flatMap(group => group.items), ...invalidBlocks];
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

/**
 * rank の上限を超える商品を削除し、残りの rank を振り直す。
 * 並び替え後のランキングに対して使う想定。
 */
export function limitProductsByRank(
  content: string,
  maxRank = 10
): { content: string; changed: boolean; removed: number; removedProducts: ProductBasicData[]; log: string[] } {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) {
    return { content, changed: false, removed: 0, removedProducts: [], log: [] };
  }

  type P = Record<string, unknown>;
  const products = parsed.data.products as P[];
  const kept = products.filter(product => {
    const rank = typeof product.rank === 'number' ? product.rank : Number(product.rank);
    return Number.isFinite(rank) && rank <= maxRank;
  });

  const removed = products.length - kept.length;
  if (removed <= 0) return { content, changed: false, removed: 0, removedProducts: [], log: [] };

  const removedBlocks = products.filter(product => !kept.includes(product));
  const removedProducts = removedBlocks.map(product => ({
    rank: typeof product.rank === 'number' ? product.rank : Number(product.rank) || 0,
    name: typeof product.name === 'string' ? product.name : '',
    capacity: typeof product.capacity === 'string' ? product.capacity : null,
    reviewCount: typeof product.reviewCount === 'number' ? product.reviewCount : null,
    rakutenUrl: typeof product.rakutenUrl === 'string' ? product.rakutenUrl : '',
  })).filter(product => product.name || product.rakutenUrl);

  kept.forEach((product, index) => {
    product.rank = index + 1;
  });
  parsed.data.products = kept;

  const removedNames = removedBlocks.map(product => String(product.name ?? '(nameなし)'));
  const log = [
    `rank ${maxRank + 1}位以下を${removed}件削除`,
    ...removedNames.map(name => `削除: ${name}`),
  ];

  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true, removed, removedProducts, log };
}

/**
 * title・description 内の「N選」を products 件数に同期する。
 * 「N選」がないフィールドは記事意図を壊さないため変更しない。
 */
export function syncTitleProductCount(
  content: string
): {
  content: string;
  changed: boolean;
  before: string | null;
  after: string | null;
  descBefore: string | null;
  descAfter: string | null;
} {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) {
    return { content, changed: false, before: null, after: null, descBefore: null, descAfter: null };
  }

  const count = parsed.data.products.length;
  const nSenRe = /[0-9０-９]+選/;
  let changed = false;

  let before: string | null = null;
  let after: string | null = null;
  if (typeof parsed.data.title === 'string') {
    const next = parsed.data.title.replace(nSenRe, `${count}選`);
    before = parsed.data.title;
    after = next;
    if (next !== parsed.data.title) {
      parsed.data.title = next;
      changed = true;
    }
  }

  let descBefore: string | null = null;
  let descAfter: string | null = null;
  if (typeof parsed.data.description === 'string') {
    const next = parsed.data.description.replace(nSenRe, `${count}選`);
    descBefore = parsed.data.description;
    descAfter = next;
    if (next !== parsed.data.description) {
      parsed.data.description = next;
      changed = true;
    }
  }

  if (!changed) return { content, changed: false, before, after, descBefore, descAfter };

  return {
    content: dumpFrontmatter(parsed.data, parsed.body),
    changed: true,
    before,
    after,
    descBefore,
    descAfter,
  };
}

/**
 * フロントマターから全商品の基本データを抽出する（入れ替え候補レポート用）
 */
export interface ProductBasicData {
  rank: number;
  name: string;
  capacity: string | null;
  reviewCount: number | null;
  rakutenUrl: string;
}

export function extractAllProductsData(content: string): ProductBasicData[] {
  const parsed = parseFrontmatter(content);
  if (!parsed) return [];
  const products = parsed.data.products;
  if (!Array.isArray(products)) return [];
  return products
    .map((p: unknown) => {
      const product = p as Record<string, unknown>;
      return {
        rank: typeof product.rank === 'number' ? product.rank : 0,
        name: typeof product.name === 'string' ? product.name : '',
        capacity: typeof product.capacity === 'string' ? product.capacity : null,
        reviewCount: typeof product.reviewCount === 'number' ? product.reviewCount : null,
        rakutenUrl: typeof product.rakutenUrl === 'string' ? product.rakutenUrl : '',
      };
    })
    .filter(p => p.name && p.rakutenUrl);
}

/**
 * フロントマターから記事タイトルを抽出する（商品追加候補レポート用）
 */
export function extractArticleTitle(content: string): string | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  return typeof parsed.data.title === 'string' ? parsed.data.title : null;
}

/**
 * フロントマターから記事カテゴリを抽出する（商品追加候補レポート用）
 */
export function extractArticleCategory(content: string): string | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  return typeof parsed.data.category === 'string' ? parsed.data.category : null;
}

/**
 * 記事タイトルから楽天API検索用キーワードを生成する。
 * 「ジェルボール洗剤 コスパ最強ランキング【2026年版】...」→「ジェルボール洗剤」
 */
export function buildArticleSearchKeyword(title: string): string {
  // 【...】の前、または「コスパ」「おすすめ」「比較」「ランキング」の前を切り出す
  let kw = title
    .replace(/【[^】]*】.*/g, '')        // 【2026年版】以降を削除
    .replace(/[\s　](コスパ|おすすめ|比較|ランキング|人気|レビュー).*/g, '') // 付加語以降を削除
    .trim();
  return kw.slice(0, 40) || title.slice(0, 20);
}
