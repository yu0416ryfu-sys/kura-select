---
name: kura-rag-refresh
description: KuraSelect の記事frontmatter・reports/ai-matches・capacity review JSONL から data/rag/*.jsonl を再生成し、件数・欠損・review対象を確認するスキル。
---

# kura-rag-refresh

`data/rag/` の JSONL を最新状態に更新し、件数・品質状況を報告する。

## Workflow

1. `package.json` に `export-ai-rag` スクリプトがあることを確認する。
2. RAG エクスポートを実行する。

```bash
corepack pnpm export-ai-rag
```

3. `data/rag/summary.json` を読み、件数を確認する。
4. 以下を報告する。
   - `articleCount` / `productCount` / `capacityPatternCount` / `matchDecisionCount` / `categoryRuleCount`
   - `needsReviewCount`（商品レベルで `needsReview: true` の件数）
5. `needsReview` が多い、または Yahoo offer 確認が必要な場合は関連スキルを案内する。
   - capacity / pricePerUnit の不整合が多い場合 → `kura-capacity-review-jsonl`
   - Yahoo offer の状態確認が必要な場合 → `kura-yahoo-offer-review`

## 出力ファイル

| ファイル | 内容 |
|---|---|
| `data/rag/products.jsonl` | 全商品フラットレコード |
| `data/rag/capacity-patterns.jsonl` | capacity 表記パターン（記事 + レポート） |
| `data/rag/match-decisions.jsonl` | AI 照合履歴 |
| `data/rag/category-rules.jsonl` | カテゴリ別ルール（単位・頻出ブランド） |
| `data/rag/summary.json` | 件数サマリー |

## 注意

- `reports/ai-matches/` が存在しない環境では `matchDecisionCount: 0` になる（正常）。
- `data/rag/` は gitignore 対象外。`data/rag/.gitkeep` は追跡済み。
- スクリプトが見つからない場合は `package.json` の `export-ai-rag` キーを確認する。
