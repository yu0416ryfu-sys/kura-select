import { defineCollection, reference } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const offerSchema = z.object({
  provider: z.enum(["rakuten", "yahoo"]),
  label: z.string().optional(),
  price: z.number().int().nonnegative().optional(),
  url: z.string().url(),
  imageUrl: z.string().url().optional(),
  available: z.boolean().optional(),
  updatedAt: z.coerce.date().optional(),
  matchStatus: z.enum(["matched", "pending", "review", "rejected"]).optional(),
  matchConfidence: z.enum(["high", "medium", "low"]).optional(),
  matchedCapacity: z.string().optional(),
  matchNotes: z.string().optional(),
});

const articles = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/articles" }),
  schema: ({ image }) =>
    z.object({
      title: z.string().max(60),
      description: z.string().max(160),
      category: reference("categories"),
      publishedAt: z.coerce.date(),
      updatedAt: z.coerce.date().optional(),
      heroImage: image().optional(),
      products: z.array(
        z.object({
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
        })
      ),
      tags: z.array(z.string()).optional(),
      draft: z.boolean().default(false),
    }),
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
