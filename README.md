# 比較.com

日用品・消耗品に特化した日本語の楽天アフィリエイト比較サイト。

Astro 6 + Preact 10（compat）+ Tailwind CSS v4 + TypeScript（strict）で構築した静的サイト（SSG）。GitHub Pages にデプロイされ、楽天 Web Service API から商品データを定期更新する仕組みを GitHub Actions で組んでいます。

> Claude（Claude Code / Cowork など）でこのリポジトリを触るときは、最初に [`CLAUDE.md`](./CLAUDE.md) を読んでください。コーディング規約・スキーマ規約・既知の負債が集約されています。

---

## セットアップ

### 必要環境

- Node.js 22.x 以上
- pnpm（**`npm` / `yarn` 不可**。`pnpm-lock.yaml` を信頼の置けるロックファイルとして扱う）

### インストール

```bash
pnpm install
```

### 開発サーバー起動

```bash
pnpm dev
# http://localhost:4321/kura-select で起動（base path /kura-select に注意）
```

### ビルド

```bash
pnpm build
# scripts/generate-ogp.mjs で OGP 画像を 1200×630px で生成 → astro build
```

### プレビュー（ビルド成果物の確認）

```bash
pnpm preview
```

### テスト

```bash
pnpm test          # vitest run（現状 tests/frontmatter.test.ts の 17 件）
pnpm test:watch    # watch モード
```

### 楽天 API から商品データを更新

```bash
pnpm update-products       # 楽天 API 呼び出し → 記事 frontmatter 更新
pnpm update-products:dry   # 同上の dry-run（ファイルは書かない）
```

---

## 環境変数

`.env.example` をコピーして `.env` を作成し、各値を設定してください。`.env` は **コミット禁止**。

```bash
cp .env.example .env
```

| 変数名 | 用途 | スコープ |
|--------|------|----------|
| `PUBLIC_RAKUTEN_AFFILIATE_ID` | 楽天アフィリエイト ID | クライアント公開 |
| `PUBLIC_SITE_URL` | サイト canonical URL | クライアント公開 |
| `RAKUTEN_APPLICATION_ID` | 楽天 Web Service API ID | サーバ（`update-products.mjs`） |
| `RAKUTEN_ACCESS_KEY` | 楽天 Web Service API キー | サーバ（同上） |

### 楽天 ID の取得先

- アフィリエイト ID: [楽天アフィリエイト](https://affiliate.rakuten.co.jp/) のマイページ
- API キー: [楽天 Web Service](https://webservice.rakuten.co.jp/) でアプリ登録

---

## 記事の追加方法

詳細は [`CLAUDE.md` §5](./CLAUDE.md) も参照。

### 1. カテゴリの追加（既存にない場合のみ）

`src/content/categories/<slug>.md`：

```md
---
name: カテゴリ名
slug: category-slug
description: カテゴリの説明文（一覧ページ用）
icon: 🏷️
order: 9         # 既存と重複しない数値
---
```

### 2. 記事の追加

`src/content/articles/<slug>-comparison.md`：

```md
---
title: "商品比較タイトル（60文字以内）"
description: "記事ディスクリプション（160文字以内）"
category: <カテゴリのファイル名（拡張子なし）>
publishedAt: 2026-05-01
updatedAt: 2026-05-03   # 任意
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
    rakutenUrl: "https://hb.afl.rakuten.co.jp/..."   # 本物のアフィリエイトリンク
    imageUrl: "https://thumbnail.image.rakuten.co.jp/..."
draft: false
---

## 記事本文をここに書く
```

スキーマは `src/content.config.ts` の Zod 定義が**唯一の正**。`title` 60 文字 / `description` 160 文字超過、`rakutenUrl` が URL 形式でない、などはビルドで Zod が落とします。

### 3. 必ずビルドで検証

```bash
pnpm build
```

OGP 画像（`public/og/articles/<slug>.png`）が新規生成されることもこのコマンドで確認できます。

---

## デプロイ環境（GitHub Pages）

### 自動デプロイ

`main` ブランチに push すると `.github/workflows/deploy.yml` が起動：

1. `pnpm install`
2. `pnpm build`（`PUBLIC_RAKUTEN_AFFILIATE_ID` を secret から注入）
3. `actions/upload-pages-artifact@v3` で `dist/` をアップロード
4. `actions/deploy-pages@v4` で公開

### ドメイン

- リポジトリ: `yu0416ryfu-sys/kura-select`
- 公開 URL（github.io 既定）: `https://yu0416ryfu-sys.github.io/kura-select`
- カスタムドメイン: `CNAME` に `www.kura-select.com` を設定済み

> **注意**: `astro.config.mjs` は現状 `site: https://yu0416ryfu-sys.github.io` / `base: /kura-select` のままです。カスタムドメインに切替時は `base` を削除し `site` を `https://www.kura-select.com` に変更してください（[`CLAUDE.md` §6 / §14](./CLAUDE.md) 参照）。

### 商品データ自動更新（cron）

`.github/workflows/update-products.yml` が **毎週月曜 03:00 UTC（日本時間 12:00）** に走り、楽天 API から最新の価格・レビューを取得 → `src/content/articles/` を bot コミット → デプロイをトリガーします。

必要な GitHub Secrets:

- `PUBLIC_RAKUTEN_AFFILIATE_ID`
- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`

---

## 技術スタック

| 項目 | 採用 |
|------|----------|
| フレームワーク | Astro 6.1（SSG） |
| Islands | Preact 10（`compat: true`） |
| スタイル | Tailwind CSS v4（`@tailwindcss/vite` + `@theme`） |
| コンテンツ | Content Collections（Zod スキーマ + glob loader） |
| Markdown 拡張 | MDX |
| OGP 生成 | Sharp |
| テスト | Vitest |
| 言語 | TypeScript（strict） |
| デプロイ | GitHub Pages（GitHub Actions） |

---

## 設計ノート

### Tailwind CSS v4

`@tailwindcss/vite` + `@import "tailwindcss"` 方式。`tailwind.config.js` は使わず、カスタムカラー / フォント / 行間は `src/styles/global.css` の `@theme` ブロックに集約しています（`--color-bg`, `--color-primary`, `--color-accent`, `--color-warning` …）。

### Preact + 最小 Islands

比較表のソート機能 `src/components/product/ComparisonTableSort.tsx` のみを `client:visible` でハイドレーション。React ではなく Preact を採用してバンドルサイズを抑え、`client:load` は使いません。Lighthouse Performance / SEO / Accessibility / Best Practices 95+ を設計目標としています。

### Content Collections

`src/content.config.ts` で `articles` と `categories` を Zod スキーマ付きで定義。記事 ID はファイル名から自動生成、カテゴリ参照は `reference("categories")` 経由で解決。`draft: true` の記事はビルド対象から除外されます。

### OGP 画像

`scripts/generate-ogp.mjs` が `pnpm build` の前段で 1200×630px の OGP 画像を Sharp + SVG テンプレで生成し、`public/og/articles/<slug>.png` に出力します。記事を追加・タイトル変更したら必ず再ビルドしてください。

### CSP

`astro.config.mjs` は `security.checkOrigin: true` のみ設定。`experimental.csp` は Astro 6.1 では未サポートなので、本格的な CSP 設定（楽天画像ドメイン許可など）は将来のバージョンアップ時に対応予定です。

### アフィリエイト方針

- 楽天リンクはすべて `RakutenLink.astro` 経由（`rel="sponsored nofollow noopener"` を中央管理）
- ステマ規制対応として `disclaimer.astro` と各記事レイアウトのフッタにアフィリエイト表記を表示中（外さない）
- 「最安」「No.1」など断定表現は、比較日・対象範囲・出典の根拠を記事内に必ず置く

---

## ディレクトリ構成（抜粋）

```
KuraSelect/
├ astro.config.mjs
├ CNAME                       # GitHub Pages カスタムドメイン
├ .github/workflows/          # deploy.yml / update-products.yml
├ public/                     # 静的アセット（OGP 画像出力先）
├ scripts/                    # generate-ogp.mjs / update-products.mjs
├ src/
│  ├ content.config.ts        # Zod スキーマ
│  ├ content/articles/        # 記事 .md / .mdx（34 本）
│  ├ content/categories/      # カテゴリ .md（26 件）
│  ├ layouts/                 # BaseLayout / ArticleLayout
│  ├ components/{layout,product,seo}/
│  ├ pages/                   # ルーティング
│  ├ lib/                     # rakuten.ts / site.ts
│  └ styles/global.css        # Tailwind v4 + @theme
└ tests/frontmatter.test.ts
```

詳細マップは [`CLAUDE.md` §4](./CLAUDE.md)。

---

## ライセンス / 個人プロジェクト

このリポジトリは個人運営のアフィリエイトサイト用ソースコードです。記事本文・画像・楽天アフィリエイトリンクは運営者の権利物。技術スタック実装の参考は自由ですが、コンテンツの転載は不可。
