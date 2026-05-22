---
name: kura-product-match-ai
description: KuraSelect の reports/toAI/kura-product-match-ai/product-match-input-*.jsonl をもとに、update-products が自動更新できなかった商品の楽天候補を照合し、reports/ai-matches/pending/ に置ける JSONL を生成するスキル。商品候補の同一性判定、比較記事向けの商品名整形、capacity / pricePerUnit の整合判断を行う。
---

# kura-product-match-ai

KuraSelect の `pnpm update-products` が生成した商品照合候補レポートを読み、AI適用用 JSONL を作る。

## 対象入力

主に以下のファイルを対象にする。

```text
reports/toAI/kura-product-match-ai/product-match-input-*.jsonl
```

ユーザーが入力 JSONL を指定していない場合は、`reports/toAI/kura-product-match-ai/` 直下の `product-match-input-*.jsonl` を対象にする。`done/` 配下は処理済みとして対象外。複数ある場合はファイル名の日付が古いものから順に処理する。

入力 JSONL は各行が独立した商品照合タスク。md 全文は読まない。必要最小限として、各行の `current` / `failure` / `searchKeywords` / `candidates` だけで判断する。

最初に入力件数を確認し、作業後の出力行数と必ず一致させる。

## 出力先

AI判定結果は以下に置く。

```text
reports/ai-matches/pending/product-match-output-YYYY-MM-DD.jsonl
```

次回 `pnpm update-products` 実行時に自動適用される。

検証まで完了した入力 JSONL は以下へ移動する。

```text
reports/toAI/kura-product-match-ai/done/product-match-input-YYYY-MM-DD.jsonl
```

## RAG参照

`data/rag/match-decisions.jsonl` が存在する場合、同一商品（同一 `articleFile` + `rank`、または `currentName` 近似）の過去判定を参照し、action / confidence の傾向を確認する。

`data/rag/category-rules.jsonl` が存在する場合、カテゴリの典型単位・頻出ブランドを参照し、除外語・容量単位の整合判断に使う。

RAGファイルが存在しない場合は従来フローで続行する。

## 判定方針

`current` 商品と `candidates` の中から、同一または実質的に同じ商品を選ぶ。

**判定の最初のステップ: candidates に既存 URL が含まれるか確認する**

`current.rakutenUrl` のショップコード＋商品コード部分と、各 candidate の `directItemUrl` を照合する。一致するものがあれば failure stage によらず高確信で `replace` にできる。

- `failure.stage` が `item-name-mismatch` の場合: 商品は楽天に存在し名前が変わっただけなので、candidates に**必ず**同一 URL の商品が含まれる。見つからない場合は実装バグの疑いがあるため `review` にしてユーザーへ報告する。
- `failure.stage` が `item-get-failed` の場合: 検索経由で同一 URL が candidates に含まれることがある。含まれない場合のみブランド・種別・容量で照合する。

候補が弱い場合は、すぐ `review` にせず、`current.name` から検索用キーワードを段階的に作る。数量・容量つきの商品名は楽天検索で外れやすいため、以下の順に短くする。

1. 元の商品名から数量・容量を除く
   - 例: `ジップロック ストックバッグ L 大容量 32枚入×3箱` → `ジップロック ストックバッグ L 大容量`
   - 例: `ジップロック フリーザーバッグ M 90枚入` → `ジップロック フリーザーバッグ M`
2. それでも候補が弱い場合は、サイズ・容量訴求語も除く
   - 例: `ジップロック ストックバッグ L 大容量` → `ジップロック ストックバッグ`
   - 例: `ジップロック フリーザーバッグ M` → `ジップロック フリーザーバッグ`
3. `searchKeywords` に上記の短縮語がない、または候補がカテゴリ一般語だけで同一ブランド候補がない場合は、候補レポートの再生成を検討する。`scripts/update-products.mjs` 側の `buildProductMatchSearchKeywords` が数量除去・サイズ除去の検索語を出す前提で、再生成後の `candidates` から選ぶ。

AI判定結果に使えるURLは、最終的に JSONL の `candidates` に存在する候補だけ。検索語を推測しても、候補にない URL を作らない。

優先する一致条件:

- ブランド一致
- 商品種別一致
- サイズ一致。ただしサイズを外した検索で見つかった同一シリーズは、商品名・容量からサイズを再確認する
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

**全候補がカテゴリ外になる場合**

candidates が全て対象商品と無関係なカテゴリで埋まっている場合（例: ハンドソープ検索でソープディスペンサー機器のみ、歯間ブラシ検索で歯磨き粉のみ）、`searchKeywords` の生成元である `current.category` フィールドが誤っている可能性がある。`candidates[*].sourceKeyword` と `current.category` を確認し、商品ジャンルと一致しているかを見る。

この場合は `review` にしたうえで、`reason` に「searchKeywords カテゴリズレの疑い: `current.category = "xxx"` が商品内容と不一致」と記載する。作業後にユーザーへ報告する。

確信できない場合は無理に選ばず `review` にする。

同じ `articleFile` + `rank` + `current.name` が複数行に出る場合は注意する。先の行で `replace` すると、後続の同一 rank は dry-run 時に `rank/current.name mismatch` になることがある。重複が見つかったら、原則として最も確信できる1行だけ `replace` にし、残りは `review` にする。

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

Windows PowerShell で日本語入り JSONL を生成する場合は文字化けに注意する。`@' ... '@ | node` のようにパイプで JavaScript を渡すと、環境によって `newName` / `reason` の日本語が `????` になることがある。生成後に UTF-8 と JSON parse を必ず確認し、`?` 連続が混ざっていないことを見る。必要なら事前に以下を設定してから生成する。

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

### replace の形式

```json
{"articleFile":"src/content/articles/storage-bag-comparison.md","rank":1,"current":{"name":"ジップロック ストックバッグ L 大容量 32枚入×3箱"},"action":"replace","selectedItemUrl":"https://item.rakuten.co.jp/...","selectedAffiliateUrl":"https://hb.afl.rakuten.co.jp/...","selectedImageUrl":"https://thumbnail.image.rakuten.co.jp/...","newName":"ジップロック ストックバッグ L 32枚×3箱","newCapacity":"32枚×3箱（96枚）","newPrice":1234,"newPricePerUnit":"約12.9円/枚","newRating":4.5,"newReviewCount":100,"confidence":"high","reason":"ブランド・商品種別・サイズ・総枚数が一致"}
```

### review の形式（人間確認のみ）

候補が弱く人間に確認させたい場合。`decision` は `manual` または省略。

ただし、入力の `current.rakutenUrl` が楽天アフィリエイトURL（`https://hb.afl.rakuten.co.jp/...`）ではない場合、`review/manual` で残してはいけない。同一商品の `affiliateUrl` を candidates から取得できるなら `replace`、取得できないなら `review/delete` にする。

```json
{"articleFile":"src/content/articles/storage-bag-comparison.md","rank":1,"current":{"name":"ジップロック ストックバッグ L 大容量 32枚入×3箱"},"action":"review","decision":"manual","selectedItemUrl":null,"selectedAffiliateUrl":null,"selectedImageUrl":null,"newName":null,"newCapacity":null,"newPrice":null,"newPricePerUnit":null,"newRating":null,"newReviewCount":null,"confidence":"low","reason":"候補がサイズ違いまたは商品種別違いのため確定不可"}
```

### review の形式（削除対象）

既存URLの商品が取得不能で同一商品候補も見つからない場合、または現在の `rakutenUrl` がアフィリエイトURLではなく同一商品の `affiliateUrl` を candidates から取得できない場合。`decision: "delete"` を明示する。

```json
{"articleFile":"src/content/articles/storage-bag-comparison.md","rank":1,"current":{"name":"ジップロック ストックバッグ L 大容量 32枚入×3箱"},"action":"review","decision":"delete","selectedItemUrl":null,"selectedAffiliateUrl":null,"selectedImageUrl":null,"newName":null,"newCapacity":null,"newPrice":null,"newPricePerUnit":null,"newRating":null,"newReviewCount":null,"confidence":"low","reason":"既存URLの商品が取得不能で、同一商品候補も見つからないため削除対象"}
```

`decision: "delete"` の場合の制約:

- `selectedItemUrl` / `selectedAffiliateUrl` / `selectedImageUrl` は必ず `null`
- `rank` と `current.name` は必須（削除対象の特定に使用）
- `update-products` 実行時に記事 MD から自動削除される

## 必須ルール

- `candidates` にない URL を作らない
- 既存候補がカテゴリ一般語だけで同一ブランド候補を含まない場合は、短縮検索語で候補を取り直す前提にする。取り直せない場合は `review`
- `selectedAffiliateUrl` は candidates の `affiliateUrl` を使う
- `selectedItemUrl` は candidates の `itemUrl` を使う
- `selectedImageUrl` は candidates の `imageUrl` を使う
- `articleFile`、`rank`、`current.name` は入力から引き継ぐ
- `replace` 適用時は `rank + current.name` の二重照合が行われるため、`current.name` を省略しない
- 同一 `articleFile` + `rank` が入力内に重複する場合は、後続行が mismatch にならないよう片方を `review` にする
- `action` は `replace` または `review` のみ
- `review` の `decision` は `manual` / `delete` のみ（省略時は `manual` 扱い）
- `decision: "delete"` は既存URLの商品が完全に取得不能かつ同一商品候補がない場合のみ使う
- 入力の `current.rakutenUrl` が `https://hb.afl.rakuten.co.jp/...` ではない場合は、直接URLを残さない。出力は同一商品の `affiliateUrl` を使った `replace`、または `review/delete` のどちらかにする
- `confidence` は `high` / `medium` / `low`
- `replace` は確信がある場合のみ
- 判断根拠は `reason` に短く書く

## 出力後チェック

出力後は最低限以下を確認する。

- 入力行数と出力行数が一致する
- 全行が JSON として parse できる
- `action` が `replace` / `review` のみ
- `replace` 件数と `review` 件数（`manual` / `delete` 内訳）を把握する
- `newName` / `newCapacity` / `newPricePerUnit` / `reason` に `????` などの文字化けがない
- `selectedItemUrl` / `selectedAffiliateUrl` / `selectedImageUrl` は選択した candidate 由来
- 入力の `current.rakutenUrl` がアフィリエイトURLではない行が `review/manual` になっていない
- `replace` 行は、現在の記事 frontmatter にある同じ `rank` の `name` と `current.name` が一致する
- `replace` 行の `selectedItemUrl` / `selectedAffiliateUrl` / `selectedImageUrl` は、同じ入力行の `candidates` に存在する

例:

```bash
node .agents/skills/kura-product-match-ai/scripts/validate-output.mjs reports/toAI/kura-product-match-ai/product-match-input-YYYY-MM-DD.jsonl reports/ai-matches/pending/product-match-output-YYYY-MM-DD.jsonl
```

## 適用確認

出力 JSONL を `reports/ai-matches/pending/` に置いた後は、上記のローカル検証を必須とする。検証が通ったら、入力 JSONL を `reports/toAI/kura-product-match-ai/done/` に移動する。`pnpm update-products:dry` は AI match 適用後に全記事の楽天 API dry-run まで進み、通常の作業ではタイムアウトしやすいため必須にしない。

ユーザーが明示的に希望した場合、またはローカル検証だけでは不安が残る場合のみ dry-run を実行する。

```bash
pnpm update-products:dry
```

dry-run を実行した場合は、AI match 部分で以下を確認する。全記事の楽天 API dry-run の完走は求めない。

- `AI match summary` が `failed 0` になっている
- `rank/current.name mismatch` が出ていない
- `would move to processed` が出ている
- `review skipped` は想定内だが、`replace applied` の対象記事が意図と合っている

問題なければ本実行する。

```bash
pnpm update-products
```
