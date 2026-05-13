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

入力 JSONL は各行が独立した商品照合タスク。md 全文は読まない。必要最小限として、各行の `current` / `failure` / `searchKeywords` / `candidates` だけで判断する。

最初に入力件数を確認し、作業後の出力行数と必ず一致させる。

## 出力先

AI判定結果は以下に置く。

```text
reports/ai-matches/pending/product-match-output-YYYY-MM-DD.jsonl
```

次回 `pnpm update-products` 実行時に自動適用される。

## 判定方針

`current` 商品と `candidates` の中から、同一または実質的に同じ商品を選ぶ。

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

### review の形式

```json
{"articleFile":"src/content/articles/storage-bag-comparison.md","rank":1,"current":{"name":"ジップロック ストックバッグ L 大容量 32枚入×3箱"},"action":"review","selectedItemUrl":null,"selectedAffiliateUrl":null,"selectedImageUrl":null,"newName":null,"newCapacity":null,"newPrice":null,"newPricePerUnit":null,"newRating":null,"newReviewCount":null,"confidence":"low","reason":"候補がサイズ違いまたは商品種別違いのため確定不可"}
```

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
- `confidence` は `high` / `medium` / `low`
- `replace` は確信がある場合のみ
- 判断根拠は `reason` に短く書く

## 出力後チェック

出力後は最低限以下を確認する。

- 入力行数と出力行数が一致する
- 全行が JSON として parse できる
- `action` が `replace` / `review` のみ
- `replace` 件数と `review` 件数を把握する
- `newName` / `newCapacity` / `newPricePerUnit` / `reason` に `????` などの文字化けがない
- `selectedItemUrl` / `selectedAffiliateUrl` / `selectedImageUrl` は選択した candidate 由来

例:

```bash
node -e "const fs=require('fs');const p='reports/ai-matches/pending/product-match-output-YYYY-MM-DD.jsonl';const lines=fs.readFileSync(p,'utf8').trim().split(/\r?\n/);let r=0,v=0;for(const l of lines){const o=JSON.parse(l);if(o.action==='replace')r++;if(o.action==='review')v++;if(/[?]{3,}/.test(o.reason||'')||/[?]{3,}/.test(o.newName||''))throw new Error('mojibake');}console.log('valid jsonl',lines.length,'replace',r,'review',v);"
```

## 適用確認

出力 JSONL を `reports/ai-matches/pending/` に置いた後は、まず dry-run で確認する。

```bash
pnpm update-products:dry
```

dry-run の AI match 部分で以下を確認する。

- `AI match summary` が `failed 0` になっている
- `rank/current.name mismatch` が出ていない
- `would move to processed` が出ている
- `review skipped` は想定内だが、`replace applied` の対象記事が意図と合っている

`pnpm update-products:dry` は AI match 適用後に全記事の楽天 API dry-run まで進むため、時間切れになることがある。その場合でも、AI match 部分で `processed 1, failed 0` と `would move to processed` が確認できていれば、pending JSONL の入口検証としては通っている。

問題なければ本実行する。

```bash
pnpm update-products
```
