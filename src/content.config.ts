import { defineCollection, reference } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const offerSchema = z.object({
  provider: z.enum(["rakuten", "yahoo", "amazon"]),
  label: z.string().optional(),
  asin: z.string().optional(),
  price: z.number().int().nonnegative().optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  url: z.string().url(),
  imageUrl: z.string().url().optional(),
  available: z.boolean().optional(),
  updatedAt: z.coerce.date().optional(),
  matchStatus: z.enum(["matched", "pending", "review", "rejected"]).optional(),
  matchConfidence: z.enum(["high", "medium", "low"]).optional(),
  matchedCapacity: z.string().optional(),
  matchNotes: z.string().optional(),
});

const productSchema = z.object({
  rank: z.number().int().positive(),
  name: z.string(),
  brand: z.string(),
  price: z.number().int().nonnegative(),
  capacity: z.string(),
  pricePerUnit: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  features: z.array(z.string()),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  recommendedFor: z.string(),
  rakutenUrl: z.string().url(),
  imageUrl: z.string().optional(),
  offers: z.array(offerSchema).optional(),
});

// サービス記事（ウォーターサーバー等の ASP 案件）用スキーマ。
// 楽天商品ではないため rakutenUrl を持たず、update-products の対象外
// （scripts/lib/frontmatter.ts の isProductManagedArticle で除外）。
const serviceSchema = z.object({
  rank: z.number().int().positive(),
  name: z.string(),
  brand: z.string(),
  /** 月額総額（サーバーレンタル料＋水代＋電気代の目安・円） */
  monthlyCost: z.number().int().nonnegative(),
  /** 円/L。比較の主軸。表示は monthlyCost と併せて比較表で行う */
  pricePerLiter: z.string(),
  /** 給水方式: delivery=宅配水 / purifier=浄水型（水道水） */
  waterType: z.enum(["delivery", "purifier"]),
  /** 契約期間（月）。縛りなしは 0 */
  contractMonths: z.number().int().nonnegative(),
  /** 解約金（円）。不利益条件のため必須。なしは 0 */
  cancellationFee: z.number().int().nonnegative(),
  features: z.array(z.string()),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  recommendedFor: z.string(),
  /** ASP のアフィリエイトリンク */
  affiliateUrl: z.string().url(),
  asp: z.enum(["a8", "valuecommerce", "afb"]),
  imageUrl: z.string().optional(),
});

const faqSchema = z.object({
  question: z.string(),
  answer: z.string(),
});

const commonFields = ({ image }: { image: () => z.ZodType }) =>
  ({
    title: z.string().max(60),
    description: z.string().max(160),
    category: reference("categories"),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    heroImage: image().optional(),
    tags: z.array(z.string()).optional(),
    draft: z.boolean().default(false),
    // 本文の FAQ から inject-faq-frontmatter.mjs が生成（FAQPage JSON-LD 用）
    faqs: z.array(faqSchema).optional(),
  }) as const;

const articles = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/articles" }),
  schema: ({ image }) =>
    z.discriminatedUnion("articleType", [
      // 比較記事: products は 1 件以上必須
      z.object({
        articleType: z.literal("comparison"),
        ...commonFields({ image }),
        products: z.array(productSchema).min(1),
      }),
      // レビュー記事: products は任意（単品レビューでも商品情報あり）
      z.object({
        articleType: z.literal("review"),
        ...commonFields({ image }),
        products: z.array(productSchema).optional(),
      }),
      // サービス記事: ASP 案件（ウォーターサーバー等）。services は 1 件以上必須
      z.object({
        articleType: z.literal("service"),
        ...commonFields({ image }),
        services: z.array(serviceSchema).min(1),
      }),
    ]),
});

const categories = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/categories" }),
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string(),
    icon: z.string().optional(),
    order: z.number().int(),
  }),
});

export const collections = { articles, categories };
