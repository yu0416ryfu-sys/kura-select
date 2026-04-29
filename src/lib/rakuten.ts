// 楽天アフィリエイトリンク生成ユーティリティ
// 初期版ではMarkdown内のrakutenUrlをそのまま使用する
// 将来的には楽天商品検索APIと連携してリンクを動的生成する

export interface RakutenProduct {
  itemCode: string;
  itemName: string;
  itemPrice: number;
  itemUrl: string;
  smallImageUrls?: string[];
  mediumImageUrls?: string[];
  reviewAverage?: number;
  reviewCount?: number;
}

/**
 * アフィリエイトIDをURLに付与する(将来用)
 * 現在はURLをそのまま返す
 */
export function buildAffiliateUrl(url: string, affiliateId?: string): string {
  if (!affiliateId) return url;
  // TODO: 楽天アフィリエイトURL変換ロジックをここに実装
  return url;
}

/**
 * 楽天商品検索APIのレスポンスを正規化する(将来用)
 */
export function normalizeRakutenProduct(_raw: unknown): RakutenProduct | null {
  // TODO: 楽天商品検索API連携時に実装
  return null;
}
