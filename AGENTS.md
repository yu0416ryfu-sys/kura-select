# AGENTS.md

このファイルは Codex（Codex / Cowork など）がこのリポジトリで作業する際の前提知識・規約をまとめたものです。**新しい作業を始める前に必ず読むこと。**

## トークン使用量の節約

- 回答は常に簡潔に。余分な説明・要約・確認文は省く
- 長いセッションでコンテキストが膨らんできたら「新しいチャットを始めると節約できます」と提案する
- 大きな作業は `/clear` や新チャットで分割することを推奨
- ファイルは必要な範囲だけ Read（`offset` / `limit` を活用）

---

## 1. プロジェクト概要

**KuraSelect（暮らセレクト）** は、日用品・消耗品に特化した日本語の楽天アフィリエイト比較サイトです。トイレットペーパー、洗剤、シャンプーなど家庭の必需品を「コスパ」「機能」「使用感」で比較する記事を提供し、楽天市場へのアフィリエイトリンクで収益化しています。Astro による静的サイト生成 (SSG) で、現在は GitHub Pages にデプロイされています。

---

## 2. 技術スタック

| 項目 | 採用 |
|------|------|
| フレームワーク | Astro 6.1（SSG） |
| Islands | Preact 10（`compat: true`） |
| スタイル | Tailwind CSS v4（`@tailwindcss/vite` + `@theme`） |
| 言語 | TypeScript（strict） |
| コンテンツ | Content Collections（Zod スキーマ + glob loader） |
| Markdown 拡張 | MDX |
| OGP 画像生成 | Sharp |
| テスト | Vitest（`tests/frontmatter.test.ts` の frontmatter ユーティリティテスト） |
| パッケージマネージャ | **pnpm 固定**（`pnpm-lock.yaml` あり、`npm` / `yarn` 使用禁止） |
| Node | 22.x 以上 |
| デプロイ | GitHub Pages（GitHub Actions 経由、CNAME `www.kura-select.com`） |
| 自動化 | GitHub Actions：`deploy.yml`（main push でデプロイ）/ `update-products.yml`（毎週月曜 12:00 JST に楽天 API 同期） |

---

## 3. コマンド早見表

```bash
pnpm install               # 依存導入
pnpm dev                   # 開発サーバー (http://localhost:4321)
pnpm build                 # OGP 画像生成 → Astro ビルド
pnpm preview               # ビルド成果物のローカルプレビュー
pnpm test                  # Vitest
pnpm test:watch            # Vitest watch モード
pnpm generate-ogp          # OGP 画像のみ手動生成
pnpm update-products       # 楽天 API から商品データを更新
pnpm update-products:dry   # 上記の dry-run
pnpm update-products -- --concurrency=2 --api-interval=1000  # 記事並列数/API間隔を指定
pnpm check-additions -- --target=15       # 商品追加候補レポート
pnpm check-replacements -- --threshold=2  # 商品入れ替え候補レポート
```

`pnpm build` は **必ず `generate-ogp.mjs` を先に実行**してから Astro をビルドします（`package.json` で連結済み）。記事を追加・更新した後にデプロイする場合は、ローカルで `pnpm build` を回して OGP が生成されることを確認してください。

---

## 4. ディレクトリマップ

```
KuraSelect/
├ astro.config.mjs           # site / base / integrations
├ tsconfig.json              # strict + Preact JSX
├ package.json               # スクリプト・依存
├ .env / .env.example        # 環境変数（.env はコミット禁止）
├ CNAME                      # GitHub Pages カスタムドメイン（www.kura-select.com）
├ .github/workflows/
│  ├ deploy.yml              # main push で Pages にデプロイ
│  └ update-products.yml     # 月曜 12:00 JST に楽天 API 同期 → commit → deploy
├ Codex/                # ローカル作業メモ（.gitignore 済み、Codex が触らない）
├ tests/
│  └ frontmatter.test.ts     # frontmatter ライブラリの Vitest スイート
├ public/                    # 静的アセット（favicon, placeholder, og 画像出力先）
├ scripts/
│  ├ generate-ogp.mjs        # OGP 画像生成（ビルド前自動実行）
│  ├ update-products.mjs     # 楽天 API から商品情報を更新
│  └ lib/frontmatter.ts      # frontmatter 操作ユーティリティ
└ src/
   ├ content.config.ts       # Zod スキーマ（articles / categories）★唯一の正
   ├ env.d.ts                # Astro / env 型定義
   ├ content/
   │  ├ articles/            # 記事 .md / .mdx（53 本）
   │  └ categories/          # カテゴリ .md（43 件）
   ├ layouts/
   │  ├ BaseLayout.astro     # 全ページ共通（GA, Header, Footer, CSS 変数）
   │  └ ArticleLayout.astro  # 記事ページ専用（CTA、比較表、JSON-LD）
   ├ components/
   │  ├ layout/              # Header / Footer / Container
   │  ├ product/             # ProductCard, ComparisonTable(.astro / Sort.tsx), RakutenLink, TopPickCta
   │  └ seo/                 # BaseSeo, JsonLd
   ├ pages/
   │  ├ index.astro          # トップ（カテゴリ一覧 + 最新 6 記事）
   │  ├ articles/[...slug].astro  # 記事詳細（getStaticPaths）
   │  ├ category/[slug].astro     # カテゴリページ
   │  ├ rss.xml.ts                # RSS フィード
   │  └ about / contact / privacy / disclaimer.astro
   ├ lib/
   │  ├ rakuten.ts           # 楽天 URL ヘルパー（現状スタブ）
   │  └ site.ts              # サイト定数 + url() ヘルパー
   └ styles/global.css       # Tailwind v4 + @theme カラー/フォント定義
```

---

## 5. コンテンツ追加・編集ルール

### 5.1 スキーマは `src/content.config.ts` が唯一の正

記事 (`articles`) と カテゴリ (`categories`) のスキーマは Zod で定義されています。**スキーマを変更する場合は既存の 53 記事すべてに影響する**ことを意識し、必ず破壊的影響を見積もったうえでユーザーに確認してください。

主要バリデーション:
- `title`: 最大 **60 文字**
- `description`: 最大 **160 文字**
- `category`: `categories` への参照（slug ではなくファイル ID）
- `products[].rakutenUrl`: URL 形式必須
- `draft: true` でビルド対象から除外

### 5.2 記事追加の手順

1. 必要ならカテゴリを `src/content/categories/` に追加（`order` は既存と重複させない）
2. `src/content/articles/<slug>-comparison.md` を作成
3. frontmatter は既存記事（例: `toilet-paper-comparison.md`）をテンプレに
4. `pnpm build` でスキーマ検証 + OGP 生成が通ることを確認

### 5.3 アフィリエイト URL ルール

- `rakutenUrl` には**実際の楽天アフィリエイトリンク**（`https://hb.afl.rakuten.co.jp/...`）を入れる
- `https://example.com/...` 形式のプレースホルダは本番投入禁止
- 商品画像 (`imageUrl`) は `https://thumbnail.image.rakuten.co.jp/...` を直書き可

### 5.4 `.bak` ファイルの扱い

`src/content/articles/` には `*.md.bak` が 5 本残っています（`deodorant`, `face-wash`, `lint-roller`, `sunscreen`, `toothbrush`）。`.gitignore` で `*.bak` は除外されているためコミットには乗りません（あくまでローカルの旧テンプレ・差分保存）。それでも **Codex は勝手に削除・編集しない**こと。整理が必要ならユーザーに確認してから動く。

---

## 6. デプロイ環境

### 現状: GitHub Pages（GitHub Actions 経由）

- リポジトリの `main` ブランチに push すると `.github/workflows/deploy.yml` が起動し、`pnpm install` → `pnpm build` → `actions/deploy-pages@v4` で Pages に公開する。
- `CNAME` ファイルでカスタムドメイン `www.kura-select.com` を設定済み。
- `astro.config.mjs` は `site: https://www.kura-select.com`、`base` なしで運用中。
- 内部リンクは必ず `src/lib/site.ts` の `url()` ヘルパー経由で `BASE_URL` を解決すること（`/articles/...` のような直書きは GH Pages で 404 になる）。

### 商品データ自動更新（cron）

- `.github/workflows/update-products.yml` が **毎週月曜 03:00 UTC（日本時間 12:00）** に走り、`pnpm update-products` で楽天 API から最新価格などを取得 → `src/content/articles/` を `git commit & push`（bot コミット）→ `deploy.yml` を workflow_dispatch で起動。
- `pnpm update-products` は記事ファイル単位で並列処理する。既定は `--concurrency=2 --api-interval=1000`。楽天 API の 429 が出る場合は `--concurrency=1 --api-interval=2000` などに下げる。
- secrets: `RAKUTEN_APPLICATION_ID` / `RAKUTEN_ACCESS_KEY` / `PUBLIC_RAKUTEN_AFFILIATE_ID`。

### カスタムドメイン化 / Vercel 移行時の作業

- `astro.config.mjs` の `site` / `base` 設定を移行先ドメインに合わせて確認。
- 全記事・OGP・サイトマップが新ドメイン基準で再生成されるため、`pnpm build` の差分を必ず確認。
- Vercel 移行なら `vercel.json` 追加検討、`update-products.yml` のデプロイトリガーも書き換え。
- README は GitHub Pages / `security.checkOrigin` / CSP 未設定の実態に合わせて更新済み。移行時は再確認する。

---

## 7. 環境変数

| 変数 | 用途 | スコープ |
|------|------|----------|
| `PUBLIC_RAKUTEN_AFFILIATE_ID` | 楽天アフィリエイト ID | クライアント公開 |
| `PUBLIC_SITE_URL` | サイト canonical URL | クライアント公開 |
| `RAKUTEN_APPLICATION_ID` | 楽天 Web Service API ID | サーバ（`update-products.mjs`） |
| `RAKUTEN_ACCESS_KEY` | 楽天 Web Service API key | サーバ（同上） |

`.env` は **コミット禁止**。`.env.example` をテンプレに使う。

---

## 8. スタイリング規約

- **`tailwind.config.js` は使わない**（v4 方式）
- カラー / フォント / 行間は `src/styles/global.css` の `@theme` ブロックで一元管理
  - `--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-primary`, `--color-accent`, `--color-warning` …
- 個別コンポーネントで `#xxx` や `text-blue-500` のようなハードコードを避け、semantic token を優先
- フォントは Hiragino Sans / Noto Sans JP / system-ui の順でフォールバック

---

## 9. SEO / 構造化データ / OGP

- `src/components/seo/BaseSeo.astro` … OG / Twitter Card / canonical / RSS autodiscovery
- `src/components/seo/JsonLd.astro` … Article / Product / BreadcrumbList JSON-LD
- OGP 画像: `scripts/generate-ogp.mjs` が **`pnpm build` 時に自動生成**
  - 出力先: `public/og-default.png`, `public/og/articles/<slug>.png`
  - 1200×630px、Sharp + SVG テンプレ
  - 記事を追加・タイトル変更したら必ず再ビルド
- RSS: `src/pages/rss.xml.ts`
- サイトマップ: `@astrojs/sitemap` が自動生成

---

## 10. パフォーマンス基準

Lighthouse の **Performance / SEO / Accessibility / Best Practices すべて 95+** が設計目標。これを下回る変更は基本 NG。

実装ルール:
- Islands は `ComparisonTableSort.tsx` のみ。新規 island 追加は事前にユーザーへ理由提示
- ハイドレーションは `client:visible` 限定。**`client:load` 禁止**
- 画像は必ず `width` / `height` 指定（CLS 対策）
- 全画像に `alt` 必須
- フォーカスリング、ARIA、スキップリンクなどアクセシビリティを壊さない

---

## 11. アフィリエイト & 法務

- 楽天リンクは必ず `RakutenLink.astro` 経由で出力（`rel="sponsored nofollow noopener"` を中央管理）
- ステマ規制対応：`disclaimer.astro` と記事レイアウト下部にアフィリエイト表記を表示中。**外さないこと**
- 「最安」「No.1」「業界一」など断定表現は、比較日・対象範囲・出典の根拠が記事内に必要
- 効果効能（医薬品的記述）は薬機法に抵触しうるため、トーンは比較・コスパ訴求に寄せる

---

## 12. テスト

- 現状のテストは `tests/frontmatter.test.ts`（`scripts/lib/frontmatter.ts` のユーティリティを対象、`pnpm test` で実行可）。
- 追加するなら優先順位は次の通り:
  1. `src/lib/rakuten.ts` のロジック関数（現在スタブ、実装と並行で）
  2. Zod スキーマの境界値（title 60 文字、description 160 文字、`rakutenUrl` の URL 検証など）
  3. `scripts/update-products.mjs` のレスポンスパース・差分検出部分
- ビルドが通ることに加え、**`pnpm test` がグリーン**であることもスモークラインに含める。

---

## 13. Codex 作業時のお作法

1. **ファイル変更前に必ず Read**。推測で編集しない
2. 一括置換は破壊的になりやすい。まず 1 ファイルで動作確認 → 横展開
3. スキーマ変更（`content.config.ts`）は影響範囲（既存 53 記事）をユーザーに提示してから着手
4. README と `astro.config.mjs` のデプロイ設定・CSP 記述を触るときは整合性を確認
5. 日本語コンテンツが主。記事本文や見出しのコピーは**原則そのまま保持**、変更時はユーザー確認
6. コミットメッセージは日本語可
7. `node_modules`, `dist`, `.astro/` は触らない・読まない（時間の無駄）
8. 大きな変更は `pnpm build` を回して Zod / TS / OGP 全工程が通ることを確認
9. このリポジトリは原則 UTF-8。PowerShell の `Get-Content` では日本語が表示上文字化けすることがあるため、文字化けをファイル破損と即断しない。日本語内容を確認する場合は `Get-Content -Encoding utf8` と UTF-8 出力設定を使う。文字化けして見える本文を推測で編集しない。

---

## 14. 既知の負債 / TODO

- ~~[x] **`astro.config.mjs` と CNAME の不整合**：解消済み（2026-05-03）。`site` を `https://www.kura-select.com` に変更、`base` を削除~~
- ~~[x] README の「Vercel デプロイ」「`experimental.csp` 有効化」記述を GitHub Pages / CSP 未設定の実態に合わせて修正~~（2026-05-13）
- ~~[x] `*.md.bak`（5 本）の扱い：**残す**で確定（2026-05-03 ユーザー判断）。`.gitignore` 済みなのでコミットには影響しない~~
- [ ] `src/lib/rakuten.ts` の実装（現状スタブ。`update-products.mjs` と統合余地）
- [ ] `astro.config.mjs` の `image.domains` に `thumbnail.image.rakuten.co.jp` 追加検討（楽天画像の最適化）
- [ ] ESLint / Prettier / EditorConfig の導入可否
- ~~[x] `scripts/update-products.mjs` の使い方ドキュメント（README 未記載）~~ README に通常更新・並列/API制御・追加/入れ替え候補レポート・AI照合ファイルの扱いを追記（2026-05-13）
- [ ] CSP の本格設定（楽天画像ドメイン許可など）
- [ ] Vitest テストの拡充（`rakuten.ts` / Zod 境界値が手薄）

---

## 15. 参考リンク

- 楽天アフィリエイト: https://affiliate.rakuten.co.jp/
- 楽天 Web Service: https://webservice.rakuten.co.jp/
- Astro 6 ドキュメント: https://docs.astro.build/
- Tailwind CSS v4: https://tailwindcss.com/docs

---

_最終更新: 2026-05-03（初版）_
