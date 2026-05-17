---
name: kura-article-add
description: |
  KuraSelectの既存比較記事（{slug}-comparison.md）に商品エントリを追加・ランキングを拡張するスキル。
  既存記事へのランク追加・件数増加・楽天URLを渡して商品を追記したい場合に使う。
  新規記事をゼロから作る場合は kura-article-create を使う。
---

# KuraSelect 商品追加スキル

既存の `src/content/articles/{slug}-comparison.md` に商品エントリを追加する。

---

## 入力形式

ユーザーから以下を受け取る:
- **対象ファイル**: `src/content/articles/{slug}-comparison.md` のパス
- **追加商品URL**: ランク番号と `item.rakuten.co.jp` URLのペア（1件以上）
- または **追加候補レポート/JSONL**: `reports/addition-urls-*.md`、`reports/addition-candidates-*.md`、またはそれを加工したJSONLの商品候補

---

## Step 1: 既存ファイルの確認

対象ファイルを Read して以下を把握する:

| 確認項目 | 目的 |
|---------|------|
| `products[]` の現在の件数・最後の `rank` 番号 | 追加する rank の起点を決める |
| `title` の文字列 | 「N選」「おすすめN選」等の件数表記があれば更新対象 |
| `description` の文字列 | 件数に言及していれば更新対象 |
| `updatedAt` | 今日の日付に更新する |

---

## Step 2: 各URLをWebFetchして商品情報を取得

追加商品URLを順に WebFetch し、各商品について確定する:

| 取得項目 | フィールド |
|---------|-----------|
| 正式商品名（楽天ページ上の表記） | `name` |
| ブランド名 | `brand` |
| 容量・枚数・個数（セット構成含む） | `capacity` |
| 商品説明・特徴テキスト | `features` / `pros` / `cons` / `recommendedFor` の生成元 |

> `name` と `capacity` はスクリプトで上書きされない。推測せず必ずWebFetchで確認すること。

---

## Step 3: カテゴリ適合チェック

追加候補が対象記事カテゴリの商品本体か確認する。

- 明らかにカテゴリ外の商品は追加しない
- 関連アクセサリ・収納用品・詰め替え容器・本体ではない周辺用品はカテゴリ外として扱う
- 近接カテゴリの商品（例: 洗顔料、ハンドソープ、シャンプー等）は、対象記事の主用途と違えばカテゴリ外として扱う
- 判断が微妙な場合、またはユーザーが明示した候補を除外する場合は、編集前にユーザーへ確認する

確認文の例:

```text
候補Xはボディソープ本体ではなく詰め替えボトルのため、カテゴリ外に見えます。追加しますか？除外しますか？
```

ユーザーが除外を選んだ商品は追加せず、残りの商品だけで `rank` を連番にする。

### check-additions 由来候補でカテゴリ外を検知した場合

入力元が `pnpm check-additions` の出力、`reports/addition-urls-*.md`、`reports/addition-candidates-*.md`、またはそれを加工したJSONLの場合、カテゴリ外商品は単に除外して終わらせない。

以下を控える:

- 対象記事ファイル
- 期待カテゴリ（記事frontmatterの `category`）
- カテゴリ外と判断した商品名
- URL
- カテゴリ外と判断した理由
- レポート上の診断行（確認できる場合）

そのうえで、記事への追加作業はカテゴリ適合商品のみに限定して進める。カテゴリ外候補が `check-additions` の候補生成精度に起因すると見える場合は、`kura-check-additions-debug` を使って `check-additions` の精度改善へ進む。

以下の場合は `kura-check-additions-debug` を使わず、通常のカテゴリ適合チェックとして扱う:

- ユーザーが手入力した楽天URL
- ユーザーが明示的に「この商品を追加」と指定したURL
- カテゴリ境界が曖昧で、記事側に入れるべきか判断が割れる商品
- 入力元が `check-additions` 由来か判断できない候補

---

## Step 4: `name` フィールドの正規化

`update-products.mjs` は `name` をそのまま楽天API検索キーワードとして使う。以下のルールを厳守:

- **メーカー名プレフィックスを除く** → 「花王 マジックリン」→「マジックリン」
- **`&` と `・`（中点）を含めない**
- **容量除去後に英字1文字（L/M/S）が末尾に残らないようにする**
- 全角スペースや記号が含まれている場合は半角に正規化する

---

## Step 5: `products[]` に新エントリを追加

以下テンプレートで既存 `products[]` の末尾に追加する。

**フィールド制約**:

| フィールド | 制約 |
|-----------|------|
| `rank` | 既存の最後の rank + 1 から連番 |
| `price` | `0`（update-products で更新） |
| `pricePerUnit` | `"0円/単位"` — **単位はカテゴリに合わせる**（例: 個、枚、ml、g、回） |
| `rating` | `0`（update-products で更新） |
| `reviewCount` | `0`（update-products で更新） |
| `rakutenUrl` | 入力の `item.rakuten.co.jp` URL をそのまま使用 |
| `imageUrl` | `""` （update-products で更新） |
| `features` | 3件 |
| `pros` | 3件 |
| `cons` | 2件 |

**YAMLテンプレート**（インデントは既存エントリに合わせる）:

```yaml
  - rank: N
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
```

### `features` / `pros` / `cons` 作成ルール

- `features` / `pros` / `cons` / `recommendedFor` には、価格・容量・個数・本数・枚数・単価・レビュー件数・ランキング順位など、更新で変わりうる具体的な数字を書かない
- 数値情報は `price` / `capacity` / `pricePerUnit` / `rating` / `reviewCount` の各フィールドに閉じ込める
- 「安い」「大容量」「高評価」など、数値更新で崩れやすい表現は避ける。使う場合は「比較的」「選びやすい」など断定しない表現にする
- `features` は商品ページで確認できる仕様・設計・素材・タイプなどの客観情報を書く
- `pros` は購入者にとっての使いやすさ・選びやすさ・向いている用途を書く
- `cons` は欠点を煽らず、合わない用途・注意点・好みが分かれる点として書く
- 各項目は重複させず、1行1観点にする
- 薬機法・景表法に触れやすい効果効能の断定、「最安」「No.1」など根拠が必要な断定は避ける

**役割の目安**:

- `features`: 客観的な商品特徴、タイプや使用感の方向性、仕様・設計上の違い
- `pros`: 日常シーンでの便利さ、選びやすいユーザー像、他候補と比べた実用面の良さ
- `cons`: 好みが分かれる点、向かない使い方、購入前に確認したい点

---

## Step 6: `title` / `description` / `updatedAt` の更新

- **title**: 「○選」「おすすめ○選」など件数表記があれば新しい件数に更新（最大60文字）
- **description**: 件数に言及していれば更新（最大160文字）
- **updatedAt**: 今日の日付（`YYYY-MM-DD` 形式）に更新

---

## Step 7: 完了後の案内

作業完了後、ユーザーに以下をそのまま伝える:

```
追加完了。次の手順:
1. pnpm update-products  （price / rating / rakutenUrl / imageUrl を楽天APIで更新）
2. grep -r "item.rakuten.co.jp" src/content/articles/{slug}-comparison.md
   → 残っている場合は name を修正して再実行
3. pnpm build  （Zodスキーマ検証 + OGP生成）
4. git add / commit / push
```

カテゴリ外候補を除外した場合は、完了報告に以下も含める:

- 追加しなかった商品
- 除外理由
- `check-additions` 由来なら、精度改善へ進んだかどうか
- `kura-check-additions-debug` を使った場合は、その原因分類・修正内容・再生成後の候補状態
