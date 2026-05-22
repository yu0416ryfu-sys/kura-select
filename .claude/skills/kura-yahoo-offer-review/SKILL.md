---
name: kura-yahoo-offer-review
description: KuraSelect の products[].offers にある Yahoo offer の pending/review/matched 状態を、楽天商品・capacity・matchNotes・RAG履歴から確認し、昇格・保留・除外の候補を整理するスキル。
---

# kura-yahoo-offer-review

Yahoo Shopping の照合結果を整理し、`matchStatus` の昇格・保留・除外を判断する。

## 対象入力

ユーザーが記事ファイルを指定した場合はその記事を読む。未指定の場合は `data/rag/products.jsonl` から `offerSummary` に `yahoo` が含まれる商品を探し、対象記事を特定する。

## Workflow

1. 対象記事の `products[].offers[]` を読む。
2. `provider: "yahoo"` のエントリを抽出し、`matchStatus` ごとに分類する。
3. 各エントリについて以下を確認する。
   - `capacity` と `matchedCapacity` が一致するか。
   - `matchNotes` に capacity 不一致・別商品の疑いが記録されていないか。
   - URL のショップコード・商品コードが同一商品を指しているか。
4. 昇格・保留・除外の候補を判定表に基づいて整理し報告する。
5. 自動で記事を編集しない。変更が必要な場合は実装計画または修正依頼に進む。

## 判定表

| matchStatus | 条件 | 推奨 |
|---|---|---|
| `matched` | capacity一致・URL妥当 | 維持 |
| `pending` | 同一URL・capacity一致・根拠十分 | `matched` 昇格候補 |
| `pending` | URL変更直後・根拠不足 | `pending` 維持 |
| `review` | capacity不一致・別商品疑い | 人間確認 |
| `rejected` | 明示除外済み | 維持 |

## RAG参照

`data/rag/match-decisions.jsonl` が存在する場合、同一商品（同一 rakutenCode または name 近似）の過去判定を参照し、パターンの一貫性を確認する。存在しない場合は従来フローで続行する。

## 注意

- `matchStatus` の変更を推奨する場合は、対象記事ファイル・rank・現在の matchStatus を明記する。
- 実際の frontmatter 変更はユーザーの確認後に行う。
- Yahoo offer は楽天の補完情報。`rakutenUrl` の判断を優先する。
