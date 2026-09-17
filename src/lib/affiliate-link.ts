import type { OfferProvider } from "./offers";
import {
  getProviderButtonClass,
  getProviderGaEvent,
  getProviderLabel,
  getProviderName,
} from "./offers";

// AffiliateLink.astro と rehype-pick-buttons（本文マーカー）で共有する、
// アフィリエイトボタンの属性組み立て。rel・class・aria-label・data-* のずれを防ぐ。

export const AFFILIATE_REL = "sponsored nofollow noopener" as const;

/** 左側のアイコン（リスト風） */
export const AFFILIATE_ICON_PATH =
  "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z";
export const AFFILIATE_ICON_CLASS = "w-4 h-4 shrink-0";

/** 右側のアイコン（外部リンク） */
export const EXTERNAL_ICON_PATH = "M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14";
export const EXTERNAL_ICON_CLASS = "w-3.5 h-3.5 shrink-0";

const SIZE_CLASSES = {
  sm: "px-4 py-2 text-sm min-h-[36px]",
  md: "px-6 py-2.5 text-sm min-h-[44px]",
  lg: "px-8 py-3 text-base min-h-[52px]",
} as const;

export interface AffiliateLinkAttrs {
  href: string;
  rel: typeof AFFILIATE_REL;
  target: "_blank";
  ariaLabel: string;
  className: string;
  dataset: {
    gaEvent: string;
    gaProvider: OfferProvider;
    gaProduct?: string;
    gaPlacement?: string;
  };
  label: string;
}

export interface AffiliateLinkInput {
  href: string;
  provider: OfferProvider;
  label?: string;
  variant?: "primary" | "outline";
  size?: "sm" | "md" | "lg";
  productName?: string;
  /** GA4 計測用の設置場所ラベル（例: "sticky_cta"）。未指定は inline 扱い */
  gaPlacement?: string;
}

export function buildAffiliateLinkAttrs(input: AffiliateLinkInput): AffiliateLinkAttrs {
  const { href, provider, label, variant = "primary", size = "md", productName, gaPlacement } = input;

  const displayLabel = label ?? `${getProviderLabel(provider)}で見る`;
  const providerName = getProviderName(provider);
  const ariaLabel = productName
    ? `${productName}を${providerName}で見る（別タブで開く）`
    : `${displayLabel}（別タブで開く）`;

  const className = `inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 w-full whitespace-nowrap ${SIZE_CLASSES[size]} ${getProviderButtonClass(provider, variant)}`;

  return {
    href,
    rel: AFFILIATE_REL,
    target: "_blank",
    ariaLabel,
    className,
    dataset: {
      gaEvent: getProviderGaEvent(provider),
      gaProvider: provider,
      gaProduct: productName,
      gaPlacement,
    },
    label: displayLabel,
  };
}
