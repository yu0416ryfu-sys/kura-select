// ASIN 抽出パターン（/dp/ASIN、/gp/product/ASIN、クエリ文字列 ASIN=）
const ASIN_FROM_URL_PATTERNS = [
  /\/dp\/([A-Z0-9]{10})/i,
  /\/gp\/product\/([A-Z0-9]{10})/i,
  /[?&]ASIN=([A-Z0-9]{10})/i,
];

// 単体 ASIN かどうか（10文字英数字）
const ASIN_STANDALONE_PATTERN = /^[A-Z0-9]{10}$/i;

export function extractAmazonAsin(urlOrAsin: string): string | null {
  if (ASIN_STANDALONE_PATTERN.test(urlOrAsin.trim())) {
    return urlOrAsin.trim().toUpperCase();
  }
  for (const pattern of ASIN_FROM_URL_PATTERNS) {
    const match = urlOrAsin.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

export function buildAmazonAffiliateUrl(asin: string, associateTag: string): string {
  return `https://www.amazon.co.jp/dp/${asin}?tag=${associateTag}`;
}

// URL または ASIN を受け取り、affiliate tag を補完した Amazon.co.jp URL を返す
// - 単体 ASIN（10桁英数字）→ /dp/ASIN?tag=... 形式で生成
// - URL → tag= があれば保持、なければ補完（ASIN が取れても既存 URL を壊さない）
export function normalizeAmazonAffiliateUrl(urlOrAsin: string, associateTag: string): string {
  if (ASIN_STANDALONE_PATTERN.test(urlOrAsin.trim())) {
    return buildAmazonAffiliateUrl(urlOrAsin.trim().toUpperCase(), associateTag);
  }
  try {
    const parsed = new URL(urlOrAsin);
    if (!parsed.searchParams.has("tag")) {
      parsed.searchParams.set("tag", associateTag);
    }
    return parsed.toString();
  } catch {
    return urlOrAsin;
  }
}
