export const SITE = {
  name: "KuraSelect",
  nameJa: "暮らセレクト",
  description: "日用品・消耗品のコスパ比較サイト。トイレットペーパーや洗濯洗剤など毎日使うものをお得に選ぶお手伝いをします。",
  url: "https://www.kura-select.com",
  ogImage: "/og-default.png",
  twitterHandle: "",
  author: "KuraSelect編集部",
} as const;

const _base = import.meta.env.BASE_URL.replace(/\/$/, "");

export function url(path: string = "/"): string {
  if (path === "/") return `${_base}/`;
  const base = path.startsWith("/") ? `${_base}${path}` : `${_base}/${path}`;
  // ハッシュ・クエリを分離（末尾スラッシュはパス部分にのみ付与する）
  const match = base.match(/^([^#?]*)([#?].*)?$/);
  let pathPart = match ? match[1] : base;
  const suffix = match && match[2] ? match[2] : "";
  // 末尾セグメントに「.」を含む場合はアセット（rss.xml / favicon.svg 等）とみなし付与しない
  const lastSegment = pathPart.split("/").pop() ?? "";
  const isFile = lastSegment.includes(".");
  if (!isFile && pathPart !== "" && !pathPart.endsWith("/")) {
    pathPart += "/";
  }
  return `${pathPart}${suffix}`;
}
