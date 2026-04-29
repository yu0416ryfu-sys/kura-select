export const SITE = {
  name: "KuraSelect",
  nameJa: "暮らセレクト",
  description: "日用品・消耗品のコスパ比較サイト。トイレットペーパーや洗濯洗剤など毎日使うものをお得に選ぶお手伝いをします。",
  url: "https://yu0416ryfu-sys.github.io/kura-select",
  ogImage: "/og-default.png",
  twitterHandle: "",
  author: "KuraSelect編集部",
} as const;

const _base = import.meta.env.BASE_URL.replace(/\/$/, "");

export function url(path: string = "/"): string {
  if (path === "/") return `${_base}/`;
  if (path.startsWith("/")) return `${_base}${path}`;
  return `${_base}/${path}`;
}
