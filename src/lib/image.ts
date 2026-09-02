// 商品サムネイル URL のサイズ調整。
// 記事 frontmatter の imageUrl は update-products が書き込む値（楽天は ?_ex=128x128 固定）で、
// 手で書き換えると次回の自動更新で戻るため、表示時にだけサイズを差し替える。

const RAKUTEN_THUMBNAIL_HOST = "thumbnail.image.rakuten.co.jp";
const EX_PARAM_RE = /([?&]_ex=)\d+x\d+/;

/**
 * 楽天サムネイルの `_ex` を指定ピクセルに差し替える。
 * 楽天以外（Yahoo の item-shopping.c.yimg.jp など）はサイズ指定の口がないのでそのまま返す。
 *
 * @param url    元の画像 URL
 * @param px     要求する一辺のピクセル数（CSS 表示サイズの 2 倍＝Retina 相当を目安にする）
 */
export function upscaleThumbnail(
  url: string | null | undefined,
  px: number
): string | undefined {
  if (!url) return undefined;
  if (!url.includes(RAKUTEN_THUMBNAIL_HOST)) return url;
  if (!Number.isFinite(px) || px <= 0) return url;
  const size = Math.round(px);
  if (EX_PARAM_RE.test(url)) {
    return url.replace(EX_PARAM_RE, `$1${size}x${size}`);
  }
  // `_ex` を持たない楽天 URL には付与する
  return `${url}${url.includes("?") ? "&" : "?"}_ex=${size}x${size}`;
}

/**
 * `<img src>` にそのまま渡せる形。URL が無ければプレースホルダーを返す。
 */
export function productImageSrc(
  url: string | null | undefined,
  px: number,
  placeholder = "/placeholder/product-default.svg"
): string {
  return upscaleThumbnail(url, px) ?? placeholder;
}
