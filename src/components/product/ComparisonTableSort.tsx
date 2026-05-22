import { useState, useMemo } from "preact/hooks";
import type { OfferProvider, OfferPriceSummary } from "../../lib/offers";
import {
  getProviderBadgeClass,
  getProviderButtonClass,
  getProviderGaEvent,
  getProviderName,
  getProviderPurchaseLabel,
} from "../../lib/offers";

interface VisibleOfferForTable {
  provider: OfferProvider;
  label?: string;
  url: string;
  asin?: string;
  // Astro 側で .toISOString() して渡す（z.coerce.date() が Date に変換するため）
  updatedAt?: string;
}

interface ProductForComparisonTable {
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
  priceSummary?: OfferPriceSummary;
  visibleOffers?: VisibleOfferForTable[];
}

type SortKey = "rank" | "price" | "pricePerUnit" | "rating";

interface Props {
  products: ProductForComparisonTable[];
  caption: string;
  enabledProviders: OfferProvider[];
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

  function lowestBadgeCls(provider: OfferProvider) {
    return getProviderBadgeClass(provider);
  }

  const sortBtnBase =
    "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors min-h-[36px] border";
  const activeCls =
    "bg-[var(--color-primary)] text-white border-[var(--color-primary)]";
  const inactiveCls =
    "bg-white text-[var(--color-text-sub)] border-[var(--color-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]";
  const desktopPriceRowCls =
    "grid grid-cols-[38px_68px_112px] items-center gap-2";
  const mobilePriceRowCls =
    "grid grid-cols-[36px_minmax(70px,1fr)_132px] items-center gap-2";
  const purchaseButtonCls =
    "whitespace-nowrap inline-flex items-center justify-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all min-h-[32px] w-[112px]";
  const mobilePurchaseButtonCls =
    "whitespace-nowrap inline-flex items-center justify-center gap-1 text-sm px-3 py-2 rounded-lg font-medium transition-all min-h-[40px] w-full";

  return (
    <div>
      {/* ソートボタン群 */}
      <div class="flex flex-wrap gap-2 mb-3" role="group" aria-label="並び替え">
        {(
          [
            { key: "rank" as SortKey, label: "おすすめ順" },
            { key: "price" as SortKey, label: "安い順" },
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
        <table class="w-full min-w-[800px] text-sm">
          <caption class="sr-only">{caption}</caption>
          <thead class="bg-[var(--color-surface)] sticky top-0">
            <tr>
              <th class="px-3 py-3 text-left font-semibold text-[var(--color-text-sub)] whitespace-nowrap w-12">順位</th>
              <th class="px-3 py-3 text-left font-semibold text-[var(--color-text-sub)] min-w-[220px]">商品名</th>
              <th
                class="px-3 py-3 text-left font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-primary)] select-none min-w-[258px] whitespace-nowrap"
                aria-sort={ariaSortAttr("price")}
                onClick={() => handleSort("price")}
              >
                価格・購入{sortKey === "price" && <span class="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
              </th>
              <th class="px-3 py-3 text-left font-semibold text-[var(--color-text-sub)] min-w-[66px] whitespace-nowrap">容量</th>
              <th
                class="px-3 py-3 text-left font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-primary)] select-none min-w-[88px] whitespace-nowrap"
                aria-sort={ariaSortAttr("pricePerUnit")}
                onClick={() => handleSort("pricePerUnit")}
              >
                コスパ{sortKey === "pricePerUnit" && <span class="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
              </th>
              <th
                class="px-3 py-3 text-left font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-primary)] select-none min-w-[82px] whitespace-nowrap"
                aria-sort={ariaSortAttr("rating")}
                onClick={() => handleSort("rating")}
              >
                評価{sortKey === "rating" && <span class="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const offers =
                p.visibleOffers && p.visibleOffers.length > 0
                  ? p.visibleOffers
                  : [{ provider: "rakuten" as const, url: p.rakutenUrl }];
              const multiOffer = offers.length > 1;
              return (
                <tr key={p.name} class={`${i % 2 === 0 ? "bg-white" : "bg-[var(--color-surface)]"} border-t border-[var(--color-border)]/70 hover:bg-[var(--color-primary)]/5 transition-colors`}>
                  <td class="px-3 py-3 text-center">
                    <span class={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${
                      p.rank === 1 ? "bg-amber-400 text-white" :
                      p.rank === 2 ? "bg-slate-400 text-white" :
                      p.rank === 3 ? "bg-amber-600 text-white" :
                      "bg-[var(--color-surface)] text-[var(--color-text-sub)]"
                    }`}>
                      {p.rank}
                    </span>
                  </td>
                  <td class="px-3 py-3">
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
                  <td class="px-3 py-3 align-middle">
                    <div class="space-y-2">
                      {offers.map((offer) => {
                        const priceRow = p.priceSummary?.priceRows.find(
                          (r) => r.provider === offer.provider
                        );
                        const price: number | null =
                          priceRow?.price ??
                          (offer.provider === "rakuten" ? p.price : null);
                        const isLowest =
                          p.priceSummary?.lowestPrice != null &&
                          price != null &&
                          price === p.priceSummary.lowestPrice;
                        return (
                          <div key={offer.provider} class={desktopPriceRowCls}>
                            <span
                              aria-hidden={!multiOffer || !isLowest}
                              class={`text-xs font-bold px-1.5 py-0.5 rounded text-center w-[38px] whitespace-nowrap ${
                                multiOffer && isLowest ? lowestBadgeCls(offer.provider) : "invisible"
                              }`}
                            >
                              最安
                            </span>
                            <span class="font-bold tabular-nums text-right whitespace-nowrap">
                              {price != null ? `¥${price.toLocaleString()}` : "価格確認"}
                            </span>
                            <a
                              href={offer.url}
                              rel="sponsored nofollow noopener"
                              target="_blank"
                              aria-label={`${p.name}を${getProviderName(offer.provider)}で購入（別タブで開く）`}
                              class={`${purchaseButtonCls} ${getProviderButtonClass(offer.provider, "primary")}`}
                              data-ga-event={getProviderGaEvent(offer.provider)}
                              data-ga-provider={offer.provider}
                              data-ga-product={p.name}
                            >
                              {getProviderPurchaseLabel(offer.provider)}
                            </a>
                          </div>
                        );
                      })}
                    </div>
                  </td>
                  <td class="px-3 py-3 text-sm whitespace-nowrap align-middle">{p.capacity}</td>
                  <td class="px-3 py-3 align-middle">
                    {p.pricePerUnit && p.priceSummary?.lowestProvider === "rakuten" && (
                      <span class="inline-flex min-w-[78px] justify-center bg-[var(--color-accent)] text-white text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap">
                        {p.pricePerUnit}
                      </span>
                    )}
                  </td>
                  <td class="px-3 py-3 align-middle">
                    {p.rating !== undefined && (
                      <div class="flex items-center gap-1 whitespace-nowrap">
                        <span class="text-[var(--color-warning)]">★</span>
                        <span class="font-medium">{p.rating.toFixed(1)}</span>
                        {p.reviewCount !== undefined && (
                          <span class="text-xs text-[var(--color-text-sub)]">({p.reviewCount.toLocaleString()})</span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* カード型(モバイル) */}
      <div class="md:hidden space-y-3">
        {sorted.map((p) => {
          const offers =
            p.visibleOffers && p.visibleOffers.length > 0
              ? p.visibleOffers
              : [{ provider: "rakuten" as const, url: p.rakutenUrl }];
          const multiOffer = offers.length > 1;
          return (
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
              {/* 容量・コスパ・評価 */}
              <div class="flex flex-wrap gap-2 mb-3 text-sm">
                <span class="text-[var(--color-text-sub)] whitespace-nowrap">{p.capacity}</span>
                {p.pricePerUnit && p.priceSummary?.lowestProvider === "rakuten" && (
                  <span class="bg-[var(--color-accent)] text-white text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap">
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
              {/* ショップ別価格・購入行 */}
              <div class="space-y-2">
                {offers.map((offer) => {
                  const priceRow = p.priceSummary?.priceRows.find(
                    (r) => r.provider === offer.provider
                  );
                  const price: number | null =
                    priceRow?.price ??
                    (offer.provider === "rakuten" ? p.price : null);
                  const isLowest =
                    p.priceSummary?.lowestPrice != null &&
                    price != null &&
                    price === p.priceSummary.lowestPrice;
                  return (
                    <div key={offer.provider} class={mobilePriceRowCls}>
                      <span
                        aria-hidden={!multiOffer || !isLowest}
                        class={`text-xs font-bold px-1.5 py-0.5 rounded text-center w-9 whitespace-nowrap ${
                          multiOffer && isLowest ? lowestBadgeCls(offer.provider) : "invisible"
                        }`}
                      >
                        最安
                      </span>
                      <span class="font-bold tabular-nums text-sm whitespace-nowrap">
                        {price != null ? `¥${price.toLocaleString()}` : "価格確認"}
                      </span>
                      <a
                        href={offer.url}
                        rel="sponsored nofollow noopener"
                        target="_blank"
                        aria-label={`${p.name}を${getProviderName(offer.provider)}で購入（別タブで開く）`}
                        class={`${mobilePurchaseButtonCls} ${getProviderButtonClass(offer.provider, "primary")}`}
                        data-ga-event={getProviderGaEvent(offer.provider)}
                        data-ga-provider={offer.provider}
                        data-ga-product={p.name}
                      >
                        {getProviderPurchaseLabel(offer.provider)}
                      </a>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
