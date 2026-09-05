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
  /**
   * 選択式（項目選択肢で価格が変わる）出品の上限価格。
   * これがあるとき price は最安構成の価格を指し、比較表は帯で表示して単価を出さない。
   */
  priceMax: z.number().int().nonnegative().optional(),
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
  /**
   * 楽天が商品に付けたジャンルID。カテゴリ混入検出の第2証拠に使う運用メタデータで、
   * 表示・JSON-LD には出さない。update-products が API レスポンスから書き込む。
   */
  genreId: z.string().optional(),
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
        // pricePerLiter を算出した前提（例: 月100L使った場合）。比較表・カードに併記する
        pricingBasis: z.string().optional(),
        // 以下 3 つは景表法対応（CLAUDE.md §11）。「コスパ最強」等の断定を掲げる
        // サービス記事では、比較日・対象範囲・出典を記事内に明示する必要がある
        /** 比較の対象範囲（例: 工事不要の浄水型4機種。水道直結型・宅配水型は対象外） */
        pricingScope: z.string().optional(),
        /** 月額に含まない費用（水道代・初期費用など）。読者の誤認防止のため列挙する */
        pricingExcludes: z.array(z.string()).optional(),
        /** 料金の出典（例: 各社公式サイトの公表値） */
        pricingSource: z.string().optional(),
        /** 掲載金額の税区分。総額表示義務の対象なので、分かる場合は必ず指定する */
        pricingTaxIncluded: z.boolean().optional(),
        /** 料金を確認した日。景表法でいう「比較日」 */
        pricingCheckedAt: z.coerce.date().optional(),
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
    // カテゴリページ最上部に置く導線記事（最大2件）。カテゴリページと記事が
    // 同一クエリで競合しているカテゴリだけに設定し、検索評価を記事へ寄せる。
    // 指定した記事は下部の一覧からは除外される（重複表示の回避）。
    featuredArticles: z.array(reference("articles")).max(2).optional(),
  }),
});

export const collections = { articles, categories };
