# update-products AI商品照合フロー運用マニュアル

このマニュアルは、`pnpm update-products` で自動更新できなかった商品をAIで照合し、その結果を次回の `pnpm update-products` で記事Markdownへ反映する運用をまとめたものです。

対象スクリプト: `scripts/update-products.mjs`

## 全体像

```text
1. update-products で商品更新を試す
2. 自動更新できない商品は候補レポート JSONL としてAIに渡す
3. AIが候補から同一商品を判定し、適用用 JSONL を作る
4. 適用用 JSONL を reports/ai-matches/pending/ に置く
5. 次回 pnpm update-products 実行時に JSONL が自動適用される
6. 適用後、通常の商品更新処理が続く
```

現状は、通常更新失敗商品の候補レポート生成と、AI判定結果 JSONL の自動適用まで実装済みです。

## ディレクトリ構成

```text
reports/
  product-match-input-YYYY-MM-DD.jsonl        # AIへ渡す候補レポート
  ai-matches/
    pending/
      product-match-output-YYYY-MM-DD.jsonl   # AI判定結果。update-products が読む
    processed/
      product-match-output-YYYY-MM-DD.jsonl   # 全行処理成功後の移動先
    failed/
      product-match-output-YYYY-MM-DD.jsonl   # 1行でも失敗した場合の移動先
    review/
      product-match-review-YYYY-MM-DD.jsonl   # action: review の記録
```

`reports/` は `.gitignore` 済みのため、通常はコミットされません。

## AIへ渡す候補レポート

AIには記事全文ではなく、商品ごとの候補 JSONL だけを渡します。

例:

```json
{"articleFile":"src/content/articles/storage-bag-comparison.md","rank":1,"current":{"name":"ジップロック ストックバッグ L 大容量 32枚入×3箱","capacity":"32枚×3箱（96枚）","price":1350,"rakutenUrl":"https://example.com/placeholder/ziploc-stock-l-96"},"failure":{"stage":"search","error":"API HTTP 400 keyword is not valid"},"candidates":[{"itemName":"ジップロック ストックバッグ L 32枚入×3個","itemUrl":"https://item.rakuten.co.jp/example/item-a/","affiliateUrl":"https://hb.afl.rakuten.co.jp/example-a","price":1234,"rating":4.5,"reviewCount":100,"imageUrl":"https://thumbnail.image.rakuten.co.jp/example.jpg","capacityExtracted":"32枚×3個"}]}
```

AIに判断させる内容:

- `current` と同一または実質的に同じ商品か
- 採用する候補URL
- 比較記事向けの商品名
- `capacity`
- `pricePerUnit`
- 判断できない場合は `review`

## AI判定結果 JSONL の形式

AIの出力は、説明文なしの JSONL にします。入力1行につき出力1行が原則です。

### replace

確信をもって商品を差し替える場合。

```json
{"articleFile":"src/content/articles/storage-bag-comparison.md","rank":1,"current":{"name":"ジップロック ストックバッグ L 大容量 32枚入×3箱"},"action":"replace","selectedItemUrl":"https://item.rakuten.co.jp/example/item-a/","selectedAffiliateUrl":"https://hb.afl.rakuten.co.jp/example-a","selectedImageUrl":"https://thumbnail.image.rakuten.co.jp/example.jpg","newName":"ジップロック ストックバッグ L 32枚×3箱","newCapacity":"32枚×3箱（96枚）","newPrice":1234,"newPricePerUnit":"約12.9円/枚","newRating":4.5,"newReviewCount":100,"confidence":"high","reason":"ブランド・商品種別・サイズ・総枚数が一致"}
```

必須:

- `articleFile`
- `rank`
- `current.name`
- `action: "replace"`
- `selectedAffiliateUrl`

任意:

- `selectedItemUrl`
- `selectedImageUrl`
- `newName`
- `newCapacity`
- `newPrice`
- `newPricePerUnit`
- `newRating`
- `newReviewCount`
- `confidence`
- `reason`

### review

候補を確定できない場合。

```json
{"articleFile":"src/content/articles/storage-bag-comparison.md","rank":1,"current":{"name":"ジップロック ストックバッグ L 大容量 32枚入×3箱"},"action":"review","selectedItemUrl":null,"selectedAffiliateUrl":null,"newName":null,"newCapacity":null,"newPrice":null,"newPricePerUnit":null,"confidence":"low","reason":"候補がサイズ違いまたは商品種別違いのため確定不可"}
```

`review` は記事に反映されません。後で確認できるように `reports/ai-matches/review/` に記録されます。

## 適用手順

AI判定結果を以下に置きます。

```text
reports/ai-matches/pending/product-match-output-YYYY-MM-DD.jsonl
```

その後、通常通り実行します。

```bash
pnpm update-products
```

特定記事だけ確認したい場合:

```bash
node scripts/update-products.mjs --file=storage-bag-comparison.md
```

書き換えずに確認したい場合:

```bash
pnpm update-products:dry
```

`--dry-run` ではMarkdown更新、`.bak` 作成、JSONL移動は行いません。

## update-products 実行時の処理順

`pnpm update-products` は、通常の商品更新より先に `pending` のAI判定結果を適用します。

```text
1. reports/ai-matches/pending/*.jsonl を読む
2. articleFile ごとに対象Markdownを読む
3. replace / review を行ごとに処理
4. 差分があればMarkdownを更新し、updatedAtを更新
5. 元ファイルを .bak に保存
6. JSONLを processed または failed へ移動
7. 通常の商品価格・レビュー更新へ進む
```

この順番により、AIが差し替えた楽天URLを使って、同じ実行内で価格・レビュー・画像の通常更新も試せます。

## 安全チェック

`replace` は以下を満たす場合だけ適用されます。

- `articleFile` が `src/content/articles/` 配下
- `articleFile` が存在する
- `selectedAffiliateUrl` がURL形式
- `rank` の商品が存在する
- `rank` の商品名と `current.name` が一致する

`rank` だけでは適用しません。ランキング並び替えや手動編集で別商品を指す事故を避けるため、`rank + current.name` の二重照合を行います。

## JSONLファイルの移動ルール

```text
pending/*.jsonl
  ↓ 全行処理成功
processed/*.jsonl

pending/*.jsonl
  ↓ 1行でも失敗
failed/*.jsonl
```

成功扱い:

- `replace` を正常適用できた
- `review` を仕様通りスキップできた
- `--file` フィルタ対象外としてスキップした

失敗扱い:

- JSON parse エラー
- `articleFile` が不正
- `articleFile` が存在しない
- `action` が `replace` / `review` 以外
- `replace` なのに `selectedAffiliateUrl` がない
- `rank` と `current.name` の二重照合に失敗
- Markdown更新中に例外

失敗したJSONLを再実行する場合は、原因を修正して `reports/ai-matches/pending/` に戻します。

## Markdownへ反映される項目

AI判定結果から以下を更新できます。

| JSONL field | Markdown field |
|---|---|
| `newName` | `products[].name` |
| `newCapacity` | `products[].capacity` |
| `newPrice` | `products[].price` |
| `newPricePerUnit` | `products[].pricePerUnit` |
| `selectedAffiliateUrl` | `products[].rakutenUrl` |
| `selectedImageUrl` | `products[].imageUrl` |
| `newRating` | `products[].rating` |
| `newReviewCount` | `products[].reviewCount` |

更新があったMarkdownは `updatedAt` も当日の日付に更新されます。

## AIへの指示テンプレート

```text
あなたは KuraSelect の商品情報整合アシスタントです。
入力 JSONL は pnpm update-products が自動更新できなかった商品の候補一覧です。
各行を独立して判定し、出力も JSONL で1行ずつ返してください。

目的:
- current 商品と candidates の中から、同一または実質的に同じ商品を選ぶ
- 楽天の商品名をそのまま使わず、比較記事向けに読みやすい商品名へ整える
- capacity と pricePerUnit の整合を判断する
- 判断できない場合は replace せず review にする

判定ルール:
- ブランド、商品種別、サイズ、用途が一致する候補を優先
- 枚数違い・箱数違いは、総枚数や総容量が current と近ければ採用可
- サイズ違い、用途違い、シリーズ違い、素材違いは採用しない
- ふるさと納税、訳あり詰め合わせ、別カテゴリ商品は採用しない
- current の特徴文と矛盾する候補は review
- candidates に確信できる候補がなければ review

name ルール:
- 60文字以内
- ブランド + 商品種別 + サイズ + 容量がわかる名前
- 送料無料、最安、ランキング、ショップ名、広告文は除く

capacity ルール:
- 短く比較単位がわかる表記にする
- 例: "32枚×3箱（96枚）"
- 例: "90枚"
- pricePerUnit は計算できる場合のみ出す
- 枚数商品は "約12.3円/枚"
- 不安がある場合は null

出力:
- 説明文、Markdown、コードブロックは禁止
- JSONLのみ返す
- 入力行数と出力行数を一致させる
- candidates にない URL を作らない
- selectedAffiliateUrl は candidates の affiliateUrl を使う
- selectedItemUrl は candidates の itemUrl を使う
- selectedImageUrl は candidates の imageUrl を使う
- articleFile、rank、current.name は入力から引き継ぐ
```

## 確認コマンド

AI判定結果を置いた後は、まず dry-run で確認します。

```bash
pnpm update-products:dry
```

問題なければ本実行します。

```bash
pnpm update-products
```

記事更新後は必要に応じてテストとビルドを実行します。

```bash
pnpm test
pnpm build
```
