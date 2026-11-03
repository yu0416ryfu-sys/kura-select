---
name: kura-article-create
description: |
  KuraSelectの比較記事（{slug}-comparison.md）を楽天URLからゼロから新規生成するスキル。
  新しいカテゴリや商品ジャンルの比較記事を作りたい・楽天URLを渡して記事ファイルを生成したい場合に使う。
  既存記事への商品追加は kura-article-add を使う。
---

# KuraSelect 新規記事生成スキル

楽天URLから `src/content/articles/{slug}-comparison.md` を新規作成する。

**目的は次の順に優先する。** ①検索してきた読者が買う前の迷いを解消し、比較表から納得して選べること ②他の比較サイトや楽天の商品ページに無い情報があること ③公開後に登録され、2週で順位帯が立つこと。

本文は決まった構成に当てはめず、**根拠のある疑問リストを設計図にして書く**。商品ページ・レビュー・一次情報の収集と事実の照合は `references/article-research.md`（共通手順）に従い、サブエージェントに任せる。本体のトークンは「読まない」ではなく「委譲する」で節約する。

## 入力

- 必須: `slug` / 記事テーマ / カテゴリslugまたは `新規: slug|日本語名|説明文|絵文字` / 楽天商品URL
- 任意: 比較単位（枚、本,mL,g,回など）/ 想定読者 / 除外したい商品タイプ / `kura-article-recommend` の提案（選んだ根拠のクエリ）
- 楽天URLは最低4件推奨。10件を超える場合は、初期記事では上位10件までにする
- `docs/CONTENT_IMPROVEMENT_CATALOG.md` を読む（T1〜T9 の書き方・禁止・不採用の型）。無ければ止まってユーザーに伝える（`docs/` は gitignore 済みで、別 PC には無いことがある）

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

## Step 2: 検索データを取る（兄弟記事との重なりと疑問リスト）

新規記事にはまだクエリが無いので、サイト全体に来ているクエリからテーマの疑問を拾う。

1. 確定日を `gsc_search_analytics`（`dimensions:["date"]`・直近10日）で実測する
2. GSC を `dimensions:["query","page"]`・`rowLimit: 5000`・取れる全期間（`startDate` は16か月前、終端は確定日）で取り、テーマ語（カテゴリ名・表記ゆれ・主要ブランド・用途語）を含むクエリを抜き出す。匿名化で一部しか返らないので「無い＝需要が無い」とは書かない
3. Bing を `bing_query_stats`（`sortBy: "Impressions"`・`rowLimit: 1000`）で取り、同じテーマ語で絞ってクエリごとに足す
4. 入力に `kura-article-recommend` の根拠があれば足す

### 2-1. 兄弟記事との重なり

- 2 で拾ったクエリが着地している既存記事と、同カテゴリ・近接カテゴリの記事の title を見る
- 入力の商品が既存記事の `products[]` と重ならないかを `pc=` をデコードした `item.rakuten.co.jp/{shopCode}/{itemCode}` で突き合わせる
- 同じ読者・同じ疑問を既存記事が受けているなら、作る前にユーザーに確認する（受け皿が割れると両方が登録されにくい）。作るなら「この記事だけの判断軸」を1行で決め、本文はそれに沿わせる

### 2-2. 疑問リスト

拾ったクエリを読者の疑問に束ね、表示の多い順に並べる。各項目に根拠（クエリと表示数、または出典の URL）を付ける。これが本文と FAQ の設計図になる。

- クエリが少ないテーマは、Step 3 で集める購入者レビューとメーカー・公的機関の Q&A から疑問を足してよい（根拠の欄にそう書く）
- **推測だけの疑問は入れない**
- 根拠つきの疑問が3つ未満なら、記事化の前にユーザーに伝えて判断を待つ

## Step 3: 商品・口コミ・一次情報を集める

`references/article-research.md` の §1〜§2 に従い、サブエージェント（sonnet）に収集させる。依頼文は同ファイル §6 の雛形を使う。

- 全商品について、商品名・ブランド・容量とセット構成・商品区分・成分・使用方法・使えない条件を集める
- 口コミは星1〜3と星5の傾向。一次情報は疑問リストの答えに要る事実を優先する
- 価格・rating・reviewCount・imageUrl・affiliateUrl は集めない（`pnpm update-products` に任せる）
- 結果はスクラッチパッドの `research-<slug>.md`。本体は要約を受け取り、書く段で必要な節だけを読む

> `name` と `capacity` は初期品質に直結する。推測せず、収集ファイルの原文で確定する。

## Step 4: カテゴリ適合チェック

各URLが記事テーマの「商品本体」か確認する。

- 明らかなカテゴリ外商品は追加しない
- 関連アクセサリ、収納用品、詰め替え容器、交換部品のみの商品は原則除外
- 近接カテゴリの商品は、主用途が違えば除外
- 用途・年齢層の違う商品を1つのランキングに混ぜない（メモリ `feedback_no_mixed_use_rankings`）
- 判断が微妙、またはユーザー指定URLを除外する場合は編集前に確認する

## RAG参照

`data/rag/capacity-patterns.jsonl` が存在する場合、対象カテゴリの既存 capacity 表記パターンを確認し、Step 5 の正規化で一貫した形式を使う。

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

`data/rag/products.jsonl` または `data/rag/capacity-patterns.jsonl` が存在しない場合、または対象カテゴリの行が見つからない場合は、この手順をスキップして Step 5 へ進む。

## Step 5: `name` / `capacity` 正規化

`update-products.mjs` は `name` を検索キーワードに使うため、短く比較表向けに整える。

- `name` は60文字以内目安
- メーカー名プレフィックスを除く。ただし商品理解に必要なブランドは残す
- 送料無料、最安、ランキング、ショップ名、広告文、記号過多を除く
- `&` と `・`（中点）を含めない
- 容量除去後に英字1文字（L/M/S）が末尾に残らないようにする
- 全角スペース・記号は半角に寄せる
- 同じ記事の他の商品と同じ名前にしない
- `capacity` は `calcPricePerUnit` が解釈しやすい短い表記にする
  - 例: `30枚×3個（90枚）`, `400mL×3袋`, `12ロール`, `10本`

## Step 6: 記事ファイル生成

既存記事全文は大量に読まない。書式の確認が要る場合は、`kura-index-recover` で加筆した記事（`docs/CONTENT_IMPROVEMENT_LOG.md` §6 の行）か、同カテゴリの記事を1本だけ読む。

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

### Title / Description Rules

検索ニーズの三本柱は「**おすすめ**」「**コスパ**」「**比較**」＋「**年号**」。コスパ・比較だけに偏らせず、`title` / `description` に「**おすすめ**」「**○選**」を必ず含める（GSC分析で「○○ おすすめ」系クエリの取りこぼしが多かったため）。

- `title`（60字以内）: 冒頭を「`{カテゴリ}おすすめ{N}選【{年}】`」とし、続けて差別化KW（除菌 / 単価 / 比較 など）を添える。差別化KWは疑問リストの上位から選ぶ
  - 例: `ウェットティッシュおすすめ10選【2026年】除菌・コスパを1枚単価で比較`
- `description`（160字以内）: 冒頭に「`{カテゴリ}のおすすめ{N}選を…比較`」と結論を出し、スニペットの誘引力を上げる
- `{N}` は `products[]` の実件数と一致させる
- title 変更は OGP 画像へ反映されるため、確定後は `pnpm build` で再生成・検証する

### Product Copy Rules

- 書く事実は収集ファイルにあるものだけにする。商品ページで確かめられない仕様は書かない
- **隣の商品との違いが出るように書く。** 全商品を並べて見比べ、どの商品にも当てはまる文（「毎日使いやすい」「コスパが良い」）は書かない。完全同一の `features` / `pros` / `cons` を複数商品に並べない
- `features` / `pros` / `cons` / `recommendedFor` に、価格・容量・個数・本数・枚数・単価・レビュー件数・ランキング順位など更新で変わる数字を書かない
- 数値情報は `price` / `capacity` / `pricePerUnit` / `rating` / `reviewCount` に閉じ込める
- 「安い」「大容量」「高評価」など更新で崩れやすい表現は避ける
- `features`: 商品ページで確認できる仕様・設計・素材・タイプ・区分
- `pros`: 使いやすさ、選びやすい用途、ユーザー像（レビューの傾向を根拠にしてよい）
- `cons`: 合わない用途、使えない条件、好みが分かれる点（使用方法・注意書きとレビューの傾向から）
- 薬機法・景表法に触れやすい効果効能の断定、「最安」「No.1」など根拠が必要な断定は避ける

### Body Rules

**本文の H2 は疑問リスト（Step 2-2）の項目に対応させる。** 対応しない H2 は足さない。文字数の目標は置かない。

- 兄弟記事と同じ説明を繰り返さず、Step 2-1 で決めた「この記事だけの判断軸」に沿って書く
- 次のうち、そのジャンルで判断に効くものを入れる: 自作の計算表や換算（1回量・使い切り日数など。単価は書かない）／複数メーカーの表示を並べた比較／購入者レビューの傾向（`references/article-research.md` §3 の書き方）／原因の切り分け表や図
- 上部比較表の列をどう読み分けるかの節（カタログ T5）は、比較表だけでは選びにくいジャンルで入れる
- 図解は判断が速くなるものだけ、最大3枚。書き方はカタログ T6
- カタログ T1〜T9 の書き方・禁止を守る。**不採用の型（「この記事が向いていない人」節・図解と重なる用途別の早見表）を書かない**
- **定型H2（「○○の選び方ガイド」「タイプ別の特徴と使い分け」「コスパ比較のポイント」）を使わない。** 全記事同型の見出しは AdSense「有用性の低いコンテンツ」の不合格要因で、2026-09 に既存記事から順次撤去した。見出しは疑問に答える形か記事固有の判断軸にする（例:「どの容量を買うかを『使い切れる量』から逆算する」）
- 本文に書く商品・ブランド名は `products[]` に実在するものだけにする（存在しない銘柄への言及は区分C の誤表示として後で是正対象になる）
- 本文の太字は、閉じる `**` の直前が約物なら `<strong>`（メモリ `feedback_markdown_bold_cjk`）

**数値の真実は frontmatter `products[]` の1か所だけ**で、比較・ランキング・単価は frontmatter から生成される上部比較表（`ComparisonTable`、単価は `calcPricePerUnit` で表示時再計算）に委ねる。

- 価格、レビュー件数、ランキング順位、年間コスト、特定商品の単価を本文に固定しない
- **価格・単価を並べた手書き表（`| … 円 |` / `円/mL` 等のテーブル）を本文に作らない**。具体数値が要るときは「ページ上部の比較表（自動更新）でご確認ください」と誘導する
- frontmatter の `faqs[].answer` にも商品別の固定数値（`約0.67円/mL` 等）を書かない。定性表現（「業務用大容量タイプほど単価が安い傾向」）にする
- 許容: 「30〜50% 安くなる傾向」「未開封で約3年」など特定商品に紐づかない一般目安、比較日・対象範囲・出典を伴う断定（景表法対応）
- 検収: 本文・`faqs[].answer` に `scripts/lib/article-body-lint.ts` が検出する禁止数値（手書き価格表・`円/単位`・商品価格）が無いこと。`pnpm test`（`tests/article-body-lint.test.ts`）で自動チェックされる

### FAQ の扱い（重要・新規記事は inject-faqs 必須）

このサイトの FAQ は **frontmatter の `faqs:` を唯一のソース**にカード表示＋FAQPage JSON-LD を出力する（`ArticleLayout.astro` / `FaqList.astro`）。本文に `## よくある質問（FAQ）` を残したままだと、カード化されずプレーンテキスト表示になり、JSON-LD も目次にも載らない。

- FAQ は3〜5問。疑問リストのうち、H2 にするほどではない短い疑問から選ぶ。医薬品的な効果効能、過度な断定、根拠のない推奨を避ける

手順:

1. まず本文に `## よくある質問（FAQ）` セクションを書く（`**Q. 質問？**` 改行 `A. 回答` 形式。`scripts/lib/faq.ts` がこの書式を抽出する）
2. `pnpm inject-faqs` を実行し、本文 FAQ を `faqs:` frontmatter に反映する
3. **本文の `## よくある質問（FAQ）` セクションは削除**し、frontmatter 一本化する（既存記事と同じ＝本文には FAQ 見出しを残さない）
4. `pnpm inject-faqs --check` が「faqs は最新です」になることを確認する
5. `pnpm content:stamp` を実行し、新しい記事を台帳 `data/content-dates.json` に載せて記事と同じコミットに入れる（載せ忘れると `pnpm test` の `tests/content-stamp.test.ts` が落ちる）

本文の骨組み（FAQ は inject 後に削除するため、最終的な本文には残らない）:

```markdown
## この記事で比べた〇〇の範囲（任意。比べた商品の範囲と、比べていないもの）

## [疑問リストの項目1に答える見出し]
### [答えに要る観点]

## [疑問リストの項目2に答える見出し]

（疑問リストの項目数だけ続ける。計算表・表示の比較・図解・比較表の読み分けは、答えに要る節の中に置く）

## 買ったあとに多い失敗（購入者レビューから）（レビューを集めた場合）

## よくある質問（FAQ）   ← inject-faqs 実行後に削除（frontmatter faqs へ移す）

## まとめ

---

※ 価格は記事執筆時点の楽天市場での販売価格です。価格は変動する場合があります。
```

関連記事への導線は、本文中の文脈の通る箇所に2〜4本置く（見出しは任意）。

## Step 7: CATEGORY_SEARCH_RULES へのルール追加

`scripts/update-products.mjs` の `CATEGORY_SEARCH_RULES` に対象カテゴリのエントリが存在するか確認する。

```bash
rg "'{slug}'" scripts/update-products.mjs
```

**エントリが存在する場合**: スキップして Step 8 へ進む。

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

## Step 8: 事実の照合

`references/article-research.md` §4 に従い、**本文を書いていない別のサブエージェント**（sonnet 以上）に、記事全体を収集ファイルと出典に照らして確かめさせる。商品に関する記述、数値と計算、薬機法に触れる表現を優先する。指摘を本体が直す。

## Step 9: 生成後チェック

`pnpm update-products` / `pnpm test` / `pnpm build` の実行と出力の確認はサブエージェント（haiku か sonnet）に任せ、要点だけ報告させてよい。

```bash
rg "item.rakuten.co.jp" src/content/articles/{slug}-comparison.md
pnpm update-products
pnpm inject-faqs              # 本文FAQ → faqs: frontmatter を生成
# → 生成後、本文の「## よくある質問（FAQ）」セクションを削除する
pnpm inject-faqs --check     # 「faqs は最新です」を確認
pnpm check-additions -- --target=10  # 10商品未満で候補追加したい場合のみ
pnpm content:stamp
pnpm test
pnpm build
```

確認観点:

- `rg "item.rakuten.co.jp"` が残る場合は `name` を修正して `pnpm update-products` を再実行
- **FAQ は frontmatter `faqs:` 一本化**。`pnpm inject-faqs` で生成し、本文の `## よくある質問（FAQ）` は削除する（残すとカード化されずプレーンテキスト表示になる）
- `grep -l "## よくある質問" src/content/articles/{slug}-comparison.md` が空（本文FAQ見出しが残っていない）ことを確認
- 初期作成は `draft: true`。`pnpm update-products` / `pnpm build` 後に問題なければ `draft: false` へ変更
- **表示の確認**: `draft: false` にしてから `pnpm build` → `pnpm preview` を開き、localhost で幅 375px の表示（図・表のあふれ、目次、FAQ カード）を確かめる。本番は開かない（`draft: true` のままだとビルドから外れて確認できない）
- 既存カテゴリ内の派生記事では `getArticleSpecificAdditionRule()` を必ず検討。別サイズ・別形状・別タイプが混ざる場合のみ、`keywords` / `requiredGroups` / `exclude` / `units` を最小限で追加
- `getArticleSpecificAdditionRule()` を追加した場合は `pnpm check-additions -- --file={slug}-comparison.md --target=10` で候補が記事意図に合うか確認
- `pnpm update-products` 後は `reports/` と `reports/toAI/` に要確認ファイルが出ていないか確認
- category slug が実在する
- title 60文字以内、description 160文字以内
- `products[].rank` が連番
- `features` / `pros` / `cons` が商品間で完全重複していない
- 本文に更新で壊れる価格・レビュー件数・年間コストが残っていない
- 定型H2（選び方ガイド／タイプ別の特徴と使い分け／コスパ比較のポイント）と不採用の型（「この記事が向いていない人」）が本文に無い
- すべての H2 が疑問リストのどれかに対応している（まとめ・範囲・レビューの節を除く）
- **内部リンク**: 新記事の本文から関連記事へ2〜4本、かつ**既存記事から新記事へ最低1本**張る（被リンク0の孤立ページは表示すら立たない。deodorizing-bag は内部リンク0本でクロールが3週間止まり未離陸だった）。`pnpm check-internal-links` で孤立していないことを確認する
- **リンク元の記事は、凍結中でない（`data/measurement-holds.json`）・noindex でない（`data/noindex-articles.json`）・`docs/TODO.md` で止められていない・進行中の計画書の測定対象でない記事に限る**。凍結記事の本文を触らなくても、被リンクを足せばその記事の測定条件が変わる（2026-09 に凍結中の wet-tissue / floor-cleaner へ張ってしまい差し替えた）

## 公開後

- **公開した日に `data/measurement-holds.json` とメモリ `project_measurement_holds` の両方へ記帳する**（起点日＝公開日・解除日・指標・`searchNeed`。`releaseDate` は解除日の翌日）。`searchNeed` には疑問リストの上位を書く。kireikirei-vs-biore は記帳漏れで遡及登録になった
- **判定は公開2週後の順位帯で行う。** インデックス3〜5日・順位帯は約2週で確定し以後ほぼ動かない（「2〜3ヶ月かかる」は誤り）。クリック実数が一桁なら CTR ではなく順位帯で見る
- 一般名詞の新規カテゴリ記事は表示が立ちにくい。指名クエリの受け皿が実測できているジャンル（vs 記事の採択基準は `kura-article-recommend` 参照）のほうが打率が高い

## 作業の分担

`references/article-research.md` §5 の表に従う。**どの担当にも同ファイル §1 を伝える**（本番を開かない／アフィリエイトリンクを踏まない／楽天を WebFetch で読まない）。疑問リスト・構成・本文・図解・商品説明は本体が書く。

## 完了案内

生成完了後、疑問リスト（根拠つき）と H2 の対応、事実照合で直した点、実行済みコマンドと未実行コマンドを短く伝える。

```text
生成完了。次の確認:
1. pnpm update-products  （price / rating / rakutenUrl / imageUrl を更新）
2. rg "item.rakuten.co.jp" src/content/articles/{slug}-comparison.md
   → 残っている場合は name を修正して再実行
3. reports/ と reports/toAI/ の要確認ファイルを確認
4. 10商品未満なら pnpm check-additions -- --target=10 を検討
5. pnpm test
6. pnpm build
7. 問題なければ draft: false にして localhost で 375px 表示を確認し、git add / commit / push
8. 公開した日に凍結台帳（JSON とメモリ）へ記帳
```
