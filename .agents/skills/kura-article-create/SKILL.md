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

カテゴリ実体の確認（`src/content/categories/*.md` の存在確認・order 最大値）は従来どおりファイルを直接確認する。
MCPが利用可能な場合は補助的に `mcp__kura-content__list_articles` を使い、同カテゴリの既存記事有無・商品件数・updatedAt を確認できる。

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

## RAG参照

`data/rag/capacity-patterns.jsonl` が存在する場合、対象カテゴリの既存 capacity 表記パターンを確認し、Step 4 の正規化で一貫した形式を使う。

MCPが利用可能な場合は以下の2ステップで取得する:

```text
mcp__kura-content__search_rag(query:"{対象カテゴリslug}", type:"product") で articleFile を確認
mcp__kura-content__search_rag(query:"{確認したarticleFile}", type:"capacity-pattern")
```

`search_rag` はJSONL全文の部分一致検索で、`type` はファイル絞り込みのみ。返却された行の `category` / `articleFile` を必ず確認し、無関係な行が混ざっていないかチェックする。

MCPが利用不可の場合は、その旨をユーザーへ簡潔に報告してから、既存の2ステップ rg コマンドを使う（フォールバック）。

フォールバック手順:

`capacity-patterns.jsonl` には `category` フィールドがないため、まず `products.jsonl` で対象カテゴリの `articleFile` を確認し、その `articleFile` で絞り込む。対象記事が既に存在する場合は対象記事の `articleFile` を優先し、複数の `articleFile` がある場合は重複除去して複数確認する。

```bash
# Step 1: カテゴリに属するarticleFileを確認
rg '"category":"{対象カテゴリslug}"' data/rag/products.jsonl
# Step 2: そのarticleFileでcapacityパターンを確認
rg '"articleFile":"{確認したarticleFile}"' data/rag/capacity-patterns.jsonl
```

表示された行の `articleFile` を確認し、対象記事または同カテゴリの記事の capacity パターン確認に使う。

`data/rag/products.jsonl` または `data/rag/capacity-patterns.jsonl` が存在しない場合、または対象カテゴリの行が見つからない場合は、この手順をスキップして Step 4 へ進む。

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

## Title / Description Rules

検索ニーズの三本柱は「**おすすめ**」「**コスパ**」「**比較**」＋「**年号**」。コスパ・比較だけに偏らせず、`title` / `description` に「**おすすめ**」「**○選**」を必ず含める（GSC分析で「○○ おすすめ」系クエリの取りこぼしが多かったため）。

- `title`（60字以内）: 冒頭を「`{カテゴリ}おすすめ{N}選【{年}】`」とし、続けて差別化KW（除菌 / 単価 / 比較 など）を添える
  - 例: `ウェットティッシュおすすめ10選【2026年】除菌・コスパを1枚単価で比較`
- `description`（160字以内）: 冒頭に「`{カテゴリ}のおすすめ{N}選を…比較`」と結論を出し、スニペットの誘引力を上げる
- `{N}` は `products[]` の実件数と一致させる
- title 変更は OGP 画像へ反映されるため、確定後は `pnpm build` で再生成・検証する

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

### FAQ の扱い（重要）

このサイトの FAQ は **frontmatter の `faqs:` を唯一のソース**にカード表示＋FAQPage JSON-LD を出力する（`ArticleLayout.astro` / `FaqList.astro`）。本文に `## よくある質問（FAQ）` を残したままだと、カード化されずプレーンテキスト表示になり、JSON-LD も目次にも載らない。

手順:

1. まず本文に `## よくある質問（FAQ）` セクションを書く（`**Q. 質問？**` 改行 `A. 回答` 形式。`scripts/lib/faq.ts` がこの書式を抽出する）
2. `pnpm inject-faqs` を実行し、本文 FAQ を `faqs:` frontmatter に反映する
3. **本文の `## よくある質問（FAQ）` セクションは削除**し、frontmatter 一本化する（既存記事と同じ＝本文には FAQ 見出しを残さない）
4. `pnpm inject-faqs --check` が「faqs は最新です」になることを確認する

本文構成（FAQ は inject 後に削除するため、最終的な本文には残らない）:

```markdown
## ○○の選び方ガイド
### [商材に合った観点 2〜4個]

## タイプ別の特徴と使い分け

## コスパ比較のポイント

## よくある質問（FAQ）   ← inject-faqs 実行後に削除（frontmatter faqs へ移す）

## まとめ

---

※ 価格は記事執筆時点の楽天市場での販売価格です。価格は変動する場合があります。
```

## Step 6: CATEGORY_SEARCH_RULES へのルール追加

`scripts/update-products.mjs` の `CATEGORY_SEARCH_RULES` に対象カテゴリのエントリが存在するか確認する。

```bash
rg "'{slug}'" scripts/update-products.mjs
```

**エントリが存在する場合**: スキップして Step 7 へ進む。

**エントリが存在しない場合**: ルールを追加する。ルールがないと `pnpm check-additions` の除外語が汎用のみになり、「○○式」「○○使用」と書かれた周辺機器が候補に混入する。

| フィールド | 決め方 |
|---|---|
| `keywords` | 記事タイトル・商品名から検索クエリを3本抽出（「○○ まとめ買い」「○○ 大容量」等） |
| `include` | 商品本体を特定するカテゴリ語（商品名に必ず現れる語） |
| `exclude` | 周辺機器・アクセサリ・「○○式」「○○使用」など本体でないことを示す語。用途語（「○○用」）も有効 |
| `units` | `capacity` の単位（枚・本・ml・g等）。`category-rules.jsonl` の `units` を参考にする |
| `requiredGroups` | カテゴリの中心語がないと通過させたくない場合のみ追加（例: 電池タイプ語が必須） |

追加後、構文確認:

```bash
node --check scripts/update-products.mjs
```

追加できたら `pnpm check-additions -- --file={slug}-comparison.md --target=10` で候補がカテゴリ意図に合うか確認する。カテゴリ外が残る場合は `kura-check-additions-debug` で精度改善する。

## Step 7: 生成後チェック

可能な範囲で確認する。

```bash
rg "item.rakuten.co.jp" src/content/articles/{slug}-comparison.md
pnpm update-products
pnpm inject-faqs              # 本文FAQ → faqs: frontmatter を生成
# → 生成後、本文の「## よくある質問（FAQ）」セクションを削除する
pnpm inject-faqs --check     # 「faqs は最新です」を確認
pnpm check-additions -- --target=10  # 10商品未満で候補追加したい場合のみ
pnpm test
pnpm build
```

確認観点:

- `rg "item.rakuten.co.jp"` が残る場合は `name` を修正して `pnpm update-products` を再実行
- **FAQ は frontmatter `faqs:` 一本化**。`pnpm inject-faqs` で生成し、本文の `## よくある質問（FAQ）` は削除する（残すとカード化されずプレーンテキスト表示になる）
- `grep -l "## よくある質問" src/content/articles/{slug}-comparison.md` が空（本文FAQ見出しが残っていない）ことを確認
- 初期作成は `draft: true`。`pnpm update-products` / `pnpm build` 後に問題なければ `draft: false` へ変更
- 既存カテゴリ内の派生記事では `getArticleSpecificAdditionRule()` を必ず検討。別サイズ・別形状・別タイプが混ざる場合のみ、`keywords` / `requiredGroups` / `exclude` / `units` を最小限で追加
- `getArticleSpecificAdditionRule()` を追加した場合は `pnpm check-additions -- --file={slug}-comparison.md --target=10` で候補が記事意図に合うか確認
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
