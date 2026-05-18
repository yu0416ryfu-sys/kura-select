# update-yahoo-products.mjs 使い方ガイド

Yahoo!ショッピング（ValueCommerce 経由）の商品リンク・価格情報を記事の frontmatter に追加・更新するスクリプトです。

---

## 基本コマンド

| コマンド | 内容 |
|---|---|
| `pnpm update-yahoo-products:dry` | 全記事の dry-run（ファイル書き込みなし） |
| `pnpm update-yahoo-products` | 全記事に Yahoo offer を write（実際に書き込む） |

デフォルトは dry-run（`--write` を明示しない限りファイルは変更されません）。

---

## オプション一覧

```bash
# 特定の記事だけ対象にする
pnpm update-yahoo-products:dry -- --article=toilet-paper-comparison

# 特定の記事に write する
pnpm update-yahoo-products -- --write --article=toilet-paper-comparison

# 処理件数の上限を設定する（記事単位ではなく商品単位）
pnpm update-yahoo-products:dry -- --limit=3

# API 呼び出し間隔を変更する（ミリ秒、デフォルト: 1000）
pnpm update-yahoo-products -- --write --article=shampoo-comparison --api-interval=2000

# 組み合わせ例
pnpm update-yahoo-products -- --write --article=toilet-paper-comparison --api-interval=1500
```

---

## 必要な環境変数（.env）

```env
YAHOO_SHOPPING_APP_ID=your_yahoo_app_id
VALUECOMMERCE_SID=your_valuecommerce_sid
VALUECOMMERCE_PID=your_valuecommerce_pid_for_yahoo_shopping
```

- `YAHOO_SHOPPING_APP_ID`: Yahoo! デベロッパーネットワークで取得した Application ID
- `VALUECOMMERCE_SID`: ValueCommerce のサイト ID
- `VALUECOMMERCE_PID`: ValueCommerce の Yahoo!ショッピング プログラム ID（**プログラムごとに異なる**）

---

## 推奨ワークフロー

### 1. dry-run で候補を確認する

```bash
pnpm update-yahoo-products:dry -- --article=<slug>
```

`reports/yahoo-products-dry-run-<日時>.md` にレポートが出力されます。

### 2. レポートを確認する

各商品に対して以下のどちらかが記録されます：

- `decision: auto` — 商品名が一致した候補が見つかった
- `decision: review` — 候補が見つからなかった（手動対応が必要）

`auto` の候補は必ず **商品名・ブランドが一致しているか目視確認**してください。

よくある誤マッチのパターン：
- 汎用語（「シングル」「詰め替え」など）だけで一致している
- 同ブランドの別 SKU・容量違いが選ばれている
- 別ブランドの類似商品が選ばれている

### 3. write する

確認 OK の記事だけ write します。

```bash
pnpm update-yahoo-products -- --write --article=<slug>
```

`reports/yahoo-products-write-<日時>.md` に結果が出力されます。

### 4. ビルドで検証する

```bash
PUBLIC_ENABLE_YAHOO_AFFILIATE=true PUBLIC_NOINDEX=true pnpm build
pnpm preview
```

ブラウザで該当記事を開き、Yahoo! ボタンを押して **正しい商品ページに飛ぶか**確認します。

### 5. 問題があれば frontmatter を手動修正する

誤マッチが見つかった場合は、記事の `offers` ブロックを直接削除します：

```yaml
# この blocks を削除する
offers:
  - provider: "yahoo"
    label: "Yahoo!"
    price: 1234
    url: "https://ck.jp.ap.valuecommerce.com/..."
    ...
```

### 6. コミットする

```bash
git add src/content/articles/<slug>.md
git commit -m "Yahoo offer追加: <記事名>"
```

---

## レポートの読み方

```
## toilet-paper-comparison.md
### rank 0: 商品名
- query: 検索キーワード
- decision: auto          ← 自動マッチ成功
- candidate: Yahooでヒットした商品名
- price: 3500
- url: https://ck.jp.ap.valuecommerce.com/...

### rank 0: 別の商品名
- query: 検索キーワード
- decision: review        ← 候補なし（手動対応が必要）
- candidates: 0
```

> **注意**: レポートの `rank` はすべて `0` と表示されますが、実際の write 処理には影響しません（既知の表示上の問題）。

---

## マッチング精度について

スクリプトは以下のロジックで商品名の一致を判定します：

1. **最初のトークン（ブランド名相当）が候補に含まれること**（必須）
2. **全トークンの うち2つ以上が候補に含まれること**

ブランド名が英語表記（`Comfy`）と日本語表記（`コンフィ`）で異なる場合など、マッチングが失敗して `review` になることがあります。その場合は手動で Yahoo!ショッピングから該当商品を検索して URL を frontmatter に直接入力してください。

---

## GitHub Actions（staging）

`yahoo-affiliate` または `staging` ブランチで `Yahoo商品データ検証更新（staging）` workflow を手動実行することで CI 上でも dry-run / write が可能です。

```
write: false
article: toilet-paper-comparison
```

詳細は `docs/YAHOO_AFFILIATE_STAGING.md` を参照してください。
