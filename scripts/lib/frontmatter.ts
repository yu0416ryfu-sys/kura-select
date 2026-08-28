// フロントマター解析・更新ユーティリティ
import yaml from 'js-yaml';
// 容量解析・単価計算の純粋関数は src/lib/capacity.ts に集約（src コンポーネントと共有）。
// ⚠ Node ESM（--experimental-strip-types で実行）解決のため相対 import は拡張子 .ts を必須にする。
// frontmatter 内の多数箇所でローカル参照するため import（ローカル束縛）し、
// 公開 API 互換のため一部は同名で再エクスポートする。
import {
  CAPACITY_UNITS,
  PACK_UNITS,
  MULTIPLY_RE_CHAR_CLASS,
  CAPACITY_NUMBER_PATTERN,
  normalizeItemName,
  extractCapacityTotal,
  normalizeCapacityTotal,
  calcPricePerUnit,
} from '../../src/lib/capacity.ts';
export { extractCapacityTotal, normalizeCapacityTotal, calcPricePerUnit, getArticleTargetUnit } from '../../src/lib/capacity.ts';

// フロントマターを YAML としてパースし、data と body に分割する
// body スキャン（data 外の本文）と faqs スキャンの両方に使うため article-body-lint / tests からも import する。
export function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } | null {
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
 * フロントマターに faqs 配列を設定する（既存があれば上書き）。
 * 空配列の場合は記事意図を壊さないため何もしない（faqs キー自体を増やさない）。
 * YAML の整形は dumpFrontmatter に揃えるため、update-products 等の他更新と一貫する。
 */
export function setFaqsInFrontmatter(
  content: string,
  faqs: Array<{ question: string; answer: string }>
): { content: string; changed: boolean } {
  if (!faqs || faqs.length === 0) return { content, changed: false };
  const parsed = parseFrontmatter(content);
  if (!parsed) return { content, changed: false };

  const next = faqs.map(f => ({ question: f.question, answer: f.answer }));
  const prev = parsed.data.faqs;
  if (JSON.stringify(prev) === JSON.stringify(next)) {
    return { content, changed: false };
  }
  parsed.data.faqs = next;
  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true };
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
    .replace(/\s*菌?\d+(?:\.\d+)?[%％]?除去/g, "")
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

  // null / undefined はいずれも「更新しない」。undefined を代入すると
  // yaml.dump がキーごと落とし、price 等の必須フィールドが消える
  if (updates.price != null)         product.price = updates.price;
  if (updates.rating != null)        product.rating = updates.rating;
  if (updates.reviewCount != null)   product.reviewCount = updates.reviewCount;
  if (updates.affiliateUrl)          product.rakutenUrl = updates.affiliateUrl;
  if (updates.imageUrl)              product.imageUrl = updates.imageUrl;
  if (updates.pricePerUnit != null)  product.pricePerUnit = updates.pricePerUnit;
  if (updates.newName)               product.name = updates.newName;
  if (updates.newCapacity)           product.capacity = updates.newCapacity;

  return dumpFrontmatter(parsed.data, parsed.body);
}

export interface ProductSnapshot {
  rank: number;
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
    rank: typeof product.rank === 'number' ? product.rank : 0,
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

export function extractProductSnapshotByRank(content: string, rank: number): ProductSnapshot | null {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) return null;

  const normalizedRank = typeof rank === 'number' ? rank : Number(rank);
  if (!Number.isFinite(normalizedRank)) return null;

  const product = (parsed.data.products as Array<Record<string, unknown>>)
    .find(p => p.rank === normalizedRank);
  if (!product) return null;

  return {
    rank: typeof product.rank === 'number' ? product.rank : 0,
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

export interface ProductExpectedFields {
  name?: string | null;
  capacity?: string | null;
  price?: number | null;
  rakutenUrl?: string | null;
}

function expectedFieldMatches(product: Record<string, unknown>, expected: ProductExpectedFields): boolean {
  if (Object.prototype.hasOwnProperty.call(expected, 'name')) {
    const actual = typeof product.name === 'string' ? product.name : null;
    if (actual !== (expected.name ?? null)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'capacity')) {
    const actual = typeof product.capacity === 'string' ? product.capacity : null;
    if (actual !== (expected.capacity ?? null)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'price')) {
    const actual = typeof product.price === 'number' ? product.price : null;
    if (actual !== (expected.price ?? null)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'rakutenUrl')) {
    const actual = typeof product.rakutenUrl === 'string' ? product.rakutenUrl : null;
    if (actual !== (expected.rakutenUrl ?? null)) return false;
  }
  return true;
}

export function updateProductInFrontmatterByRank(
  content: string,
  rank: number,
  updates: ProductUpdates,
  expected: ProductExpectedFields = {}
): { content: string; changed: boolean; reason?: string; before?: ProductSnapshot; after?: ProductSnapshot } {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) {
    return { content, changed: false, reason: 'frontmatter/products not found' };
  }

  const normalizedRank = typeof rank === 'number' ? rank : Number(rank);
  if (!Number.isFinite(normalizedRank)) {
    return { content, changed: false, reason: 'invalid rank' };
  }

  type P = Record<string, unknown>;
  const product = (parsed.data.products as P[]).find(p => p.rank === normalizedRank);
  if (!product) return { content, changed: false, reason: `rank ${rank} not found` };
  if (!expectedFieldMatches(product, expected)) {
    return { content, changed: false, reason: 'expected fields mismatch' };
  }

  const before = extractProductSnapshotByRank(content, normalizedRank) ?? undefined;
  // null / undefined はいずれも「更新しない」（updateProductInFrontmatter と同じ扱い）
  if (updates.price != null)         product.price = updates.price;
  if (updates.rating != null)        product.rating = updates.rating;
  if (updates.reviewCount != null)   product.reviewCount = updates.reviewCount;
  if (updates.affiliateUrl)          product.rakutenUrl = updates.affiliateUrl;
  if (updates.imageUrl)              product.imageUrl = updates.imageUrl;
  if (updates.pricePerUnit != null)  product.pricePerUnit = updates.pricePerUnit;
  if (updates.newName)               product.name = updates.newName;
  if (updates.newCapacity)           product.capacity = updates.newCapacity;

  const nextContent = dumpFrontmatter(parsed.data, parsed.body);
  const after = extractProductSnapshotByRank(nextContent, normalizedRank) ?? undefined;
  return { content: nextContent, changed: nextContent !== content, before, after };
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

// CAPACITY_UNITS / PACK_UNITS / MULTIPLY_RE_CHAR_CLASS / normalizeItemName は
// src/lib/capacity.ts から import 済み（上部参照）。
const SALES_QUANTITY_UNITS = '枚|個|本|袋|セット|パック|箱|ケース';
const MEASURE_UNITS = 'mL|ml|L|g|kg';
// 1個あたりの分量で数える剤形の単位。"2.8g×90錠" の 2.8g は総量ではなく
// 1錠あたりの重量なので、この単位が続く場合は先頭の重量表記を捨てる。
const DOSAGE_UNITS = '錠|粒|包|カプセル';
// 組数選択型の列挙検出に使う単位（既存 SALES_QUANTITY_UNITS + ロール/組）
const VARIANT_ENUM_UNITS = '枚|個|本|袋|セット|パック|箱|ケース|ロール|組';
// 列挙区切り（半角/全角カンマ・読点・スラッシュ・中黒）
const VARIANT_ENUM_DELIMITERS = ',，、/／・';
// 列挙の区切り＝上記の記号、または空白のみ。
// 楽天の組数選択型商品名は "80枚入 3個 6個 12個" のように空白だけで列挙されることがあり、
// 記号区切りだけを見ていると最安バリアント価格（3個分）が最大容量（12個）と組み合わされる。
const VARIANT_ENUM_SEPARATOR = `\\s*(?:[${VARIANT_ENUM_DELIMITERS}]|\\s)\\s*`;

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

// extractCapacityTotal / normalizeCapacityTotal / calcPricePerUnit は
// src/lib/capacity.ts へ移送（上部で import + 再エクスポート済み）。

/**
 * 楽天の「組数を選べる」商品名かどうかを判定する。
 * 同一の販売数量単位が列挙区切りで2つ以上並ぶ場合に true。
 * 例: "(60個,30個)" → true（最安バリアント価格が返るため自動更新を避ける）
 * 例: "80枚入 3個 6個 12個" → true（空白区切りの組数選択）
 * 例: "200枚×5箱"   → false（乗算チェーンであり変種ではない）
 * 例: "162枚 54枚x3セット" → false（空白区切りだが 162 = 54×3 の内訳表記）
 */
export function isSalesQuantityVariantItemName(itemName: string): boolean {
  const normalized = normalizeItemName(itemName);
  const re = new RegExp(
    `(\\d[\\d,]*)\\s*(${VARIANT_ENUM_UNITS})(${VARIANT_ENUM_SEPARATOR})(\\d[\\d,]*)\\s*(${VARIANT_ENUM_UNITS})`,
    'gi'
  );
  const multipliers = getBreakdownMultipliers(normalized);
  for (const match of normalized.matchAll(re)) {
    if (match[2].toLowerCase() !== match[5].toLowerCase()) continue;
    const a = parseInt(match[1].replace(/,/g, ''), 10);
    const b = parseInt(match[4].replace(/,/g, ''), 10);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
    // 空白のみの区切りは「総量＋内訳」（例: "162枚 54枚x3セット"）でも成立してしまうため、
    // 商数が商品名中の乗数として実在する場合は内訳とみなして変種扱いしない。
    // 記号区切り（"60個,30個"）は列挙の意図が明確なのでこの緩和を適用しない。
    const isWhitespaceOnlySeparator = !/[,，、/／・]/.test(match[3]);
    if (isWhitespaceOnlySeparator && isConsistentCapacityBreakdown([a, b], multipliers)) continue;
    return true;
  }
  return false;
}

/**
 * 楽天の容量選択式商品名かどうかを判定する。
 * 例: "2kg 5kg 10kg" は価格が最小容量側を指すことがあるため自動単価更新を避ける。
 */
/**
 * 「買い手が容量を選ぶ」ことを示す語。これを含む商品名は内訳の整合が取れても
 * 変種扱いのままにする（最安バリアント価格が返るため自動更新を避ける）。
 * ※「セット」「詰替」のような単なる曖昧語は内訳表記にも普通に現れるので含めない。
 */
const CAPACITY_SELECTION_TERMS = [
  "選べる",
  "選択",
  "サイズ選択",
  "バリエーション",
  "よりどり",
  "アソート",
  "ランダム",
  "各種",
  "福袋",
];

/**
 * 商品名に現れる「乗数」を集める。内訳表記の整合判定に使う。
 * 対象は ①乗算記号の直後の数値（"×150個" の 150）と
 *       ②販売数量単位・梱包単位が続く数値（"3袋" の 3）。
 */
function getBreakdownMultipliers(normalized: string): Set<number> {
  const multipliers = new Set<number>();
  const patterns = [
    new RegExp(`[${MULTIPLY_RE_CHAR_CLASS}]\\s*(\\d[\\d,]*)`, 'gi'),
    new RegExp(`(\\d[\\d,]*)\\s*(?:${SALES_QUANTITY_UNITS}|${PACK_UNITS})`, 'gi'),
  ];
  for (const re of patterns) {
    for (const match of normalized.matchAll(re)) {
      const value = parseInt(match[1].replace(/,/g, ''), 10);
      if (Number.isFinite(value) && value > 1) multipliers.add(value);
    }
  }
  return multipliers;
}

/**
 * 同一単位に複数の総量が並んでいても、それが「内訳 → 総量」の関係なら変種ではない。
 * 例: "5g×150個 750g×3袋" は 5g × 150 = 750g で、150 が商品名中の乗数として実在する。
 * 小さい順に並べて隣接する商が整数かつ商品名中の乗数と一致する場合のみ内訳とみなす。
 */
function isConsistentCapacityBreakdown(totals: number[], multipliers: Set<number>): boolean {
  const sorted = [...totals].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const smaller = sorted[i - 1];
    const larger = sorted[i];
    if (smaller <= 0) return false;
    const quotient = larger / smaller;
    const rounded = Math.round(quotient);
    if (Math.abs(quotient - rounded) > 1e-6) return false;
    if (!multipliers.has(rounded)) return false;
  }
  return true;
}

/**
 * 楽天の容量選択式商品名かどうかを判定する。
 * 例: "2kg 5kg 10kg" は価格が最小容量側を指すことがあるため自動単価更新を避ける。
 * ただし "5g×150個 750g×3袋" のような内訳表記は変種ではないので除外する。
 */
/**
 * 楽天 API の itemPriceMin1 / itemPriceMax1 が異なる＝購入時の選択肢で価格が変わる商品。
 * この場合 itemPrice は**最安バリアントの価格**を返すため、記事 capacity（多くは
 * 最大構成）と組み合わせると単価が実態より安く表示される。商品名から変種を
 * 読み取れないケース（"96枚" とだけ書かれた 96枚×12個 の出品など）も拾えるので、
 * 商品名ベースの判定と併用する。
 */
export function hasVariantPriceRange(
  priceMin: number | null | undefined,
  priceMax: number | null | undefined
): boolean {
  if (typeof priceMin !== 'number' || typeof priceMax !== 'number') return false;
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) return false;
  if (priceMin <= 0 || priceMax <= 0) return false;
  return priceMin !== priceMax;
}

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

  const isSelectableItem = CAPACITY_SELECTION_TERMS.some(term => normalized.includes(term));
  const multipliers = getBreakdownMultipliers(normalized);
  return [...totalsByUnit.values()].some(
    totals => totals.size >= 2 && (isSelectableItem || !isConsistentCapacityBreakdown([...totals], multipliers))
  );
}

/**
 * 楽天商品名から容量文字列を抽出する（extractCapacityTotal で解析可能な形式で返す）
 * 例: "スコッティ 200枚×5箱"      → "200枚×5箱"
 * 例: "ネピア 60枚（2,880枚）"    → "（2,880枚）"
 * 例: "ビオレ ボディウォッシュ 500mL" → "500mL"
 */
/**
 * 冗長な「総数 × 内訳」表記を内訳括弧へ畳み込む。
 * 例: "75m×48ロール×4ロール×12パック"（48 = 4×12 の重複表記）
 *   → "75m×48ロール（4ロール×12パック）"
 * extractCapacityTotal は括弧内を乗数から除外するため、総量の二重カウントを防ぐ。
 * 「総数」と「後続の同種 PACK_UNIT 因子の積」が一致し、かつ総数の単位が
 * 内訳先頭の単位と一致する場合のみ畳み込む（誤検出防止のガード）。
 */
function collapseRedundantPackBreakdown(chain: string): string {
  const parts = chain.split('×').map(p => p.trim()).filter(Boolean);
  if (parts.length < 3) return chain;
  const tokenRe = new RegExp(`^(\\d[\\d,]*)\\s*(${CAPACITY_UNITS}|${PACK_UNITS})$`);
  const parsed = parts.map(p => {
    const m = p.match(tokenRe);
    return m ? { num: parseInt(m[1].replace(/,/g, ''), 10), unit: m[2], raw: p } : null;
  });
  if (parsed.some(p => p === null)) return chain;
  const tokens = parsed as { num: number; unit: string; raw: string }[];
  const packUnitRe = new RegExp(`^(${PACK_UNITS})$`);

  // 先頭自体が集合単位で、後続がその内訳になっているケースは内訳を落として総数だけ返す。
  // 例: "60箱×5箱×12パック"（"60箱 (5箱×12パック)" 由来）→ "60箱"
  // 括弧付きで残すと extractCapacityTotal のパターン4が括弧内の × を乗数として
  // 拾ってしまう（60×12=720箱）ため、ここで内訳ごと捨てる。
  if (packUnitRe.test(tokens[0].unit)) {
    const rest = tokens.slice(1);
    if (
      rest.every(t => packUnitRe.test(t.unit)) &&
      rest.reduce((acc, t) => acc * t.num, 1) === tokens[0].num
    ) {
      return tokens[0].raw;
    }
  }

  for (let i = 1; i < tokens.length - 1; i++) {
    if (!packUnitRe.test(tokens[i].unit)) continue;
    const rest = tokens.slice(i + 1);
    if (!rest.every(t => packUnitRe.test(t.unit))) continue;
    if (tokens[i + 1].unit !== tokens[i].unit) continue;
    const product = rest.reduce((acc, t) => acc * t.num, 1);
    if (product !== tokens[i].num) continue;
    const head = tokens.slice(0, i + 1).map(t => t.raw).join('×');
    const breakdown = rest.map(t => t.raw).join('×');
    return `${head}（${breakdown}）`;
  }
  return chain;
}

// 楽天商品名の先頭に付く販促枠。容量ではない数量（"【送料無料・2個セット】"
// "【パッケージリニューアル 6箱 本州送料無料】"）を含み、本体の容量表記より先に
// マッチして抽出を誤らせるため、容量抽出の前に取り除く。
// 販促語を含む枠だけを対象にし、"【3g×30】" のような容量そのものの枠は残す。
const PROMO_BRACKET_RE =
  /【[^】]*(?:送料無料|ポイント|PT\d|倍|クーポン|セール|割引|最安|リニューアル|限定|あす楽|即納|在庫|まとめ買い|お得|SALE|新生活|訳あり)[^】]*】/gi;

// 販促枠であっても、中に "36枚 ×6個" のような数量の乗算チェーンがある場合は
// そこが唯一の総量表記であることがある（例: "【送料込・まとめ買い36枚 ×6個セット】…36枚"）。
// 除去すると総量を取りこぼして単価が過大になるため、この形だけは残す。
function promoBracketHoldsQuantityChain(bracket: string): boolean {
  const qty = `${CAPACITY_NUMBER_PATTERN}\\s*(?:${CAPACITY_UNITS}|${PACK_UNITS})`;
  return new RegExp(`${qty}\\s*[${MULTIPLY_RE_CHAR_CLASS}]\\s*${qty}`).test(bracket);
}

function normalizeItemNameForCapacityExtraction(itemName: string): string {
  let normalized = normalizeItemName(itemName);

  // 販促枠を除去する。日付やポイント倍率が容量として拾われるのを防ぐ
  // （"【5月15日限定…】" の "15日" が 円/日 の容量になっていた）。
  // "【送料無料・2個セット】…2.8g×90錠×2個セット" が先頭の "2個" を
  // 総量と取り違える問題も同時に解消する。
  normalized = normalized.replace(PROMO_BRACKET_RE, m =>
    promoBracketHoldsQuantityChain(m) ? m : ' '
  );

  // "2.8g×90錠" の先頭は1錠あたりの重量。総量は錠数側なので重量表記を落とす
  // （残すと 2.8×90×2=504g という実在しない総重量になり、記事の「錠」と単位も食い違う）。
  // 剤形単位が続く場合に限るため "3.8L×3本" のような実容量は影響を受けない。
  normalized = normalized.replace(
    new RegExp(
      `(${CAPACITY_NUMBER_PATTERN})\\s*(?:${MEASURE_UNITS})\\s*[${MULTIPLY_RE_CHAR_CLASS}]\\s*(?=\\d[\\d,]*\\s*(?:${DOSAGE_UNITS}))`,
      'gi'
    ),
    ''
  );

  // 商品型番・サイズ表記は単価計算用の容量ではない。
  normalized = normalized
    .replace(/\d[\d,]*(?:\.\d+)?\s*mm\b/gi, '')
    .replace(/\d[\d,]*(?:\.\d+)?\s*[×xX*＊]\s*\d[\d,]*(?:\.\d+)?\s*cm\b/gi, '');

  // ニキビパッチでは「粒」がシート上のパッチ枚数として使われるため、記事側の「枚」と揃える。
  if (/パッチ|patch/i.test(normalized)) {
    normalized = normalized.replace(/(\d[\d,]*)\s*粒/g, '$1枚');
  }

  // キッチンペーパー/タオル・クッキングペーパーでは枚数を「カット」で数える（1カット=1枚）。
  // ロール品も円/枚でペーパータオルと横並び比較できるよう「カット」を「枚」に揃える。
  // 「2枚重ね」等の重ね数（ply）は容量ではないため、カット変換より先に除去する
  // （例: "4ロール（2枚重ね 100カット）×12パック" → "4ロール（100枚）×12パック"）。
  if (/キッチン\s*(?:ペーパー|タオル)|ペーパータオル|クッキングペーパー/.test(normalized)) {
    normalized = normalized
      .replace(/(\d[\d,]*)\s*枚\s*重ね?/g, '')
      .replace(/(\d[\d,]*)\s*カット/g, '$1枚');
  }

  return normalized.trim();
}

function extractSalesQuantityCapacityFromItemName(itemName: string): string | null {
  const normalized = normalizeItemName(itemName);
  const parenSetM = normalized.match(/[（(][^）)]*?(\d[\d,]*)\s*個(?:入)?\s*[×xX*＊]\s*(\d[\d,]*)\s*セット[^）)]*[）)]/);
  if (parenSetM) {
    return `${parenSetM[1]}個×${parenSetM[2]}セット`;
  }

  const packSetM = normalized.match(/(\d[\d,]*)\s*個\s*パック\s*[×xX*＊]\s*(\d[\d,]*)\s*セット/);
  if (packSetM) {
    return `${packSetM[1]}個×${packSetM[2]}セット`;
  }

  const packParenSetM = normalized.match(/(\d[\d,]*)\s*個\s*パック\s*[（(]\s*(\d[\d,]*)\s*セット\s*[）)]/);
  if (packParenSetM) {
    return `${packParenSetM[1]}個×${packParenSetM[2]}セット`;
  }

  const countPackM = normalized.match(/(\d[\d,]*)\s*個\s*(?:入|パック|セット)/);
  if (countPackM) {
    return `${countPackM[1]}個`;
  }

  return null;
}

function shouldPreferSalesQuantityOverMeasure(itemName: string): boolean {
  return /防カビくん煙剤|お風呂カビーヌ|風呂釜クリーナー/.test(normalizeItemName(itemName));
}

export function extractCapacityFromItemName(itemName: string): string | null {
  itemName = normalizeItemNameForCapacityExtraction(itemName);
  if (shouldPreferSalesQuantityOverMeasure(itemName)) {
    const salesQuantity = extractSalesQuantityCapacityFromItemName(itemName);
    if (salesQuantity) return salesQuantity;
  }
  // 体重上限表記（「5kgまで」「3000gまで」「〜5000g」）を除去して容量誤抽出を防ぐ
  // 例: "5kgまで72枚入" → "72枚入" / "お誕生〜3000g 紙おむつ" → "紙おむつ"
  itemName = itemName
    .replace(/\d[\d,]*(?:\.\d+)?\s*(?:kg|g)\s*まで/g, '')
    .replace(/(?:〜|~)\s*\d[\d,]*(?:\.\d+)?\s*(?:kg|g)/g, '')
    .trim();
  // 先頭の【N個/セット/パック】を乗算子として処理
  // 例: "【2個】ビオレ 500mL" → "500mL×2個"（乗数が未内包なので折り込む）
  // 例: "【12個】グーン 70枚×12P" → "70枚×12"（×12に既に内包されているのでそのまま）
  const leadingCountRe = /^【(\d[\d,]*)(?:個|セット|パック)】\s*/;
  const leadingCountM = itemName.match(leadingCountRe);
  if (leadingCountM) {
    const multiplierStr = leadingCountM[1];
    const multiplierNum = parseInt(multiplierStr.replace(/,/g, ''), 10);
    const countUnit = (leadingCountM[0].match(/個|セット|パック/) ?? ['個'])[0];
    const rest = itemName.slice(leadingCountM[0].length);
    const restCap = rest ? extractCapacityFromItemName(rest) : null;
    if (restCap) {
      // multiplierNum が restCap のチェーンに既に含まれているか確認
      const embedded = new RegExp(`[×xX*＊]\\s*${multiplierNum}(?:[^\\d]|$)`).test(restCap);
      return embedded ? restCap : `${restCap}×${multiplierStr}${countUnit}`;
    }
    // rest から抽出できない場合はブラケットを除去して後続パターンで処理
    itemName = rest;
  }
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
  const widthLengthRe = new RegExp(`\\d[\\d,]*(?:\\.\\d+)?\\s*cm\\s*[${MULTIPLY_RE_CHAR_CLASS}]\\s*(${CAPACITY_NUMBER_PATTERN})\\s*m`, 'i');
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
  const mulRe = new RegExp(`(${CAPACITY_NUMBER_PATTERN})\\s*(${CAPACITY_UNITS}|${PACK_UNITS})`);
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
      // × より前に数字が混入、またはアルファベットで終わる場合は別の数値表現として中断
      // （例: "HX9043" の X を乗算記号として誤認する型番混入を防ぐ）
      if (/\d/.test(xMatch[1]) || /[A-Za-z]$/.test(xMatch[1])) break;
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
    if (foundChain) return collapseRedundantPackBreakdown(result);

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
      return collapseRedundantPackBreakdown(chainResult);
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
        return collapseRedundantPackBreakdown(result);
      }
    }

    // パターン1e: PACK×PACK 乗算チェーンと CAPACITY_UNIT が別々に出現するケースを結合
    // 例: "12ロール(シングル) 12ロール×4パック(48ロール) 100m" → "100m×12ロール×4パック"
    // Pattern 1/1c/1d が CAPACITY_UNIT 起点のチェーンを拾えなかった場合のフォールバック
    const packXpackRe = new RegExp(`(\\d[\\d,]*)\\s*(${PACK_UNITS})\\s*[${MULTIPLY_RE_CHAR_CLASS}]\\s*(\\d[\\d,]*)\\s*(${PACK_UNITS})`);
    const packXpackM = itemName.match(packXpackRe);
    if (packXpackM) {
      const capUnitSearchRe = new RegExp(`(${CAPACITY_NUMBER_PATTERN})\\s*(${CAPACITY_UNITS})`);
      const capUnitM = itemName.match(capUnitSearchRe);
      if (capUnitM) {
        return `${capUnitM[1]}${capUnitM[2]}×${packXpackM[1]}${packXpackM[2]}×${packXpackM[3]}${packXpackM[4]}`;
      }
    }

    // パターン1f: "のN個[セット/パック]" またはスペース+"N個[セット/パック]" の販売数量乗算
    // × 記号なしでスペースや「の」で区切られる Yahoo 商品名に対応
    // 例: "52枚の4個セット" → "52枚×4個"  "400mL 3個セット" → "400mL×3個"
    // 「の」または「セット/パック」を必須にする。どちらも無い単なる並記
    //（"大容量 80個 90個" のようなサイズ選択）を乗算と誤認しないため。
    const koSetRe = /^\s*(の)?\s*(\d[\d,]*)\s*個(セット|パック)?/;
    const koSetM = remaining.match(koSetRe);
    if (koSetM && (koSetM[1] || koSetM[3])) {
      const qty = parseInt(koSetM[2].replace(/,/g, ''), 10);
      if (qty > 1) return `${result}×${koSetM[2]}個`;
    }
  }

  // パターン1b: スペース区切りの数量表現 "50m 72ロール" → "50m×72ロール"
  // × を使わず「長さ ロール数」と並べる楽天商品名（例: "50m 72ロール ダブル"）に対応
  const spaceMulRe = new RegExp(`(${CAPACITY_NUMBER_PATTERN})\\s*(${CAPACITY_UNITS})\\s+(\\d[\\d,]*)\\s*(ロール|パック|セット)`);
  const spaceMulM = itemName.match(spaceMulRe);
  if (spaceMulM && parseInt(spaceMulM[3].replace(/,/g, ''), 10) > 1) {
    return `${spaceMulM[1]}${spaceMulM[2]}×${spaceMulM[3]}${spaceMulM[4]}`;
  }

  // パターン1g: "N単位入 M袋/箱/個" 形式の販売数量
  // 「入」を挟むため乗算チェーン（パターン1）にもスペース区切り（パターン1c）にも
  // 拾われず、入数だけを返して総量を取りこぼしていた。
  //   "30枚入 12袋"        → 30枚×12袋
  //   "150個入り 3袋セット"  → 150個×3袋
  //   "30錠入(3g×30) 3箱"  → 30錠×3箱   （括弧の内訳注釈は読み飛ばす）
  //   "15枚入*3袋セット"     → 15枚×3袋
  // 「入」は必須にする。省略可にすると "80個 90個" のような
  // サイズ選択の並記を乗算と誤認する（ネピア ソフトパックで実際に踏んだ）。
  const enteredPackRe = new RegExp(
    `(${CAPACITY_NUMBER_PATTERN})\\s*(${CAPACITY_UNITS})\\s*入り?` +
      `\\s*(?:[（(][^）)]*[）)])?` +
      `\\s*[${MULTIPLY_RE_CHAR_CLASS}]?\\s*` +
      `(\\d[\\d,]*)\\s*(${PACK_UNITS}|袋|個)`
  );
  const enteredPackM = itemName.match(enteredPackRe);
  if (enteredPackM && parseInt(enteredPackM[3].replace(/,/g, ''), 10) > 1) {
    return `${enteredPackM[1]}${enteredPackM[2]}×${enteredPackM[3]}${enteredPackM[4]}`;
  }

  // パターン2: 括弧内総量 "（2,880枚）"
  const bracketRe = new RegExp(`[（(](${CAPACITY_NUMBER_PATTERN})\\s*(${CAPACITY_UNITS})[）)]`);
  const bracketM = itemName.match(bracketRe);
  if (bracketM) {
    return `（${bracketM[1]}${bracketM[2]}）`;
  }

  // パターン3: シンプル "500mL"（最初に見つかる数値+単位）
  const simpleRe = new RegExp(`(${CAPACITY_NUMBER_PATTERN})\\s*(${CAPACITY_UNITS})`);
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
  const normalized = normalizeItemNameForCapacityExtraction(itemName);
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
  const normalized = normalizeItemNameForCapacityExtraction(itemName);
  return new RegExp(`[（(][^）)]*?[\\d,]+\\s*(${CAPACITY_UNITS})\\s*[：:][^）)]*[）)]`).test(normalized);
}

function isMeasureUnit(unit: string): boolean {
  return new RegExp(`^(${MEASURE_UNITS})$`, 'i').test(unit);
}

export function analyzeCapacityFromItemName(itemName: string): CapacityAnalysis {
  const normalizedName = normalizeItemNameForCapacityExtraction(itemName);
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

// "8.8.8.5L" "2.2.7kg" のような小数の連鎖は、容量を name へ多重挿入した破損痕
const REPEATED_DECIMAL_RE = /\d(?:\.\d+){2,}/;

/**
 * name 内の容量トークン `embeddedCapacity` の開始位置を、数値の途中に食い込まない
 * 位置に限って返す。見つからなければ -1。
 *
 * 例: "…3.5kg" の中の "5kg" は直前が "." のため対象外（置換すると "3.3.5kg" になる）
 */
function findStandaloneCapacityIndex(name: string, capacityToken: string): number {
  for (let from = 0; from <= name.length - capacityToken.length; ) {
    const idx = name.indexOf(capacityToken, from);
    if (idx === -1) return -1;
    const before = idx > 0 ? name[idx - 1] : '';
    const after = name[idx + capacityToken.length] ?? '';
    // 直前が数字・小数点・カンマ → より長い数値表記の一部
    // 直後が数字 → 数値の途中で切っている
    if (!/[\d.,]/.test(before) && !/\d/.test(after)) return idx;
    from = idx + 1;
  }
  return -1;
}

/**
 * 置換後の name をもう一度解析したとき capacity と同値になるか。
 * 同値なら次回実行では「name の埋め込み容量 == capacity」で早期スキップされるため、
 * 何度実行しても name が変化しない（冪等）ことが保証できる。
 */
function isIdempotentReplacement(nextName: string, capacity: string): boolean {
  const extracted = extractCapacityFromItemName(nextName);
  if (!extracted) return false;
  if (extracted === capacity) return true;
  const extractedTotal = extractCapacityTotal(extracted);
  const capacityTotal = extractCapacityTotal(capacity);
  return Boolean(
    extractedTotal &&
    capacityTotal &&
    extractedTotal.unit.toLowerCase() === capacityTotal.unit.toLowerCase() &&
    extractedTotal.total === capacityTotal.total
  );
}

/**
 * name に埋め込まれた容量 `embeddedCapacity` を `capacity` に置き換える。
 * 安全に置換できない場合は null を返す（呼び出し側は name を変更しない）。
 *
 * 「8.5L」に容量を挿し込み続けて「8.8.8.8.8.8.5L」になる多重挿入バグの再発防止として、
 * 数値境界・破損パターン・冪等性の3点を満たす場合だけ置換を許可する。
 */
export function replaceCapacityInProductName(
  name: string,
  embeddedCapacity: string,
  capacity: string
): string | null {
  if (!name || !embeddedCapacity || !capacity) return null;
  if (embeddedCapacity === capacity) return null;

  const idx = findStandaloneCapacityIndex(name, embeddedCapacity);
  if (idx === -1) return null;

  // indexOf/slice で置換（capacity に $ が含まれる場合の String.replace 誤動作を回避）
  const nextName = name.slice(0, idx) + capacity + name.slice(idx + embeddedCapacity.length);
  if (nextName === name) return null;
  if (REPEATED_DECIMAL_RE.test(nextName) && !REPEATED_DECIMAL_RE.test(name)) return null;
  if (!isIdempotentReplacement(nextName, capacity)) return null;

  return nextName;
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
 * rank を指定して商品を削除し、残りの rank を1から振り直す。
 *
 * 同一記事内に同名の商品が2件ある（rakutenUrl 重複の浄化時に起きる）場合、
 * name 指定の removeProductFromFrontmatter では先頭の1件しか特定できないため、
 * どちらを残すか決められる rank 指定版を使う。
 */
export function removeProductFromFrontmatterByRank(content: string, rank: number): string | null {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) return null;

  type P = Record<string, unknown>;
  const products = parsed.data.products as P[];
  if (products.length <= 1) return null;

  const idx = products.findIndex(p => p.rank === rank);
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
    // capacity 側が複合表記（例: "60日用×2本（120日）"）の場合、name 内の単純トークン
    // （"60日"）を複合文字列で置換すると商品名が壊れるため注入しない。
    if (/[×xX]/.test(capacity)) continue;

    const embeddedParsed = extractCapacityTotal(embeddedCap);
    const capacityParsed = extractCapacityTotal(capacity);
    if (!embeddedParsed || !capacityParsed) continue;
    if (embeddedParsed.unit !== capacityParsed.unit) continue;
    if (embeddedParsed.total === capacityParsed.total) continue;

    const nextName = replaceCapacityInProductName(name, embeddedCap, capacity);
    if (nextName === null) continue;

    product.name = nextName;
    log.push(`rank ${rank}: name の ${embeddedCap} を ${capacity} に修正`);
    changed = true;
  }

  if (!changed) return { content, changed: false, log };
  return { content: dumpFrontmatter(parsed.data, parsed.body), changed: true, log };
}

/**
 * フロントマターの updatedAt フィールドを指定日付で更新する（YYYY-MM-DD 形式）
 * updatedAt が存在しない場合は publishedAt の直後に挿入する
 *
 * 値は必ずダブルクォートで囲む。dumpFrontmatter（yaml.dump の forceQuotes）が
 * 出力する形式と揃えないと、update-products（この関数）と
 * update-yahoo-products / inject-faqs（ダンプ経由）で引用符の有無が交互に入れ替わり、
 * 実質無変更の差分ノイズになるため。
 */
export function updateUpdatedAt(content: string, date: string): string {
  if (/^updatedAt:\s+\S+/m.test(content)) {
    return content.replace(/^(updatedAt:)\s+\S+/m, `$1 "${date}"`);
  }
  if (/^publishedAt:\s+\S+/m.test(content)) {
    return content.replace(/^(publishedAt:\s+\S+)/m, `$1\nupdatedAt: "${date}"`);
  }
  // どちらもない場合はフロントマター末尾の closing --- 直前に追加
  return content.replace(/^(---\s*)$/m, `updatedAt: "${date}"\n$1`);
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
  // ティッシュの「組」は1組=2枚。並び替え・グループ化のみ枚換算し、
  // 円/枚の商品（箱ティッシュ）と同一グループで正しく単価比較できるようにする。
  // 表示用の pricePerUnit（円/組）は calcPricePerUnit 側でそのまま保持する。
  if (normalizedUnit === '組') return { value: value / 2, unit: '枚' };

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
 * 各商品の pricePerUnit を price + capacity + 記事の単位ポリシー（preferUnit）から再計算し同期する。
 * API マッチ失敗等でスキップされた商品でも、ローカルの price/capacity から算出できる限り
 * 単価表記を最新ポリシーに揃える（例: ティッシュの「円/枚」を「円/組」へ）。
 * capacity が解析不能で算出できない商品（calc が null）は既存値を保持する。
 */
export function syncPricePerUnitWithPolicy(
  content: string,
  preferUnit?: string,
  skipNames?: ReadonlySet<string> | {
    skipNames?: ReadonlySet<string>;
    skipProduct?: (product: ProductSnapshot) => boolean;
  }
): { content: string; changed: boolean; log: string[] } {
  const parsed = parseFrontmatter(content);
  if (!parsed || !Array.isArray(parsed.data.products)) {
    return { content, changed: false, log: [] };
  }

  type P = Record<string, unknown>;
  const products = parsed.data.products as P[];
  let changed = false;
  const log: string[] = [];
  const skipConfig = skipNames && typeof (skipNames as { has?: unknown }).has === 'function'
    ? { skipNames: skipNames as ReadonlySet<string>, skipProduct: undefined }
    : (skipNames as { skipNames?: ReadonlySet<string>; skipProduct?: (product: ProductSnapshot) => boolean } | undefined);
  const skipNameSet = skipConfig?.skipNames;
  const skipProduct = skipConfig?.skipProduct;

  for (const product of products) {
    const name = typeof product.name === 'string' ? product.name : null;
    if (name && skipNameSet?.has(name)) continue;
    const snapshot: ProductSnapshot = {
      rank: typeof product.rank === 'number' ? product.rank : 0,
      name: name ?? '',
      price: typeof product.price === 'number' ? product.price : null,
      rating: typeof product.rating === 'number' ? product.rating : null,
      reviewCount: typeof product.reviewCount === 'number' ? product.reviewCount : null,
      rakutenUrl: typeof product.rakutenUrl === 'string' ? product.rakutenUrl : null,
      imageUrl: typeof product.imageUrl === 'string' ? product.imageUrl : null,
      capacity: typeof product.capacity === 'string' ? product.capacity : null,
      pricePerUnit: typeof product.pricePerUnit === 'string' ? product.pricePerUnit : null,
    };
    if (skipProduct?.(snapshot)) continue;
    const price = typeof product.price === 'number' ? product.price : null;
    const capacity = typeof product.capacity === 'string' ? product.capacity : null;
    if (price === null || price <= 0 || !capacity) continue;

    const computed = calcPricePerUnit(price, capacity, preferUnit);
    if (!computed) continue;

    const current = typeof product.pricePerUnit === 'string' ? product.pricePerUnit : null;
    if (current === computed) continue;

    const rank = typeof product.rank === 'number' ? product.rank : '?';
    log.push(`rank ${rank}: pricePerUnit "${current ?? '(なし)'}" -> "${computed}"`);
    product.pricePerUnit = computed;
    changed = true;
  }

  if (!changed) return { content, changed: false, log: [] };
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
 * フロントマターから記事種別を抽出する。未指定は "comparison" として扱う。
 */
export function extractArticleType(content: string): 'comparison' | 'review' {
  const parsed = parseFrontmatter(content);
  if (!parsed) return 'comparison';
  return parsed.data.articleType === 'review' ? 'review' : 'comparison';
}

/**
 * 楽天 API による商品自動更新の対象外とする記事種別。
 * サービス記事（ウォーターサーバー等の ASP 案件）は products[] を持たないため、
 * update-products / check-additions / check-replacements のいずれからも除外する。
 */
const NON_PRODUCT_ARTICLE_TYPES = new Set(['service']);

/**
 * 記事が楽天 API による商品自動更新の対象かどうかを返す。
 * articleType 未指定（既存記事）は従来どおり対象とする。
 */
export function isProductManagedArticle(content: string): boolean {
  const parsed = parseFrontmatter(content);
  if (!parsed) return true;
  const articleType = parsed.data.articleType;
  if (typeof articleType !== 'string') return true;
  return !NON_PRODUCT_ARTICLE_TYPES.has(articleType);
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
