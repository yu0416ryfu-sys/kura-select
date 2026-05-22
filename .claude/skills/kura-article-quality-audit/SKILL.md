---
name: kura-article-quality-audit
description: KuraSelect の比較記事について、title/description/本文の商品件数・価格訴求・pricePerUnit・法務表現・affiliate URL を監査するスキル。
---

# kura-article-quality-audit

比較記事の品質問題を早期に検出して報告する。

## 対象

ユーザーが記事ファイルを指定した場合はその記事のみ監査する。未指定の場合は対象範囲（全記事 or 特定カテゴリ）をユーザーに確認する。

## Workflow

1. 対象記事の frontmatter と本文を読む。
2. 以下の確認項目を順に実施する。
3. 問題を3段階で分類して報告する。
4. 自動修正はしない。ユーザーが修正を依頼した場合に限り実装計画を提示する。

## 確認項目

**商品件数の一貫性**
- `products[]` の実件数と `title` / `description` / 本文の件数表現が一致するか。
- 例: タイトルに「5選」とあるのに `products` が4件なら不一致。

**pricePerUnit の品質**
- `pricePerUnit` が `0円/枚`、`要更新`、`-`、未設定の商品を抽出する。
- `price` と `capacity` から再計算できる場合は正しい値を提示する。

**price の妥当性**
- `price: 0` または極端に安い（100円以下）商品を報告する。

**rakutenUrl の検証**
- `https://hb.afl.rakuten.co.jp/` で始まらない商品を抽出する（アフィリエイトURL必須）。
- `https://example.com/` などのプレースホルダが残っていないか確認する。

**法務表現**
- 「最安」「No.1」「業界一」などの断定表現を確認する。
  - 比較日・対象範囲・出典が本文にあれば問題なし。
  - 根拠なしで断定している場合は修正候補。
- 「効果がある」「改善する」などの効果効能表現を確認する（薬機法）。

**title / description 文字数**
- `title`: 60文字以内か（Zod スキーマ制約）。
- `description`: 160文字以内か（Zod スキーマ制約）。

## 問題の分類

- `blocking`: ビルドが失敗する可能性（URL形式違反、スキーマ文字数超過）
- `warning`: 品質・法務リスク（pricePerUnit要更新、根拠なし断定表現、アフィリエイトURL以外）
- `info`: 軽微・任意対応（価格の最新化推奨、表現の改善提案）

## RAG参照

`data/rag/products.jsonl` が存在する場合、`needsReview: true` の商品を優先して報告する。存在しない場合は記事から直接確認する。

## 注意

- `pnpm build` でスキーマ検証が通ることが最低条件。
- `blocking` 問題はユーザーに即時報告する。
- `warning` / `info` は修正候補としてまとめて提示する。
