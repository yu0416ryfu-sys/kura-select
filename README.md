# KuraSelect（暮らセレクト）

日用品・消耗品に特化した楽天アフィリエイト比較サイト。

Astro 6.x + Tailwind CSS v4 + TypeScript で構築し、Vercel に静的サイトとしてデプロイします。

---

## セットアップ

### 必要環境

- Node.js 22.x 以上
- pnpm

### インストール

```bash
pnpm install
```

### 開発サーバー起動

```bash
pnpm dev
# http://localhost:4321 で起動
```

### ビルド

```bash
pnpm build
```

### プレビュー(ビルド後の確認)

```bash
pnpm preview
```

---

## 環境変数

`.env.example` をコピーして `.env` を作成し、各値を設定してください。

```bash
cp .env.example .env
```

| 変数名 | 説明 | 必須 |
|--------|------|------|
| `PUBLIC_RAKUTEN_AFFILIATE_ID` | 楽天アフィリエイトのアフィリエイトID | 本番環境で必須 |
| `PUBLIC_SITE_URL` | 本番サイトのURL | 任意（デフォルト: https://kura-select.vercel.app） |

### 楽天アフィリエイトIDの取得

1. [楽天アフィリエイト](https://affiliate.rakuten.co.jp/) にログイン
2. マイページからアフィリエイトIDを確認
3. `.env` の `PUBLIC_RAKUTEN_AFFILIATE_ID` に設定

---

## 記事の追加方法

### 1. カテゴリファイルの作成(新カテゴリのみ)

`src/content/categories/` に `.md` ファイルを追加します：

```md
---
name: カテゴリ名
slug: category-slug
description: カテゴリの説明文
icon: 🏷️
order: 9
---
```

### 2. 記事ファイルの作成

`src/content/articles/` に `.md` または `.mdx` ファイルを追加します：

```md
---
title: "商品比較タイトル（60文字以内）"
description: "記事の説明（160文字以内）"
category: カテゴリファイル名（拡張子なし）
publishedAt: 2024-11-01
products:
  - rank: 1
    name: "商品名"
    brand: "ブランド名"
    price: 980
    capacity: "1kg×3個"
    pricePerUnit: "約10円/回"
    rating: 4.2
    reviewCount: 500
    features:
      - "特徴1"
    pros:
      - "メリット"
    cons:
      - "デメリット"
    recommendedFor: "こんな方向け"
    rakutenUrl: "https://example.com/product"  # 本物の楽天アフィリエイトURLを設定
    imageUrl: "/placeholder/product-1.svg"  # 商品画像パス
draft: false
---

## 記事本文をここに書く
```

### 重要: 楽天URLの設定

本番運用時は `rakutenUrl` に実際の楽天アフィリエイトURLを設定してください。
サンプルデータには `https://example.com/placeholder/` 形式のダミーURLが使用されています。

---

## Vercelデプロイ手順

### 初回デプロイ

1. [Vercel](https://vercel.com) にGitHubアカウントでログイン
2. 「New Project」→ リポジトリを選択
3. Framework Preset: **Astro** を選択（自動検出される場合が多い）
4. 環境変数を設定：
   - `PUBLIC_RAKUTEN_AFFILIATE_ID`: 楽天アフィリエイトID
   - `PUBLIC_SITE_URL`: デプロイ後のURL（例: `https://your-site.vercel.app`）
5. 「Deploy」をクリック

### 設定のポイント

- `vercel.json` は初期版では不要（Astroを静的サイトとして自動検出）
- `astro.config.mjs` の `site` プロパティを本番URLに合わせて変更してください

### カスタムドメインの設定

Vercelダッシュボードの「Settings」→「Domains」からカスタムドメインを追加できます。

---

## 技術スタック

| 項目 | 使用技術 |
|------|----------|
| フレームワーク | Astro 6.x |
| 言語 | TypeScript (strict) |
| スタイル | Tailwind CSS v4 |
| Islands | Preact |
| コンテンツ | Content Collections (Content Layer API) |
| デプロイ | Vercel (静的サイト) |

---

## 実装上の判断

### Tailwind CSS v4

`@tailwindcss/vite` + `@import "tailwindcss"` 方式を採用。
`tailwind.config.js` は使用せず、カスタムカラー等は `src/styles/global.css` の `@theme` ブロックに定義。

### CSP設定

Astro 6 の `experimental.csp: true` で基本的なCSPを有効化。
初期版ではサンプル画像のみ使用するため、楽天の画像ドメイン (`image.rakuten.co.jp`) への `img-src` 追加は本番利用時に行う。

### Preact採用(React不使用)

比較表ソート機能のみislandとして実装（`client:visible`）。
軽量化のためReactではなくPreactを使用。

### コンテンツURL設計

記事IDはファイル名ベースで自動生成（例: `toilet-paper-comparison`）。
カテゴリは `slug` フィールドでURLを制御し、ファイル名と分離。

### サンプルデータ

`rakutenUrl` には `https://example.com/placeholder/{slug}` 形式のダミーURLを使用。
本番運用時は実際の楽天アフィリエイトURLに差し替えること。

### OGP画像

`public/og-default.png` は現在プレースホルダー。
本番前に1200×630pxの実際のOGP画像に差し替えること。

### Lighthouse目標

Performance/SEO/Accessibility/Best Practices すべて95以上を目標として設計：
- Islands最小化（比較表ソートのみ）
- `client:visible` 優先（`client:load` 不使用）
- 全画像に `alt` 属性、CLS対策の width/height 指定
- スキップリンク、ARIAラベル等のアクセシビリティ対応
