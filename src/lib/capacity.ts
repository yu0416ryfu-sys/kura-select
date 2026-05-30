// 容量解析・単価計算の純粋関数群。
// scripts/lib/frontmatter.ts と src コンポーネント（ProductCard / ComparisonTable 等）の
// 双方から利用する。js-yaml 等のランタイム依存は持たず、client バンドルへ安全に含められる。

// ── 単位定義 ──────────────────────────────────────────────────────────────
export const CAPACITY_UNITS = 'mL|ml|kg|L|g|m|枚|本|個|袋|巻|回|粒|包|錠';
export const PACK_UNITS = 'ロール|パック|セット|箱|缶|ケース';
export const MULTIPLY_RE_CHAR_CLASS = '×xX*＊';

// 容量の数値部分パターン。整数（カンマ区切り可）に加え、"5.26" のような小数も許容する。
// 乗数側（×N本 など）はこのパターンを使わず整数のまま扱う。
const CAPACITY_NUMBER_PATTERN = '[\\d,]+(?:\\.\\d+)?';

// 容量数値文字列を数値へ変換する（カンマ除去 + 小数対応）
function parseCapacityNumber(value: string): number {
  return Number.parseFloat(value.replace(/,/g, ''));
}

// 全角英数字を半角へ正規化する
export function normalizeItemName(s: string): string {
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
  const bracketRe = new RegExp(`[（(](${CAPACITY_NUMBER_PATTERN})\\s*(${CAPACITY_UNITS})[）)]`);
  const bracketM = capacity.match(bracketRe);
  if (bracketM) {
    const total = parseCapacityNumber(bracketM[1]);
    if (total > 0) return { total, unit: bracketM[2] };
  }

  // パターン2: "数値unit×N1[×N2...]" の掛け算（複数因子対応）
  // 例: "660mL×2個"           → 660×2=1320mL
  // 例: "500枚×60箱"           → 500×60=30000枚
  // 例: "500枚×5箱×12パック"   → 500×5×12=30000枚
  const mulBaseRe = new RegExp(`^(${CAPACITY_NUMBER_PATTERN})\\s*(${CAPACITY_UNITS})(.*)`);
  const mulBaseM = capacity.match(mulBaseRe);
  if (mulBaseM) {
    const base = parseCapacityNumber(mulBaseM[1]);
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
  const simpleRe = new RegExp(`^(${CAPACITY_NUMBER_PATTERN})\\s*(${CAPACITY_UNITS})`);
  const simpleM = capacity.match(simpleRe);
  if (simpleM) {
    const total = parseCapacityNumber(simpleM[1]);
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
  if (!Number.isFinite(price) || price <= 0) return null;

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
