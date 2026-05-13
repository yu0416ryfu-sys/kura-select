---
name: kura-product-match-ai
description: KuraSelect の reports/product-match-input-*.jsonl をもとに、update-products が自動更新できなかった商品の楽天候補を照合し、reports/ai-matches/pending/ に置ける JSONL を生成するスキル。商品候補の同一性判定、比較記事向けの商品名整形、capacity / pricePerUnit の整合判断を行う。
---

# kura-product-match-ai

KuraSelect の `pnpm update-products` が生成した商品照合候補レポートを読み、AI適用用 JSONL を作る。

## 対象入力

主に以下のファイルを対象にする。

```text
reports/product-match-input-*.jsonl
```

入力 JSONL は各行が独立した商品照合タスク。md 全文は読まない。必要最小限として、各行の `current` / `failure` / `candidates` だけで判断する。

## 出力先

AI判定結果は以下に置く。

```text
reports/ai-matches/pending/product-match-output-YYYY-MM-DD.jsonl
```

次回 `pnpm update-products` 実行時に自動適用される。

## 判定方針

`current` 商品と `candidates` の中から、同一または実質的に同じ商品を選ぶ。

優先する一致条件:

- ブランド一致
- 商品種別一致
- サイズ一致
- 用途一致
- 容量または総枚数が current と近い
- affiliateUrl / itemUrl / imageUrl が有効

採用してよい例:

- `32枚×3箱` と `96枚`
- `30枚×3個` と `90枚`
- 同一シリーズの容量違いで、記事の比較意図と矛盾しないもの

採用しない例:

- サイズ違い
- 用途違い
- シリーズ違い
- 素材違い
- 別カテゴリ商品
- ふるさと納税
- 訳あり詰め合わせ
- ショップ独自セットで中身が不明
- current の特徴文と矛盾する商品
- 確信できない候補

確信できない場合は無理に選ばず `review` にする。

## 商品名ルール

`newName` は楽天の商品名をそのまま使わず、比較記事向けに短く整える。

- 60文字以内
- ブランド + 商品種別 + サイズ + 容量がわかる名前
- 送料無料、最安、ランキング、ショップ名、広告文、記号過多は除く
- 読者が比較表で理解しやすい名前にする

例:

```text
ジップロック ストックバッグ L 32枚×3箱
ジップロック フリーザーバッグ M 90枚
```

## capacity ルール

`newCapacity` は比較単位がわかる短い表記にする。

例:

```text
32枚×3箱（96枚）
90枚
60枚×3箱（180枚）
```

`newPricePerUnit` は `newPrice` と `newCapacity` から明確に計算できる場合のみ出す。

枚数商品の形式:

```text
約12.3円/枚
```

計算できない、容量解釈に不安がある、または単位が不明な場合は `null` にする。

## 出力形式

説明文、Markdown、コードブロックは禁止。JSONL のみ返す。

入力1行につき出力1行。入力行数と出力行数を一致させる。

### replace の形式

```json
{"articleFile":"src/content/articles/storage-bag-comparison.md","rank":1,"current":{"name":"ジップロック ストックバッグ L 大容量 32枚入×3箱"},"action":"replace","selectedItemUrl":"https://item.rakuten.co.jp/...","selectedAffiliateUrl":"https://hb.afl.rakuten.co.jp/...","selectedImageUrl":"https://thumbnail.image.rakuten.co.jp/...","newName":"ジップロック ストックバッグ L 32枚×3箱","newCapacity":"32枚×3箱（96枚）","newPrice":1234,"newPricePerUnit":"約12.9円/枚","newRating":4.5,"newReviewCount":100,"confidence":"high","reason":"ブランド・商品種別・サイズ・総枚数が一致"}
```

### review の形式

```json
{"articleFile":"src/content/articles/storage-bag-comparison.md","rank":1,"current":{"name":"ジップロック ストックバッグ L 大容量 32枚入×3箱"},"action":"review","selectedItemUrl":null,"selectedAffiliateUrl":null,"selectedImageUrl":null,"newName":null,"newCapacity":null,"newPrice":null,"newPricePerUnit":null,"newRating":null,"newReviewCount":null,"confidence":"low","reason":"候補がサイズ違いまたは商品種別違いのため確定不可"}
```

## 必須ルール

- `candidates` にない URL を作らない
- `selectedAffiliateUrl` は candidates の `affiliateUrl` を使う
- `selectedItemUrl` は candidates の `itemUrl` を使う
- `selectedImageUrl` は candidates の `imageUrl` を使う
- `articleFile`、`rank`、`current.name` は入力から引き継ぐ
- `replace` 適用時は `rank + current.name` の二重照合が行われるため、`current.name` を省略しない
- `action` は `replace` または `review` のみ
- `confidence` は `high` / `medium` / `low`
- `replace` は確信がある場合のみ
- 判断根拠は `reason` に短く書く

## 適用確認

出力 JSONL を `reports/ai-matches/pending/` に置いた後は、まず dry-run で確認する。

```bash
pnpm update-products:dry
```

問題なければ本実行する。

```bash
pnpm update-products
```
