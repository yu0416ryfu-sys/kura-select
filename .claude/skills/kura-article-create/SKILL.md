---
name: kura-article-create
description: |
  KuraSelectの比較記事（{slug}-comparison.md）を楽天URLからゼロから新規生成するスキル。
  新しいカテゴリや商品ジャンルの比較記事を作りたい・楽天URLを渡して記事ファイルを生成したい場合に使う。
  既存記事への商品追加は kura-article-add を使う。
---

# KuraSelect 新規記事生成スキル

## 入力

- **カテゴリ**: 既存slug（`references/categories.md` 参照）または `新規: slug|日本語名|説明文|絵文字`
- **商品URL**: ランク1〜4の `item.rakuten.co.jp` URL（最低4件推奨）

---

## Step 1: 商品情報取得

全URLをWebFetchし、各商品の `name` / `brand` / `capacity` / 特徴テキストを確定する。

> `name` と `capacity` はスクリプトで上書きされない。推測せず必ずWebFetchで確認すること。

## Step 2: `name` 正規化（厳守）

`update-products.mjs` が `name` をそのまま楽天API検索キーワードに使うため、以下を守る:

- メーカー名プレフィックスを除く（「花王 マジックリン」→「マジックリン」）
- `&` と `・`（中点）を含めない
- 容量除去後に英字1文字（L/M/S）が末尾に残らないようにする
- 全角スペース・記号は半角に正規化する

## Step 3: カテゴリ処理

`references/categories.md` を Read して既存カテゴリを確認する。

- **既存slug**: そのまま使用
- **新規指定時**: `src/content/categories/{slug}.md` を作成（`order` は現在の最大値 + 1）

```yaml
---
name: カテゴリ日本語名
slug: category-slug
description: 説明文（1〜2文）
icon: 絵文字
order: 41
---
```

## Step 4: 記事ファイルを生成

`src/content/articles/{slug}-comparison.md` を以下のテンプレートで生成する。

```yaml
---
title: ""           # 最大60文字。形式: ○○ コスパ最強ランキング【2026年版】1{単位}あたり最安で比較
description: ""     # 最大160文字
category: category-slug
publishedAt: YYYY-MM-DD
updatedAt: YYYY-MM-DD
draft: false
products:
  - rank: 1
    name: ""
    brand: ""
    price: 0
    capacity: ""
    pricePerUnit: "0円/単位"   # 単位はカテゴリに合わせる（個/枚/ml/g/回 など）
    rating: 0
    reviewCount: 0
    features:
      - ""
      - ""
      - ""
    pros:
      - ""
      - ""
      - ""
    cons:
      - ""
      - ""
    recommendedFor: ""
    rakutenUrl: "https://item.rakuten.co.jp/..."
    imageUrl: ""
  # rank 2〜4 も同形式
tags:
  - "○○ おすすめ"
  - "○○ コスパ"
  - "○○ 比較"
  - "まとめ買い"
---
```

**本文構成（この順序で生成）**:

```
## ○○の選び方ガイド
### [商材に合った観点 2〜4個]

## タイプ別の特徴と使い分け

## コスパ比較のポイント
[比較表を含む]

## よくある質問（FAQ）
[Q&A 3〜4問]

## まとめ

---
※ 価格は記事執筆時点の楽天市場での販売価格です。価格は変動する場合があります。
```

## Step 5: 完了後の案内

生成完了後、ユーザーに以下をそのまま伝える（`{slug}` は実際のスラグに置換）:

```
生成完了。次の手順:
1. pnpm update-products  （price / rating / rakutenUrl / imageUrl を更新）
2. grep -r "item.rakuten.co.jp" src/content/articles/{slug}-comparison.md
   → 残っている場合は商品名を修正して再実行
3. pnpm build  （スキーマ検証）
4. git add / commit / push
```
