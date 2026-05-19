# アフィリエイト商品更新パイプライン再設計 実装計画

対象: KuraSelect の楽天 / Yahoo!ショッピング / 将来Amazon対応を見据えた商品更新処理

目的: モール別の商品更新、同一商品チェック、容量チェック、最安値判定、ランキング整理を分離し、Yahoo・Amazon追加後も壊れにくい更新パイプラインにする。

## 1. 結論

今後Amazonアフィリエイトも追加する前提では、処理を以下の責務に分離する。

```text
update-products          楽天商品の更新
update-yahoo-products    Yahoo offer の更新
update-amazon-products   Amazon offer の更新（将来）
reconcile-offers         モール横断の同一商品・容量・stale判定
rank-products            コスパ順並び替え・rank整理
```

理由:

- 楽天更新スクリプトにYahoo/Amazonの整合処理を混ぜると責務が肥大化する。
- 各モールAPIの仕様差分を個別スクリプトに閉じ込められる。
- 同一商品チェック・容量チェックを共通化できる。
- Amazon追加時に `reconcile-offers` と表示側を拡張するだけで済む。
- 最安値判定を楽天更新処理から切り離せる。

## 2. 現状の課題

現状の `scripts/update-products.mjs` は楽天商品更新だけでなく、以下も担当している。

- 楽天価格・評価・レビュー数・URL・画像更新
- capacity 抽出・補正
- pricePerUnit 再計算
- コスパ順並び替え
- rank 11位以下削除
- title / description の件数同期
- 検索0件商品の削除
- AI商品照合候補生成・適用
- 削除履歴記録

Yahoo/Amazon対応までここへ混ぜると、次の問題が起きる。

- 楽天更新の失敗が全モールの表示に影響する。
- 商品差し替え時に旧Yahoo/Amazon offerが残りやすい。
- 容量変更時にモール間の同一性が崩れる。
- テスト対象が巨大化し、バグ原因を切り分けにくい。
- Amazon追加時に `update-products.mjs` がさらに肥大化する。

## 3. 目標アーキテクチャ

### 3.1 全体フロー

```text
記事frontmatter
  ↓
update-products
  楽天の基準商品を更新
  ↓
update-yahoo-products
  Yahoo offer を取得・更新
  ↓
update-amazon-products
  Amazon offer を取得・更新（将来）
  ↓
reconcile-offers
  同一商品チェック
  容量チェック
  stale offer無効化
  provider別価格の正規化
  ↓
rank-products
  pricePerUnit順に並び替え
  rank振り直し
  rank上限削除
  title/description件数同期
  ↓
pnpm build
```

### 3.2 推奨コマンド

```bash
pnpm update-products
pnpm update-yahoo-products
pnpm reconcile-offers
pnpm rank-products
pnpm build
```

Amazon追加後:

```bash
pnpm update-products
pnpm update-yahoo-products
pnpm update-amazon-products
pnpm reconcile-offers
pnpm rank-products
pnpm build
```

検証用:

```bash
pnpm update-products:dry
pnpm update-yahoo-products:dry
pnpm reconcile-offers:dry
pnpm rank-products:dry
pnpm test
pnpm build
```

## 4. データモデル

### 4.1 基準商品

`products[]` の直下フィールドは、当面「楽天基準商品」として残す。

```yaml
products:
  - rank: 1
    name: "商品名"
    brand: "ブランド"
    price: 5300
    capacity: "100m×60ロール"
    pricePerUnit: "約0.88円/m"
    rakutenUrl: "https://hb.afl.rakuten.co.jp/..."
    imageUrl: "https://thumbnail.image.rakuten.co.jp/..."
```

理由:

- 既存記事と既存スクリプトへの影響を抑える。
- 楽天を基準商品として、Yahoo/Amazonは同一商品の購入先候補として扱う。
- いきなり全記事を `offers[]` 完全移行しない。

### 4.2 offers

販売元別の購入候補は `offers[]` に集約する。

```yaml
offers:
  - provider: "rakuten"
    label: "楽天市場"
    price: 5300
    url: "https://hb.afl.rakuten.co.jp/..."
    imageUrl: "https://thumbnail.image.rakuten.co.jp/..."
    available: true
    updatedAt: "2026-05-18"
    matchStatus: "matched"
    matchConfidence: "high"
    matchedCapacity: "100m×60ロール"
    matchNotes: "基準楽天商品"
  - provider: "yahoo"
    label: "Yahoo!"
    price: 5350
    url: "https://ck.jp.ap.valuecommerce.com/..."
    imageUrl: "https://item-shopping.c.yimg.jp/..."
    available: true
    updatedAt: "2026-05-18"
    matchStatus: "matched"
    matchConfidence: "high"
    matchedCapacity: "100m×60ロール"
    matchNotes: "容量合計と主要商品名が一致"
```

Amazon追加時:

```yaml
  - provider: "amazon"
    label: "Amazon"
    price: 5400
    url: "https://www.amazon.co.jp/..."
    imageUrl: "https://m.media-amazon.com/..."
    available: true
    updatedAt: "2026-06-01"
    matchStatus: "matched"
    matchConfidence: "high"
    matchedCapacity: "100m×60ロール"
```

### 4.3 provider

`src/content.config.ts` と `src/lib/offers.ts` の provider は段階的に拡張する。

初期:

```ts
provider: z.enum(["rakuten", "yahoo"])
```

Amazon追加時:

```ts
provider: z.enum(["rakuten", "yahoo", "amazon"])
```

## 5. 各スクリプトの責務

### 5.1 update-products

対象: `scripts/update-products.mjs`

責務:

- 楽天基準商品の更新
- 楽天価格更新
- 楽天評価・レビュー数更新
- 楽天URL・画像更新
- 楽天商品名からの capacity 候補抽出
- pricePerUnit 再計算
- 楽天商品が見つからない場合の AI照合候補生成

分離後に持たない責務:

- Yahoo/Amazon offer の同一性判定
- Yahoo/Amazon offer の無効化
- 最安ショップ判定
- モール横断の価格比較
- rank並び替え
- rank上限削除
- title / description 件数同期

ただし初期移行では、既存のrank整理処理をすぐ削除せず feature flag またはオプションで段階分離する。

推奨オプション:

```bash
pnpm update-products -- --skip-rank-maintenance
```

または新設:

```bash
pnpm update-rakuten-products
```

### update-products がやるべき offer 対応

- `offers[]` は保持する。
- 明示的な `provider: "rakuten"` offer がある場合のみ、楽天価格・URL・画像を同期する。
- 楽天商品が別商品へ差し替わった場合は、直接Yahoo/Amazonを編集せず、`reconcile-offers` が検知できる情報を残す。

例:

```yaml
syncRequired:
  offers: true
```

ただし frontmatter に一時フラグを増やしすぎない。基本は `reconcile-offers` が before/after や現在値から判定する。

### 5.2 update-yahoo-products

対象: `scripts/update-yahoo-products.mjs`

責務:

- Yahoo!ショッピング候補取得
- ValueCommerceアフィリエイトURL生成または取得
- `provider: "yahoo"` offer の追加・更新
- Yahoo候補の raw metadata をレポート出力

持たない責務:

- 最終的な同一商品確定
- rank並び替え
- 最安値判定
- 楽天商品差し替え時の横断無効化

初期実装では、明らかな誤候補を減らすため簡易判定はしてよい。ただし最終判断は `reconcile-offers` に寄せる。

出力:

```yaml
offers:
  - provider: "yahoo"
    price: 5350
    url: "..."
    imageUrl: "..."
    available: true
    updatedAt: "2026-05-18"
    matchStatus: "pending"
    matchedCapacity: "100m×60ロール"
    matchNotes: "Yahoo候補取得済み。reconcile待ち"
```

### 5.3 update-amazon-products

将来対象: `scripts/update-amazon-products.mjs`

責務:

- Amazon候補取得
- AmazonアフィリエイトURL管理
- `provider: "amazon"` offer の追加・更新
- Amazon候補の raw metadata をレポート出力

方針:

- Yahooと同じ `offers[]` に入れる。
- Amazon固有のASINなどは optional metadata に閉じ込める。
- 同一商品チェックは `reconcile-offers` で共通化する。

例:

```yaml
offers:
  - provider: "amazon"
    price: 5400
    url: "https://www.amazon.co.jp/..."
    available: true
    updatedAt: "2026-06-01"
    matchStatus: "pending"
    externalId: "ASIN..."
```

### 5.4 reconcile-offers

新設: `scripts/reconcile-offers.mjs`

責務:

- 楽天基準商品と各provider offerの同一性判定
- 容量一致チェック
- stale offer の無効化
- `pending` offer の `matched` / `review` / `rejected` 判定
- 明示楽天 offer の同期確認
- provider別価格の正規化チェック
- レポート出力

持たない責務:

- APIから商品候補を取得しない
- rank並び替えをしない
- 記事本文を変更しない
- 最安値の表示用HTMLを作らない

判定対象:

- product.name
- product.brand
- product.capacity
- product.price
- product.rakutenUrl
- offer.provider
- offer.price
- offer.url
- offer.imageUrl
- offer.matchedCapacity
- offer.updatedAt
- offer.matchStatus

判定結果:

| 状態 | 意味 | 表示 |
|---|---|---|
| `matched` | 同一商品・同一容量と判断 | 表示可 |
| `pending` | モール更新済み、未判定 | 表示不可 |
| `review` | 判断不能、手動確認 | 表示不可 |
| `rejected` | 別商品・容量違い | 表示不可 |

表示側では `matched` と legacy互換の未設定offerのみ表示する。ただし自動更新で追加したYahoo/Amazon offerは必ず `matchStatus` を付ける。

### 5.5 rank-products

新設: `scripts/rank-products.mjs`

責務:

- pricePerUnit による並び替え
- rank振り直し
- rank上限削除
- title / description の商品数同期
- 削除履歴記録

持たない責務:

- 楽天API更新
- Yahoo/Amazon API更新
- 同一商品チェック
- 最安値判定

現状 `update-products.mjs` にある以下を段階移設する。

- `reorderProductsByPricePerUnit`
- `limitProductsByRank`
- `syncTitleProductCount`
- rank上限削除履歴

## 6. 最安値ショップ判断

最安値判断は `update-products` / `update-yahoo-products` / `update-amazon-products` では行わない。

担当:

- 表示時: `src/lib/offers.ts`
- 検証時: `reconcile-offers`

`src/lib/offers.ts` に集約する関数:

```ts
getVisibleOffers(product, options)
getOfferByProvider(product, provider, options)
getLowestOffer(product, options)
getOfferPriceSummary(product, options)
getPriceDifferenceLabel(summary)
```

ルール:

- `available: false` は除外
- `matchStatus: review/rejected/pending` は除外
- `price` が0以下または未設定のofferは価格比較から除外
- feature flag OFF のproviderは除外
- 最安値は表示時に都度計算する

## 7. 価格改定・商品差し替え・数量変更への対応

### 7.1 価格改定

楽天価格変更:

- `update-products` が `products[].price` を更新
- 明示楽天 offer があれば同期
- `reconcile-offers` はYahoo/Amazon offerを維持
- 表示側で最安値を再計算

Yahoo価格変更:

- `update-yahoo-products` がYahoo offer価格を更新
- `matchStatus` は既存が `matched` なら維持してよい
- 商品名や容量が変わった候補なら `pending` に戻す

Amazon価格変更:

- `update-amazon-products` がAmazon offer価格を更新
- 判定ルールはYahooと同じ

### 7.2 商品差し替え

楽天基準商品が別商品へ差し替わった場合:

- `update-products` は楽天基準商品を更新
- `reconcile-offers` がYahoo/Amazon offerを `review` に落とす
- 次回モール別更新で再取得し、再度 reconcile する

無効化例:

```yaml
available: false
matchStatus: "review"
matchNotes: "楽天基準商品が変更されたため再照合が必要"
```

### 7.3 数量変更・容量変更

capacity が変わった場合:

- `reconcile-offers` が各offerの `matchedCapacity` と再比較
- 一致なら `matched` 維持
- 不一致なら `review` または `rejected`
- 容量不明なら `review`

重要:

- Yahoo/Amazon価格が安くても、容量不一致なら表示しない。
- pricePerUnit は当面楽天基準で計算する。
- 将来は provider別 pricePerUnit を `reconcile-offers` で計算してもよい。

### 7.4 商品削除・rank削除

- 商品削除時は `offers[]` も商品ブロックごと削除される。
- rank並び替え時は商品オブジェクトごと移動するため offer は追随する。
- `rank-products` が削除履歴を記録する。

## 8. 段階移行計画

### Phase 1: 表示側のprovider拡張準備

- `src/lib/offers.ts` を provider非依存に近づける。
- `matchStatus` による表示除外を実装。
- `getLowestOffer()` / `getOfferPriceSummary()` を追加。
- `tests/offers.test.ts` を拡張。

完了条件:

- 楽天のみ記事が壊れない。
- Yahoo offerがある記事で最安表示ができる。
- `pending/review/rejected` が表示されない。

### Phase 2: reconcile-offers 新設

- `scripts/reconcile-offers.mjs` を追加。
- YAML parserで全商品とoffersを読む。
- 容量チェックを既存 `frontmatter.ts` の容量抽出ロジックに寄せる。
- `pending` offer を `matched/review/rejected` に振り分ける。
- stale offer を `available: false` にする。
- dry-run / write 両対応。

コマンド:

```bash
pnpm reconcile-offers:dry
pnpm reconcile-offers
```

完了条件:

- `toilet-paper-comparison.md` の容量違いYahoo候補が表示不可になる。
- matched offerだけが表示対象になる。

### Phase 3: update-yahoo-products の責務縮小

- Yahoo候補取得と offer upsert に集中させる。
- 最終的な matched 判定は `reconcile-offers` に任せる。
- `matchStatus: pending` で保存する。
- レポートには候補情報を出す。

完了条件:

- Yahoo更新単体でrankや楽天情報を壊さない。
- `reconcile-offers` 後に表示可否が決まる。

### Phase 4: update-products の責務縮小

- 楽天商品更新に集中させる。
- `offers[]` は保持する。
- 明示楽天 offer がある場合は同期する。
- rank整理処理を `rank-products` に移す準備をする。

完了条件:

- 楽天価格変更後もYahoo/Amazon offerが消えない。
- 楽天商品差し替え後、`reconcile-offers` で他providerがreviewになる。

### Phase 5: rank-products 新設

- `reorderProductsByPricePerUnit`
- `limitProductsByRank`
- `syncTitleProductCount`
- 削除履歴記録

を `rank-products` に移す。

完了条件:

- `update-products --skip-rank-maintenance` 相当でも記事更新ができる。
- `rank-products` 単体で並び替え・件数同期ができる。

### Phase 6: Amazon追加

- `provider: "amazon"` を schema と型へ追加。
- `update-amazon-products.mjs` を追加。
- `reconcile-offers` にAmazonを追加。
- 表示ボタンにAmazonを追加。

完了条件:

- 楽天 / Yahoo / Amazon の3モールで最安表示ができる。
- Amazonが `pending/review/rejected` の場合は表示されない。

## 9. package.json 追加案

```json
{
  "scripts": {
    "update-products": "node scripts/update-products.mjs",
    "update-products:dry": "node scripts/update-products.mjs --dry-run",
    "update-yahoo-products": "node scripts/update-yahoo-products.mjs",
    "update-yahoo-products:dry": "node scripts/update-yahoo-products.mjs --dry-run",
    "reconcile-offers": "node scripts/reconcile-offers.mjs",
    "reconcile-offers:dry": "node scripts/reconcile-offers.mjs --dry-run",
    "rank-products": "node scripts/rank-products.mjs",
    "rank-products:dry": "node scripts/rank-products.mjs --dry-run",
    "update-affiliate-products": "pnpm update-products && pnpm update-yahoo-products && pnpm reconcile-offers && pnpm rank-products",
    "update-affiliate-products:dry": "pnpm update-products:dry && pnpm update-yahoo-products:dry && pnpm reconcile-offers:dry && pnpm rank-products:dry"
  }
}
```

Amazon追加後:

```json
{
  "scripts": {
    "update-amazon-products": "node scripts/update-amazon-products.mjs",
    "update-amazon-products:dry": "node scripts/update-amazon-products.mjs --dry-run",
    "update-affiliate-products": "pnpm update-products && pnpm update-yahoo-products && pnpm update-amazon-products && pnpm reconcile-offers && pnpm rank-products"
  }
}
```

## 10. GitHub Actions 方針

現状の楽天cronをいきなり全モール更新に変えない。

段階:

1. 既存 `update-products.yml` は維持。
2. staging用に `update-affiliate-products-staging.yml` を追加。
3. stagingで `update-products` → `update-yahoo-products` → `reconcile-offers` → `rank-products` → build を確認。
4. 安定後、本番cronを統合コマンドへ切り替える。

本番移行後:

```text
weekly cron
  pnpm update-affiliate-products
  pnpm test
  pnpm build
  changed files commit
  deploy
```

## 11. テスト計画

追加・更新:

- `tests/offers.test.ts`
- `tests/frontmatter.test.ts`
- `tests/reconcile-offers.test.ts`
- `tests/yahoo-offers.test.ts`
- 将来 `tests/amazon-offers.test.ts`

必須ケース:

- 楽天価格変更でYahoo offerが消えない。
- 楽天商品差し替えでYahoo offerが `review` になる。
- capacity変更で容量不一致offerが `review/rejected` になる。
- `pending` offerは表示されない。
- `matched` offerだけ最安判定に使われる。
- Yahooが最安の場合、Yahooが lowest になる。
- Amazon追加後も provider順序に依存しない。
- rank並び替えでoffersが商品に追随する。
- rank削除でoffersが商品ごと削除される。

検証:

```bash
pnpm test
pnpm update-affiliate-products:dry
pnpm build
```

## 12. リスクと対策

| リスク | 対策 |
|---|---|
| スクリプト分割で実行手順が増える | `update-affiliate-products` 統合コマンドを用意 |
| 移行中にrank整理が二重実行される | `update-products` 側に skip オプションを入れて段階移行 |
| pending offerが表示される | 表示側で `pending/review/rejected` を除外 |
| 商品差し替え後に旧モールリンクが残る | `reconcile-offers` でstale判定 |
| Amazon追加で型が壊れる | provider enumと表示ヘルパーを先に拡張しやすい形へ |
| API失敗で全体更新が止まる | モール別レポートとdry-runを分離 |

## 13. 最終形

最終的な責務分離:

```text
scripts/update-products.mjs
  楽天基準商品の更新

scripts/update-yahoo-products.mjs
  Yahoo offer更新

scripts/update-amazon-products.mjs
  Amazon offer更新

scripts/reconcile-offers.mjs
  モール横断の同一性・容量・stale判定

scripts/rank-products.mjs
  記事内ランキング整理

src/lib/offers.ts
  表示用の最安価格・provider別offer取得
```

この構成にすると、今後Amazon以外のモールを追加する場合も、基本的には `update-<provider>-products` と provider定義を足すだけで済む。
