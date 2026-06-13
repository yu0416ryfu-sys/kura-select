// 容量解析・単価計算の純粋関数群。
// scripts/lib/frontmatter.ts と src コンポーネント（ProductCard / ComparisonTable 等）の
// 双方から利用する。js-yaml 等のランタイム依存は持たず、client バンドルへ安全に含められる。

// ── 単位定義 ──────────────────────────────────────────────────────────────
// 「日」は液体蚊取り取替えボトルなど「対応日数」が実質的なコスパ単位になる商材向け。
// 既存記事の capacity に「日」表記は無いため追加による誤解析の影響はない。
export const CAPACITY_UNITS = 'mL|ml|kg|L|g|m|枚|本|個|袋|巻|回|粒|包|錠|日';
// 基底単位（"数値unit×N..." の先頭・単独パターンで許可する単位）。
// 「組」はティッシュの "200組×80個" / "150組×5箱" を 円/組 で計算するために含める。
// ただし括弧パターン（パターン1）では "360枚（180組）×60箱" の「（180組）」を
// 総量と誤認するため、CAPACITY_UNITS（組を含まない）を使い分ける。
export const BASE_CAPACITY_UNITS = `${CAPACITY_UNITS}|組`;
export const PACK_UNITS = 'ロール|パック|セット|箱|缶|ケース';
export const MULTIPLY_RE_CHAR_CLASS = '×xX*＊';

// 容量の数値部分パターン。整数（カンマ区切り可）に加え、"5.26" のような小数も許容する。
// 乗数側（×N本 など）はこのパターンを使わず整数のまま扱う。
// 商品名からの容量抽出（scripts/lib/frontmatter.ts）でも共有し、
// "3.8L" を "8L" と部分抽出するバグを防ぐ。
export const CAPACITY_NUMBER_PATTERN = '[\\d,]+(?:\\.\\d+)?';

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
  // 例: "200組×80個"           → 200×80=16000組
  const mulBaseRe = new RegExp(`^(${CAPACITY_NUMBER_PATTERN})\\s*(${BASE_CAPACITY_UNITS})(.*)`);
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

  // パターン3: シンプルな単位 "30枚" "500g" "750組"
  const simpleRe = new RegExp(`^(${CAPACITY_NUMBER_PATTERN})\\s*(${BASE_CAPACITY_UNITS})`);
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
export function calcPricePerUnit(price: number, capacity: string, targetUnit?: string): string | null {
  if (!Number.isFinite(price) || price <= 0) return null;

  const raw = extractCapacityTotal(capacity);
  if (!raw) return null;

  const normalized = normalizeCapacityTotal(raw);
  let extracted = (targetUnit && normalized?.unit === targetUnit) ? normalized : raw;
  // ティッシュの単位統一: targetUnit が「組」で容量が「枚」表記の箱ティッシュは、
  // 1組=2枚 として組数に換算し、表示単位を組へ揃える（枚/組の混在を解消）。
  if (targetUnit === '組' && extracted.unit === '枚') {
    extracted = { total: extracted.total / 2, unit: '組' };
  }

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

export const ARTICLE_UNIT_POLICY: Record<string, string> = {
  'fabric-softener-comparison': 'mL',
  'laundry-detergent-comparison': 'g',
  // 液体系（L/mL・大文字小文字の混在を mL に統一）
  'dish-detergent-comparison': 'mL',
  'hand-soap-comparison': 'mL',
  'sanitizing-spray-comparison': 'mL',
  'insect-repellent-comparison': 'mL',
  // 液体蚊取りの取替えボトルは「対応日数」が実質のコスパ指標（円/日）
  'mosquito-repellent-liquid-comparison': '日',
  'fabric-deodorizer-comparison': 'mL',
  'sensitive-softener-comparison': 'mL',
  // 粉末・重量系（kg を g に統一）
  'dishwasher-detergent-comparison': 'g',
  // 主たる次元を統一（変換不能な別形態＝個/本/別次元は元表記を保持）
  'shampoo-comparison': 'mL',
  'moisture-absorber-comparison': 'mL',
  'conditioner-comparison': 'mL',
  'body-lotion-comparison': 'mL',
  'bathroom-cleaner-comparison': 'mL',
  'cat-food-comparison': 'g',
  'body-soap-comparison': 'g',
  'kitchen-bleach-comparison': 'g',
  'laundry-bleach-comparison': 'g',
  'room-dry-detergent-comparison': 'g',
  'washing-machine-cleaner-comparison': 'g',
  // ティッシュは枚・組が混在するため「組」（=1回の取り出し）に統一する。
  // 箱ティッシュの「枚」表記は calcPricePerUnit が 1組=2枚 で組換算する。
  'tissue-paper-comparison': '組',
  'tissue-paper-regular-comparison': '組',
  'tissue-paper-moist-comparison': '組',
  'tissue-paper-soft-pack-comparison': '組',
};

export function getArticleTargetUnit(articleId: string): string | undefined {
  return ARTICLE_UNIT_POLICY[articleId];
}
