---
name: kura-article-create
description: |
  KuraSelectの比較記事（{slug}-comparison.md）を楽天URLからゼロから新規生成するスキル。
  新しいカテゴリや商品ジャンルの比較記事を作りたい・楽天URLを渡して記事ファイルを生成したい場合に使う。
  既存記事への商品追加は kura-article-add を使う。
---

# KuraSelect 新規記事生成スキル

楽天URLから `src/content/articles/{slug}-comparison.md` を新規作成する。品質とトークン節約を優先し、商品ページの長文説明を読み込みすぎない。

## 入力

- 必須: `slug` / 記事テーマ / カテゴリslugまたは `新規: slug|日本語名|説明文|絵文字` / 楽天商品URL
- 任意: 比較単位（枚、本,mL,g,回など）/ 想定読者 / 除外したい商品タイプ
- 楽天URLは最低4件推奨。10件を超える場合は、初期記事では上位10件までにする

## Step 1: 既存カテゴリ確認

`references/categories.md` は補助情報として扱い、必ず実体の `src/content/categories/*.md` を確認する。

- 既存slug: `src/content/categories/{slug}.md` が存在することを確認
- 新規カテゴリ: 全カテゴリの `order` 最大値 + 1 で `src/content/categories/{slug}.md` を作成
- 記事テーマとカテゴリslugが明らかにズレる場合は編集前にユーザーへ確認する

```yaml
---
name: カテゴリ日本語名
slug: category-slug
description: 説明文（1〜2文）
icon: 絵文字
order: 44
---
```

## Step 2: 商品情報取得

全URLを確認するが、取得対象は最小限にする。

| 取得項目 | 用途 |
|---|---|
| 正式商品名 | `name` 正規化の元 |
| ブランド名 | `brand` |
| 容量・枚数・個数 | `capacity` |
| 商品タイプ・仕様 | `features` / 本文の根拠 |

価格・rating・reviewCount・imageUrl・affiliateUrl は `pnpm update-products` に任せる。商品ページの長いレビュー、広告文、ランキング文言は読まない。

> `name` と `capacity` は初期品質に直結する。推測せず、商品ページまたはURLから確認できる範囲で確定する。

## Step 3: カテゴリ適合チェック

各URLが記事テーマの「商品本体」か確認する。

- 明らかなカテゴリ外商品は追加しない
- 関連アクセサリ、収納用品、詰め替え容器、交換部品のみの商品は原則除外
- 近接カテゴリの商品は、主用途が違えば除外
- 判断が微妙、またはユーザー指定URLを除外する場合は編集前に確認する

## Step 4: `name` / `capacity` 正規化

`update-products.mjs` は `name` を検索キーワードに使うため、短く比較表向けに整える。

- `name` は60文字以内目安
- メーカー名プレフィックスを除く。ただし商品理解に必要なブランドは残す
- 送料無料、最安、ランキング、ショップ名、広告文、記号過多を除く
- `&` と `・`（中点）を含めない
- 容量除去後に英字1文字（L/M/S）が末尾に残らないようにする
- 全角スペース・記号は半角に寄せる
- `capacity` は `calcPricePerUnit` が解釈しやすい短い表記にする
  - 例: `30枚×3個（90枚）`, `400mL×3袋`, `12ロール`, `10本`

## Step 5: 記事ファイル生成

既存記事全文は大量に読まない。構成確認が必要な場合は、近いカテゴリの記事を1本だけ読む。

`src/content/articles/{slug}-comparison.md` を作成する。

```yaml
---
title: ""           # 最大60文字
description: ""     # 最大160文字
category: category-slug
publishedAt: YYYY-MM-DD
updatedAt: YYYY-MM-DD
draft: true            # update-products / build 後に問題なければ false へ変更
products:
  - rank: 1
    name: ""
    brand: ""
    price: 0
    capacity: ""
    pricePerUnit: "0円/単位"
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
tags:
  - "○○ おすすめ"
  - "○○ コスパ"
  - "○○ 比較"
  - "まとめ買い"
---
```

## Product Copy Rules

- `features` / `pros` / `cons` / `recommendedFor` に、価格・容量・個数・本数・枚数・単価・レビュー件数・ランキング順位など更新で変わる数字を書かない
- 数値情報は `price` / `capacity` / `pricePerUnit` / `rating` / `reviewCount` に閉じ込める
- 「安い」「大容量」「高評価」など更新で崩れやすい表現は避ける
- `features`: 商品ページで確認できる仕様・設計・素材・タイプ
- `pros`: 使いやすさ、選びやすい用途、ユーザー像
- `cons`: 合わない用途、注意点、好みが分かれる点
- 商品ごとの文言を使い回さない。完全同一の `features` / `pros` / `cons` を複数商品に並べない
- 薬機法・景表法に触れやすい効果効能の断定、「最安」「No.1」など根拠が必要な断定は避ける

## Body Rules

本文は選び方中心にし、更新で壊れる固定数字を避ける。

- 価格、レビュー件数、ランキング順位、年間コスト、特定商品の単価を本文に固定しない
- 商品名の列挙は必要最小限にする。ランキングや比較は frontmatter の比較表に任せる
- 「コスパ比較のポイント」では、単価の考え方・容量単位・まとめ買い時の注意点を書く
- FAQは3〜4問。医薬品的な効果効能、過度な断定、根拠のない推奨を避ける

本文構成:

```markdown
## ○○の選び方ガイド
### [商材に合った観点 2〜4個]

## タイプ別の特徴と使い分け

## コスパ比較のポイント

## よくある質問（FAQ）

## まとめ

---

※ 価格は記事執筆時点の楽天市場での販売価格です。価格は変動する場合があります。
```

## Step 6: 生成後チェック

可能な範囲で確認する。

```bash
rg "item.rakuten.co.jp" src/content/articles/{slug}-comparison.md
pnpm update-products
pnpm check-additions -- --target=10  # 10商品未満で候補追加したい場合のみ
pnpm test
pnpm build
```

確認観点:

- `rg "item.rakuten.co.jp"` が残る場合は `name` を修正して `pnpm update-products` を再実行
- 初期作成は `draft: true`。`pnpm update-products` / `pnpm build` 後に問題なければ `draft: false` へ変更
- 新規カテゴリでは `CATEGORY_SEARCH_RULES`、既存カテゴリの派生記事では `getArticleSpecificAdditionRule()` の追加を検討
- `pnpm update-products` 後は `reports/` と `reports/toAI/` に要確認ファイルが出ていないか確認
- category slug が実在する
- title 60文字以内、description 160文字以内
- `products[].rank` が連番
- `features` / `pros` / `cons` が商品間で完全重複していない
- 本文に更新で壊れる価格・レビュー件数・年間コストが残っていない

## 完了案内

生成完了後、実行済みコマンドと未実行コマンドを短く伝える。

```text
生成完了。次の確認:
1. pnpm update-products  （price / rating / rakutenUrl / imageUrl を更新）
2. rg "item.rakuten.co.jp" src/content/articles/{slug}-comparison.md
   → 残っている場合は name を修正して再実行
3. reports/ と reports/toAI/ の要確認ファイルを確認
4. 10商品未満なら pnpm check-additions -- --target=10 を検討
5. pnpm test
6. pnpm build
7. 問題なければ draft: false にして git add / commit / push
```
