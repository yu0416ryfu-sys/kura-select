---
name: kura-check-additions-debug
description: |
  KuraSelect の `pnpm check-additions` が出力した商品追加候補の不具合を調査し、
  `scripts/update-products.mjs` の候補生成・カテゴリ判定・重複判定・容量抽出まわりを改善するスキル。
  候補にカテゴリ外商品が混ざる、正しい商品が除外される、追加候補が0件になる、
  reports/addition-urls-*.md の精度を上げたい場合に使う。
  kura-article-add が check-additions 由来候補のカテゴリ外混入を検知した場合にも使う。
---

# KuraSelect check-additions 精度改善スキル

`pnpm check-additions` の候補レポートを読み、原因を分類して最小修正する。

## 入力として見るもの

- 対象記事: `src/content/articles/{slug}-comparison.md`
- 不適切候補の例: `reports/addition-urls-*.md` のURL・商品名
- 期待カテゴリ: 記事frontmatterの `category`
- `kura-article-add` のカテゴリ適合チェックで除外された候補がある場合、その商品名・URL・除外理由・レポート診断行

## 調査手順

1. 対象記事の `category`、既存 `products[]`、既存URLを確認する。

   ### RAG参照（Step 1 完了後に実施）

   MCPが利用可能な場合は以下を優先する。MCPが利用できない場合は、その旨をユーザーへ簡潔に報告してから下記フォールバックを使う。

   **MCPを使う場合**

   `mcp__kura-content__search_rag(query:"{対象カテゴリslug}", type:"category-rule")` で対象カテゴリの典型単位・頻出ブランドを確認し、`CATEGORY_SEARCH_RULES` の `units` / `exclude` 調整の根拠として使う。

   ※ `search_rag` は部分一致検索。返却された record の `category` を確認し、無関係な行が混ざっていないかチェックすること。

   **MCPが利用不可の場合（フォールバック）**

   `data/rag/category-rules.jsonl` が存在する場合、対象カテゴリの典型単位・頻出ブランドを確認し、`CATEGORY_SEARCH_RULES` の `units` / `exclude` 調整の根拠として使う。

   ```bash
   rg '"category":"{対象カテゴリslug}"' data/rag/category-rules.jsonl
   ```

   存在しない場合はスキップする。

2. `reports/addition-candidates-*.md` と `reports/addition-urls-*.md` を確認する。
3. `scripts/update-products.mjs` の以下を順に疑う。
   - `CATEGORY_SEARCH_RULES`: 検索語、include、exclude、units、minScore
   - `checkAdditionCandidateCategory`: カテゴリ語必須・除外語判定
   - `isSameProductDifferentUrl` / `productNameLooksSame`: 誤重複・重複漏れ
   - `extractCapacityFromItemName` / `extractCapacityTotal`: 容量抽出不可・単位不一致
4. 不適切候補が「通った理由」と、正しい候補が「落ちた理由」をレポートの診断行で確認する。
5. 修正はカテゴリ専用ルールの追加・除外語追加・重複判定の調整を優先し、汎用ロジック変更は影響範囲を確認してから行う。

## 実行と検証

対象記事だけで再実行する。

```bash
corepack pnpm exec node scripts/update-products.mjs --check-additions --file={slug}-comparison.md
```

確認するもの:

- `reports/addition-urls-YYYY-MM-DD.md` にカテゴリ外商品が残っていない
- `reports/addition-candidates-YYYY-MM-DD.md` の「判定」行にカテゴリ語・除外語の根拠が出ている
- 正しい候補が「URL違い同一商品」や「カテゴリ外」で誤除外されていない

最後に必ず実行する。

```bash
node --check scripts/update-products.mjs
corepack pnpm test
```

記事やスキーマに触った場合のみ `corepack pnpm build` も実行する。

## 完了報告

ユーザーには以下を簡潔に伝える。

- 原因分類
- 修正したロジック
- 対象記事で再生成された候補の状態
- `kura-article-add` から引き継いだカテゴリ外候補がある場合、その候補が再生成後の `addition-urls` に残っていないか
- 実行した検証コマンド
