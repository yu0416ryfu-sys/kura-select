import { useState, useMemo } from "preact/hooks";

interface OfferPriceSummary {
  lowestPrice: number | null;
  lowestProvider: "rakuten" | "yahoo" | null;
  priceRows: { provider: "rakuten" | "yahoo"; label: string; price: number }[];
  priceDifferenceLabel: string | null;
}

interface Product {
  rank: number;
  name: string;
  brand: string;
  price: number;
  capacity: string;
  pricePerUnit?: string;
  rating?: number;
  reviewCount?: number;
  rakutenUrl: string;
  imageUrl?: string;
  visibleOffers?: {
    provider: "rakuten" | "yahoo";
    label?: string;
    url: string;
  }[];
  priceSummary?: OfferPriceSummary;
}

type SortKey = "rank" | "price" | "pricePerUnit" | "rating";

interface Props {
  products: Product[];
  caption: string;
}

export default function ComparisonTableSort({ products, caption }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    return [...products].sort((a, b) => {
      let av: number;
      let bv: number;

      if (sortKey === "rank") {
        av = a.rank;
        bv = b.rank;
      } else if (sortKey === "price") {
        av = a.priceSummary?.lowestPrice ?? a.price;
        bv = b.priceSummary?.lowestPrice ?? b.price;
      } else if (sortKey === "pricePerUnit") {
        const extract = (s?: string) =>
          s ? parseFloat(s.replace(/[^0-9.]/g, "")) : Infinity;
        av = extract(a.pricePerUnit);
        bv = extract(b.pricePerUnit);
      } else {
        av = a.rating ?? 0;
        bv = b.rating ?? 0;
      }

      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [products, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function ariaSortAttr(key: SortKey): "ascending" | "descending" | "none" {
    if (sortKey !== key) return "none";
    return sortDir === "asc" ? "ascending" : "descending";
  }

  const sortBtnBase =
    "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors min-h-[36px] border";
  const activeCls =
    "bg-[var(--color-primary)] text-white border-[var(--color-primary)]";
  const inactiveCls =
    "bg-white text-[var(--color-text-sub)] border-[var(--color-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]";

  function lowestBadgeCls(provider: "rakuten" | "yahoo" | null | undefined) {
    if (!provider) return "";
    return provider === "rakuten"
      ? "bg-amber-100 text-amber-700"
      : "bg-sky-100 text-sky-700";
  }

  return (
    <div>
      {/* ソートボタン群 */}
      <div class="flex flex-wrap gap-2 mb-3" role="group" aria-label="並び替え">
        {(
          [
            { key: "rank" as SortKey, label: "おすすめ順" },
            { key: "price" as SortKey, label: "最安価格順" },
            { key: "pricePerUnit" as SortKey, label: "コスパ順" },
            { key: "rating" as SortKey, label: "評価順" },
          ] as { key: SortKey; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            class={`${sortBtnBase} ${sortKey === key ? activeCls : inactiveCls}`}
            onClick={() => handleSort(key)}
            aria-pressed={sortKey === key}
          >
            {label}
            {sortKey === key && (
              <span class="ml-1 text-xs">{sortDir === "asc" ? "↑" : "↓"}</span>
            )}
          </button>
        ))}
      </div>

      {/* テーブル(PC) */}
      <div class="hidden md:block overflow-x-auto rounded-xl border border-[var(--color-border)]">
        <table class="w-full text-sm">
          <caption class="sr-only">{caption}</caption>
          <thead class="bg-[var(--color-surface)] sticky top-0">
            <tr>
              <th class="px-4 py-3 text-left font-semibold text-[var(--color-text-sub)] w-12">順位</th>
              <th class="px-4 py-3 text-left font-semibold text-[var(--color-text-sub)]">商品名</th>
              <th
                class="px-4 py-3 text-right font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-primary)] select-none"
                aria-sort={ariaSortAttr("price")}
                onClick={() => handleSort("price")}
              >
                最安価格{sortKey === "price" && <span class="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
              </th>
              <th class="px-4 py-3 text-left font-semibold text-[var(--color-text-sub)]">容量</th>
              <th
                class="px-4 py-3 text-left font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-primary)] select-none"
                aria-sort={ariaSortAttr("pricePerUnit")}
                onClick={() => handleSort("pricePerUnit")}
              >
                コスパ{sortKey === "pricePerUnit" && <span class="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
              </th>
              <th
                class="px-4 py-3 text-left font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-primary)] select-none"
                aria-sort={ariaSortAttr("rating")}
                onClick={() => handleSort("rating")}
              >
                評価{sortKey === "rating" && <span class="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
              </th>
              <th class="px-4 py-3 text-center font-semibold text-[var(--color-text-sub)]">購入</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => (
              <tr key={p.name} class={i % 2 === 0 ? "bg-white" : "bg-[var(--color-surface)]"}>
                <td class="px-4 py-3 text-center">
                  <span class={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${
                    p.rank === 1 ? "bg-amber-400 text-white" :
                    p.rank === 2 ? "bg-slate-400 text-white" :
                    p.rank === 3 ? "bg-amber-600 text-white" :
                    "bg-[var(--color-surface)] text-[var(--color-text-sub)]"
                  }`}>
                    {p.rank}
                  </span>
                </td>
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2">
                    <img
                      src={p.imageUrl || "/placeholder/product-default.svg"}
                      alt=""
                      width="40"
                      height="40"
                      class="w-10 h-10 object-contain rounded border border-[var(--color-border)] bg-white shrink-0"
                      loading="lazy"
                    />
                    <div>
                      <p class="text-xs text-[var(--color-text-sub)]">{p.brand}</p>
                      <p class="font-medium text-[var(--color-text)] line-clamp-2">{p.name}</p>
                    </div>
                  </div>
                </td>
                <td class="px-4 py-3 text-right">
                  {p.priceSummary && p.priceSummary.priceRows.length > 0 ? (
                    <div>
                      <div class="flex items-center justify-end gap-1.5 mb-0.5">
                        {p.priceSummary.lowestProvider && p.priceSummary.priceRows.length >= 2 && (
                          <span class={`text-xs font-bold px-1.5 py-0.5 rounded ${lowestBadgeCls(p.priceSummary.lowestProvider)}`}>
                            最安
                          </span>
                        )}
                        <span class="font-bold">
                          ¥{(p.priceSummary.lowestPrice ?? p.price).toLocaleString()}
                        </span>
                      </div>
                      {p.priceSummary.priceRows.length >= 2 && (
                        <div class="text-xs text-[var(--color-text-sub)] space-y-0.5 text-right">
                          {p.priceSummary.priceRows.map((row) => (
                            <div key={row.provider}>
                              {row.provider === "rakuten" ? "楽天" : "Yahoo"} ¥{row.price.toLocaleString()}
                            </div>
                          ))}
                          {p.priceSummary.priceDifferenceLabel && (
                            <div class="text-sky-600">{p.priceSummary.priceDifferenceLabel}</div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span class="font-bold">¥{p.price.toLocaleString()}</span>
                  )}
                </td>
                <td class="px-4 py-3 text-sm">{p.capacity}</td>
                <td class="px-4 py-3">
                  {p.pricePerUnit && p.priceSummary?.lowestProvider !== "yahoo" && (
                    <span class="bg-[var(--color-accent)] text-white text-xs px-2 py-0.5 rounded-full font-medium">
                      {p.pricePerUnit}
                    </span>
                  )}
                </td>
                <td class="px-4 py-3">
                  {p.rating !== undefined && (
                    <div class="flex items-center gap-1">
                      <span class="text-[var(--color-warning)]">★</span>
                      <span class="font-medium">{p.rating.toFixed(1)}</span>
                      {p.reviewCount !== undefined && (
                        <span class="text-xs text-[var(--color-text-sub)]">({p.reviewCount.toLocaleString()})</span>
                      )}
                    </div>
                  )}
                </td>
                <td class="px-4 py-3 text-center">
                  <div class="flex flex-col items-stretch gap-1.5">
                    {(p.visibleOffers ?? []).map((offer) => (
                      <a
                        key={`${p.name}-${offer.provider}`}
                        href={offer.url}
                        rel="sponsored nofollow noopener"
                        target="_blank"
                        aria-label={`${p.name}を${offer.provider === "rakuten" ? "楽天市場" : "Yahoo!ショッピング"}で見る（別タブで開く）`}
                        class={`w-full whitespace-nowrap inline-flex items-center justify-center gap-1 text-white text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-90 transition-opacity min-h-[36px] ${
                          offer.provider === "rakuten" ? "bg-[var(--color-warning)]" : "bg-[var(--color-primary)]"
                        }`}
                        data-ga-event={offer.provider === "rakuten" ? "click_rakuten_link" : "click_yahoo_link"}
                        data-ga-provider={offer.provider}
                        data-ga-product={p.name}
                      >
                        {offer.label ?? (offer.provider === "rakuten" ? "楽天" : "Yahoo!")}
                      </a>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* カード型(モバイル) */}
      <div class="md:hidden space-y-3">
        {sorted.map((p) => (
          <div key={p.name} class="bg-white rounded-xl border border-[var(--color-border)] p-4 shadow-sm">
            <div class="flex items-start gap-3 mb-3">
              <span class={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                p.rank === 1 ? "bg-amber-400 text-white" :
                p.rank === 2 ? "bg-slate-400 text-white" :
                p.rank === 3 ? "bg-amber-600 text-white" :
                "bg-[var(--color-surface)] text-[var(--color-text-sub)]"
              }`}>
                {p.rank}
              </span>
              <img
                src={p.imageUrl || "/placeholder/product-default.svg"}
                alt=""
                width="56"
                height="56"
                class="w-14 h-14 object-contain rounded border border-[var(--color-border)] bg-white shrink-0"
                loading="lazy"
              />
              <div class="flex-1 min-w-0">
                <p class="text-xs text-[var(--color-text-sub)]">{p.brand}</p>
                <p class="font-bold text-sm text-[var(--color-text)] leading-tight">{p.name}</p>
              </div>
            </div>
            <div class="flex flex-wrap gap-2 mb-3 text-sm">
              {p.priceSummary && p.priceSummary.priceRows.length > 0 ? (
                <>
                  <span class="font-bold">
                    ¥{(p.priceSummary.lowestPrice ?? p.price).toLocaleString()}
                  </span>
                  {p.priceSummary.lowestProvider && p.priceSummary.priceRows.length >= 2 && (
                    <span class={`text-xs font-bold px-1.5 py-0.5 rounded self-center ${lowestBadgeCls(p.priceSummary.lowestProvider)}`}>
                      最安
                    </span>
                  )}
                  {p.priceSummary.priceRows.length >= 2 && p.priceSummary.priceDifferenceLabel && (
                    <span class="text-xs text-sky-600 self-center">
                      {p.priceSummary.priceDifferenceLabel}
                    </span>
                  )}
                </>
              ) : (
                <span class="font-bold">¥{p.price.toLocaleString()}</span>
              )}
              <span class="text-[var(--color-text-sub)]">{p.capacity}</span>
              {p.pricePerUnit && p.priceSummary?.lowestProvider !== "yahoo" && (
                <span class="bg-[var(--color-accent)] text-white text-xs px-2 py-0.5 rounded-full font-medium">
                  {p.pricePerUnit}
                </span>
              )}
              {p.rating !== undefined && (
                <span class="flex items-center gap-0.5 text-xs">
                  <span class="text-[var(--color-warning)]">★</span>
                  {p.rating.toFixed(1)}
                </span>
              )}
            </div>
            <div class="flex flex-col gap-2">
              {(p.visibleOffers ?? []).map((offer) => (
                <a
                  key={`${p.name}-${offer.provider}`}
                  href={offer.url}
                  rel="sponsored nofollow noopener"
                  target="_blank"
                  aria-label={`${p.name}を${offer.provider === "rakuten" ? "楽天市場" : "Yahoo!ショッピング"}で見る（別タブで開く）`}
                  class={`w-full inline-flex items-center justify-center gap-2 text-white text-sm px-4 py-2 rounded-lg font-medium hover:opacity-90 transition-opacity min-h-[44px] ${
                    offer.provider === "rakuten" ? "bg-[var(--color-warning)]" : "bg-[var(--color-primary)]"
                  }`}
                  data-ga-event={offer.provider === "rakuten" ? "click_rakuten_link" : "click_yahoo_link"}
                  data-ga-provider={offer.provider}
                  data-ga-product={p.name}
                >
                  {offer.label ?? (offer.provider === "rakuten" ? "楽天市場で見る" : "Yahoo!ショッピングで見る")}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
