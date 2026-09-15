# AGENTS.md

Codex などのエージェントがこのリポジトリで作業するときの**最低限の禁止事項と前提**です。作業前に必ず読んでください。

- このリポジトリは公開されています。ここには施策の中身や経緯を書かず、守るべきルールだけを書きます
- ローカルに `CLAUDE.md`（gitignore 済み）があれば、あわせて読んでください。詳しい運用ルールと経緯はそちらにあります
- ユーザーへの応答・コードコメント・コミットメッセージは日本語で書きます

---

## 1. プロジェクト概要

**KuraSelect（暮らセレクト）** は、日用品・消耗品の楽天アフィリエイト比較サイトです。Astro の静的サイト生成で作り、GitHub Pages（`www.kura-select.com`）で公開しています。

| 項目 | 採用 |
|---|---|
| フレームワーク | Astro 6（SSG）＋ Preact islands |
| スタイル | Tailwind CSS v4（`src/styles/global.css` の `@theme`。`tailwind.config.js` は使わない） |
| 言語 | TypeScript（strict） |
| コンテンツ | Content Collections。スキーマは `src/content.config.ts` が唯一の正 |
| テスト | Vitest（`tests/`） |
| パッケージマネージャ | **pnpm 固定**（npm / yarn は使わない） |
| 自動化 | `deploy.yml`（main への push でデプロイ）／`update-products.yml`（毎週月曜 12:00 JST に楽天 API で商品データを更新） |

---

## 2. 最重要: 測定凍結（触る前に必ず確認）

記事の一部は、SEO 施策の効果を測定するために**編集を凍結**しています。凍結中の記事を編集すると、測定が壊れて元に戻せません。

- **記事を編集する前に、必ず `data/measurement-holds.json` を読む**
  - `holds[]` の `slug` または `slugs` に含まれ、かつ **`releaseDate` が今日（JST）より後**なら凍結中です
  - `releaseDate` は「この日から編集してよい日」です。当日は編集できます
  - `releaseDate` が無い行は、期限なしの凍結です
  - `prohibitions[]` は範囲を限った期限なしの禁止です（例: 商品追加の禁止）。`scope` を確認してください
- **凍結中に触ってはいけないもの**: title / description / 本文 / 見出し / FAQ、および商品の意図的な追加・削除・差し替え・順位設計の変更
- **凍結中でも実施してよいもの**: `pnpm update-products` による価格などの自動更新。リンク切れの差し替えや、表示されている事実の誤りの修正も可能ですが、**この2つは実施前にユーザーに確認してください**（凍結が測っている指標を動かすことがあるため）
- 迷ったら触らずにユーザーに確認してください
- `data/measurement-holds.json` 自体を書き換えるのは、ユーザーの指示があった場合だけです

---

## 3. コンテンツ編集のルール

### 3.1 本文に数値を書かない

価格・単価・レビュー件数・年間コスト・順位など、更新で変わる数値の正は frontmatter の `products[]` だけです。本文と `faqs[].answer` には書きません。手書きの価格表も作りません。

- 比較・単価は、ページ上部の自動生成される比較表に任せます（単価は `src/lib/capacity.ts` の `calcPricePerUnit()` が表示時に計算します）
- 「30〜50% 安くなる傾向」のように、特定の商品に紐づかない一般的な目安は書いてかまいません
- `pnpm test` の `tests/article-body-lint.test.ts` がこの違反を検出します

### 3.2 記事ファイル（`src/content/articles/*.md`）の扱い

- `price` / `rating` / `reviewCount` / `imageUrl` / `capacity` / `pricePerUnit` / `updatedAt` などの**自動更新される欄は手で直さない**。データがおかしい場合は `scripts/update-products.mjs` や `scripts/lib/frontmatter.ts` の側を直します
- 商品を手で削除したら、`data/deleted-products-history.jsonl` にも追記します（自動で再追加されるのを防ぐため）
- FAQ は frontmatter の `faqs` に書き、`pnpm inject-faqs` で反映します。本文に直接書くとカード表示されません
- `title` は60文字以内、`description` は160文字以内です（Zod で検証されます）
- 記事本文や見出しのコピーは原則そのまま残します。変えるときはユーザーに確認してください
- `*.md.bak` は `update-products` が作るバックアップです。**削除・編集しない**

### 3.3 アフィリエイトと法務

- `rakutenUrl` には実際の楽天アフィリエイトリンクを入れます。`example.com` などのプレースホルダは本番に入れません
- 楽天リンクは必ず `src/components/product/RakutenLink.astro` 経由で出力します（`rel="sponsored nofollow noopener"` をここで一元管理しています）
- アフィリエイト表記（`disclaimer.astro` と記事下部の表記）を外さない
- 「最安」「No.1」などの断定表現には、比較日・対象範囲・出典が必要です
- 効果効能（医薬品的な記述）は書かず、比較・コスパの観点で書きます

---

## 4. 実装のルール

- 内部リンクは必ず `src/lib/site.ts` の `url()` ヘルパーを通します（直書きするとリンクが壊れます）
- 新しい island は追加前にユーザーへ理由を示します。ハイドレーションは `client:visible` だけにし、**`client:load` は使いません**
- 画像には必ず `width` / `height` と `alt` を付けます
- 色やフォントはハードコードせず、`@theme` のトークンを使います
- スキーマ（`src/content.config.ts`）を変えると全記事に影響します。着手前に影響範囲をユーザーに示してください
- `.agents/skills/` と `.claude/skills/` は同じ内容です。スキルを変えるときは両方に同じ変更を入れます
- `data/rag/` は `pnpm export-ai-rag` で生成されます。直接編集しません
- `.env` はコミットしません。`reports/` もコミットしません（gitignore 済み）
- `node_modules` / `dist` / `.astro/` は読まない・触らない

---

## 5. 環境まわりの注意（Windows）

- 日本語の文字数を数えるときに PowerShell 5.1 を使わないでください。UTF-8 を誤って読み、文字数が大きくずれます。Node.js の `readFileSync(path, 'utf8')` を使います
- PowerShell で日本語が文字化けして見えても、ファイルが壊れているとは限りません。文字化けした本文を推測で編集しないでください
- `.ps1` は UTF-8（BOM 付き）で保存します
- Git Bash で `--file=/正規表現/` のような引数を渡すとパスとして変換されます。`MSYS_NO_PATHCONV=1` を付けてください

---

## 6. アクセス解析の数値の扱い

- GSC / Bing のデータは2〜3日遅れて反映され、まだ反映されていない日は0ではなく**行ごと欠けます**。最後に返ってきた日付（確定日）までで期間を区切り、要求した日数で割らないでください
- サイト全体の合計は、行を足し合わせるのではなく `dimensions: []` で取得します
- 施策の成否はエージェントが独自に判定せず、`pnpm weekly:snapshot` / `pnpm gsc:harvest` の出力をもとにユーザーと確認します

---

## 7. コマンド

```bash
pnpm install
pnpm dev                    # http://localhost:4321
pnpm build                  # OGP 画像生成 → Astro ビルド
pnpm test                   # Vitest（変更後は必ずグリーンを確認）
pnpm update-products        # 楽天 API から商品データを更新（:dry で dry-run）
pnpm check-additions        # 商品追加候補レポート
pnpm check-replacements     # 商品入れ替え候補レポート
pnpm check-internal-links   # 内部リンク点検（凍結台帳を参照）
pnpm inject-faqs            # frontmatter の faqs を反映
pnpm export-ai-rag          # data/rag/ を再生成
pnpm weekly:snapshot        # 週次アクセスのスナップショット
pnpm gsc:harvest            # GSC のテコ入れ候補レポート
pnpm cohort:crawl-check     # コホート施策の再クロール確認
```

大きな変更の後は `pnpm build` と `pnpm test` の両方が通ることを確認してください。

---

_最終更新: 2026-09-15（公開リポジトリ向けに、禁止事項だけで完結する版へ全面改訂）_
