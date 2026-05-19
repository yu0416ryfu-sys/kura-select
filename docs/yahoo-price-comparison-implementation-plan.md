# Yahoo価格併記 実装計画書

対象: KuraSelect の楽天 / Yahoo!ショッピング価格併記

目的: 既存の楽天アフィリエイト運用を壊さず、Yahoo価格併記と最安バッジを早く安全に出す。Amazon対応やrank整理分離は将来課題として残し、現フェーズでは実装しない。

## 1. 方針

案2を採用する。

```text
商品A
楽天価格: 5,300円
Yahoo価格: 5,350円
楽天が50円安い
[楽天市場で見る] [Yahoo!ショッピングで見る]
```

今回やること:

- 楽天 / Yahoo の価格を併記する。
- 安い方に「最安」バッジを付ける。
- 既存Yahoo offerを壊さない。
- `pending` / `review` / `rejected` offer は表示しない。
- `matchStatus` がない既存Yahoo offerは、移行期間中は legacy matched として扱う。
- `toilet-paper-comparison.md` の明確なデータ問題を先に直す。

今回やらないこと:

- Amazon対応
- `rank-products.mjs` 分離
- GitHub Actions の大幅変更
- 全記事の `provider: "rakuten"` offer 追加
- `products[].price` の廃止
- ポイント還元込みの実質価格計算

## 2. 最重要リスクと対策

### 2.1 pending 上書き禁止

現状、`toilet-paper-comparison.md` には `matchStatus` なしのYahoo offerが存在する。

これを `update-yahoo-products` 実行時に `matchStatus: "pending"` で上書きすると、reconcile前にYahooボタンが消える可能性がある。

ルール:

- 既存の `matchStatus` なし offer は legacy matched として表示対象にする。
- 既存の表示中Yahoo offerを `pending` に上書きしない。
- 新規に自動取得したYahoo offerだけ `pending` または `matched` を付ける。
- `pending` は表示・価格比較・JSON-LDから除外する。

### 2.2 楽天価格の正は products[].price

現状63記事では `offers[]` に `provider: "rakuten"` は基本存在しない。

今回の実装では、楽天価格の正は以下とする。

- `products[].price`
- `products[].rakutenUrl`
- `products[].imageUrl`

`provider: "rakuten"` offer は将来案。今回、全記事へ追加しない。

表示側では `products[].price` から楽天 fallback offer を作る。

### 2.3 高いYahoo offerは削除しない

Yahoo価格が楽天より高いこと自体は削除理由にしない。

削除・非表示にする条件:

- 別商品
- 容量違い
- URL不正
- 価格不正
- `available: false`
- `matchStatus: pending/review/rejected`

同一商品・同一容量なら、Yahooが高くても「楽天が安い」と表示して残す。

## 3. 即時データ対応

対象: `src/content/articles/toilet-paper-comparison.md`

### rank 1

問題:

- 楽天: `100m×60ロール`
- Yahoo URL: `mori100ms30` に見える
- 30ロール品なら容量違い

対応:

- 正しいYahoo 60ロール商品のURLが確認できるなら差し替える。
- 確認できない場合はYahoo offerを**削除**、または `available: false` + `matchStatus: "review"` にする。
- **`matchStatus: "review"` 単独では非表示にならない**（`src/lib/offers.ts` の `normalizeOffer()` は `available === false` しか参照しないため）。必ず `available: false` を併記すること。
- 容量違い疑いのまま表示しない。

### rank 8

問題:

- 楽天: 3,532円
- Yahoo: 5,300円
- Yahooが1,768円高い

対応:

- 同一商品・同一容量なら残す。
- 表示では「楽天が1,768円安い」と出す。
- 高いだけでは削除しない。

### 未設定rankへのYahoo offer確認

現状、Yahoo offer があるのは rank 1, 3, 7, 8, 10 の5件のみ。

未設定:

- rank 2
- rank 4
- rank 5
- rank 6
- rank 9

Phase 0で dry-run だけ先に実行し、候補を確認する。

```bash
pnpm update-yahoo-products:dry -- --file=toilet-paper-comparison
```

対応方針:

- 明確に同一商品・同一容量と確認できる候補のみ反映する。
- 容量不明・別容量疑いは反映しない。
- 現行の `update-yahoo-products` は容量チェックが弱いため、writeはレポート確認後に限定する。

## 4. データモデル

既存構造を維持する。

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
    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: 5350
        url: "https://ck.jp.ap.valuecommerce.com/..."
        imageUrl: "https://item-shopping.c.yimg.jp/..."
        available: true
        updatedAt: "2026-05-18"
```

追加する optional フィールド:

```yaml
matchStatus: "matched" # matched / pending / review / rejected
matchConfidence: "high"
matchedCapacity: "100m×60ロール"
matchNotes: "容量合計と主要商品名が一致"
```

`src/content.config.ts` の `offerSchema` には以下を optional で追加する。

```ts
matchStatus: z.enum(["matched", "pending", "review", "rejected"]).optional(),
matchConfidence: z.enum(["high", "medium", "low"]).optional(),
matchedCapacity: z.string().optional(),
matchNotes: z.string().optional(),
```

`src/lib/offers.ts` の `ProductOffer` 型にも同じフィールドを追加する。

互換ルール:

| offer状態 | 表示 | 理由 |
|---|---|---|
| `matchStatus` なし | 表示する | 既存データ互換 |
| `matched` | 表示する | 確認済み |
| `pending` | 表示しない | 未照合 |
| `review` | 表示しない | 手動確認待ち |
| `rejected` | 表示しない | 別商品または容量違い |
| `available: false` | 表示しない | 販売不可または無効 |

## 5. 表示ロジック

対象: `src/lib/offers.ts`

追加する関数:

```ts
getOfferByProvider(product, provider, options)
getVisibleOffers(product, options)      // リンク表示対象（matchStatus/available フィルタ済み）
getComparableOffers(product, options)   // 価格比較対象（price > 0 を追加フィルタ）
getLowestOffer(product, options)
getOfferPriceSummary(product, options)
getPriceDifferenceLabel(summary)
```

`getVisibleOffers()` と `getComparableOffers()` は明示的に分ける。`price` なし・`price <= 0` はリンク表示は可だが価格比較は不可、というルールを型レベルで保証する。

重要ルール:

- 楽天は必ず `products[].price` / `rakutenUrl` から fallback offer を作る。
- Yahooは `PUBLIC_ENABLE_YAHOO_AFFILIATE=true` のときだけ表示する。
- `offers[0]` のような順序依存は禁止。
- `pending/review/rejected` は表示・価格比較から除外する。`normalizeOffer()` または同等の正規化層で判定する。
- `matchStatus` なしは legacy matched として扱う。
- 価格が未設定・0以下のofferは価格比較から除外する。ただしリンク表示可否は別途判断する。

`ProductOffer` に追加する型:

```ts
matchStatus?: "matched" | "pending" | "review" | "rejected";
matchConfidence?: "high" | "medium" | "low";
matchedCapacity?: string;
matchNotes?: string;
```

表示対象と価格比較対象の区別:

| 状態 | リンク表示 | 価格比較 | JSON-LD |
|---|---:|---:|---:|
| `matchStatus` なし / `matched` かつ `available !== false` | する | 価格が正ならする | 価格が正なら候補 |
| `pending/review/rejected` | しない | しない | しない |
| `available: false` | しない | しない | しない |
| `price` なし | する | しない | しない |
| `price <= 0` | する | しない | しない |

価格差ラベル:

- 楽天が安い: `楽天が50円安い`
- Yahooが安い: `Yahoo!が50円安い`
- 同価格: `同価格`
- Yahooなし: ラベルなし

「100円以下はほぼ同額」は今回やらない。

## 6. UI実装

### 6.1 ComparisonTableSort.tsx

変更:

- 価格列を「最安価格」にする。
- 楽天価格 / Yahoo価格を併記する。
- 最安販売元に「最安」バッジを付ける。
- 価格ソートは最安価格ベースにする。

**設計上の注意**: `ComparisonTable.astro` のサーバー側で `getOfferPriceSummary()` を呼び、`lowestPrice` / `lowestProvider` / `priceRows` / `priceDifferenceLabel` までシリアライズして island に渡す。island 内では価格計算を行わず、受け取ったサマリーを表示するだけにする。こうすることで `ProductCard` / CTA / JSON-LD と価格ロジックが一元化され、UI と JSON-LD のズレを防げる。

PC例:

```text
最安 ¥5,300 楽天
楽天 ¥5,300 / Yahoo ¥5,350
楽天が50円安い
```

モバイル例:

```text
最安 ¥5,300 楽天
楽天 ¥5,300
Yahoo ¥5,350
```

### 6.2 ProductCard.astro

変更:

- 商品カードにも楽天価格 / Yahoo価格を表示する。
- 最安バッジを表示する。
- ボタンは楽天 / Yahoo の両方を残す。

### 6.3 TopPickCta.astro / ArticleLayout.astro

変更:

- `product.price` 直表示ではなく価格サマリーを使う。
- 1位CTAと記事下部CTAで表示価格が比較表と矛盾しないようにする。

### 6.4 AffiliateLink.astro

変更候補:

- `price?: number`
- `isLowest?: boolean`

注意:

- 価格比較ロジックは `AffiliateLink` に持たせない。
- `AffiliateLink` は表示専用にする。

## 7. update-products 最小改修

対象: `scripts/update-products.mjs`

今回の必須対応:

- `updateProductInFrontmatter()` が `offers[]` を保持することをテストで保証する。
- 楽天価格が更新されても、表示側は `products[].price` を楽天価格の正として使う。
- 商品名・capacity・rakutenUrl が明確に変わった場合だけ、Yahoo offerを `review` に落とす。
- 既存の `beforeSnapshot` / `afterSnapshot` 比較を使って差分を判定する。

現状確認:

- `update-products.mjs` にはすでに `beforeSnapshot` / `afterSnapshot` / `changed` 比較がある。
- そのため、差分検知の土台は新規に作らなくてよい。
- ただし、差分をもとにYahoo offerを `review` 化する処理は未実装なので追加が必要。

**実装場所の注意**: Yahoo offer の `review` 化は `updateProductInFrontmatter()` に混ぜない。同関数は単純なフィールド更新関数であり、before/after差分や direct item URL 比較のコンテキストを持たない。`markProviderOffersForReview()` のような別関数を `scripts/lib/yahoo-offers.ts` に作り、`update-products.mjs` の `beforeSnapshot` / `afterSnapshot` 判定後に呼ぶ形にする。

やらないこと:

- 全記事へ `provider: "rakuten"` offer を追加しない。
- rank整理処理を分離しない。
- update-products にYahoo/Amazon横断ロジックを混ぜない。

Yahoo offerを `review` に落とす条件:

- `newName` が設定された。
- `newCapacity` が設定され、既存capacityと比較値が変わった。
- `rakutenUrl` の direct item URL が変わった。
- AI商品差し替えが適用された。

Phase 4で必須にする範囲:

- `offers[]` 保持テスト
- `beforeSnapshot` / `afterSnapshot` を使った `capacity` / `rakutenUrl` 差分検知
- 明確な商品差し替え時のYahoo offer review化（`markProviderOffersForReview()` として分離実装）

Phase 4で無理にやらない範囲:

- 曖昧な商品名変更の全自動判定
- すべての容量表記ゆれの完全判定
- `reconcile-offers.mjs` 相当の横断チェック

無効化例:

```yaml
offers:
  - provider: "yahoo"
    label: "Yahoo!"
    price: 4980
    url: "https://ck.jp.ap.valuecommerce.com/..."
    available: false
    matchStatus: "review"
    matchNotes: "楽天基準商品の変更によりYahoo再確認が必要"
    updatedAt: "2026-05-18"
```

実装上の注意:

- `updateProductInFrontmatter()` 自体は YAML parser 経由なので `offers[]` を保持できる想定だが、回帰防止テストを追加する。
- Yahoo offer の `review` 化は、既存 offer を削除せず `available: false` と `matchStatus: "review"` を付けて非表示にする。
- `rakutenUrl` 変更判定は affiliate URL の文字列全体ではなく、可能な限り direct item URL 同士で比較する。

## 8. update-yahoo-products 最小改修

対象: `scripts/update-yahoo-products.mjs` / `scripts/lib/yahoo-offers.ts`

今回の必須対応:

- 既存の表示中Yahoo offerを `pending` で上書きしない。
- 新規Yahoo候補を追加する場合は、容量チェックできるまでは `pending` にする。
- ただし `pending` は表示されないため、write前にレポート確認を必須にする。
- `capacity` を読めるよう、正規表現の `parseProducts()` ではなくYAML parserに変更する。

上書きルール:

- 既存Yahoo offer が `matchStatus` なし、または `matched` の場合、別URLの候補で自動上書きしない。
- 既存Yahoo offer と候補URLが同一の場合のみ、`price` / `imageUrl` / `available` / `updatedAt` の更新を許可する。
- 既存Yahoo offer が `pending` の場合は、同一URLなら更新可。別URLなら候補としてレポートに出し、既存値は維持する。
- 既存Yahoo offer が `review` / `rejected` の場合は、自動復活させない。候補はレポートに出す。
- 新規Yahoo offer は、容量一致を機械判定できるまでは `matchStatus: "pending"` にする。
- 容量違いが明確な候補は記事へ追加せず、レポート上で `rejected` として扱う。

YAML parser化は必須とする。

理由:

- `scripts/lib/yahoo-offers.ts` ではすでに `js-yaml` を使っている。
- 現行 `update-yahoo-products.mjs` の `parseProducts()` は `name` / `rank` しか読めない。
- 容量チェックをするには `capacity` / `brand` / `rakutenUrl` / 既存 `offers[]` が必要。
- 正規表現パースのままでは、容量違い候補を安全に除外できない。

優先度:

1. 既存offerを壊さない上書きルール
2. `capacity` 取得
3. 容量違い候補の `rejected` レポート

今回、完全な `reconcile-offers.mjs` は作らない。必要になったらPhase 5で追加する。

## 9. 同一商品・同一容量チェック

今回の最低ライン:

- rank1 のような明確な容量違い疑いを表示しない。
- 新規Yahoo候補は、容量一致が確認できるまで自動表示しない。
- 既存の `matchStatus` なし offer は、明確な問題が見つからない限り表示互換を維持する。

判定例:

| 楽天 capacity | Yahoo候補 | 判定 |
|---|---|---|
| `100m×60ロール` | `100m 60ロール` | matched |
| `100m×60ロール` | `100m 30ロール` | rejected |
| `170m×48ロール` | `170m 48個入` | matched |
| `150m×48ロール` | `48ロール` のみ | review |
| `250m×16ロール` | 容量不明 | review |

## 10. JSON-LD

対象: `src/layouts/ArticleLayout.astro`

変更:

- Product JSON-LD の offer は画面表示と同じ価格サマリーから選ぶ。
- feature flag OFF では楽天。
- feature flag ON では表示可能offerの最安。
- `pending/review/rejected` はJSON-LDに出さない。
- 価格なし、または `price <= 0` のofferはJSON-LDに出さない。
- URLと価格の不整合を避けるため、Yahoo URLを使う場合はYahoo価格も正の数値で存在することを必須にする。
- 最安候補が価格比較対象外なら、楽天 fallback offer をJSON-LDに使う。

## 11. テスト計画

対象:

- `tests/offers.test.ts`
- `tests/frontmatter.test.ts`
- `tests/yahoo-offers.test.ts`（**必須**。「必要なら」ではない）

`tests/yahoo-offers.test.ts` を必須とする理由: `scripts/lib/yahoo-offers.ts` の upsert ルール（既存 matched/matchStatus なし offer を別 URL で上書きしない）は今回最も壊してはいけないコアロジック。単体テストで固定しないと次回スクリプト改修時に無言で破壊される。

必須テスト:

- `matchStatus` なしYahoo offerは表示される。
- `pending` は表示されない。
- `review` は表示されない。
- `rejected` は表示されない。
- `available: false` は表示されない。
- `price` なしYahoo offerはリンク表示されるが価格比較・JSON-LDには使われない。
- `price <= 0` のofferは価格比較・JSON-LDには使われない。
- 楽天価格は `products[].price` fallbackから取得される。
- `offers[]` の順序に依存しない。
- 楽天が安い場合に楽天がlowest。
- Yahooが安い場合にYahooがlowest。
- 同価格なら `同価格`。
- `updateProductInFrontmatter()` でYahoo offerが保持される。
- 商品差し替え時にYahoo offerがreview化される。
- 既存 `matchStatus` なし / `matched` のYahoo offerが別URL候補で上書きされない。
- 既存Yahoo offerと同一URL候補なら価格・画像・在庫・更新日の更新が許可される。
- JSON-LDでYahoo URL + 楽天価格の組み合わせが出ない。

検証:

```bash
pnpm test
pnpm build
```

Yahoo表示確認:

```powershell
$env:PUBLIC_ENABLE_YAHOO_AFFILIATE="true"; $env:PUBLIC_NOINDEX="true"; pnpm build
```

## 12. 実装フェーズ

**フェーズ順の根拠**: 現行 `update-yahoo-products.mjs` はデフォルト書き込みで既存 Yahoo offer を `provider` 一致だけで上書きする（`yahoo-offers.ts` の `upsertYahooOfferInFrontmatter()` は `matchStatus` を参照しない）。UI を先にデプロイしても、次回スクリプト実行で既存 offer が無条件上書きされうる。そのため **スクリプト安全化（Phase 2）を UI 実装（Phase 3）より先に完了させる**。

### Phase 0: 即時データ修正

- `toilet-paper-comparison.md` rank1 のYahoo offerを確認。
- 30ロール品なら**削除**または `available: false` + `matchStatus: "review"`（`matchStatus: "review"` 単独では現行 `normalizeOffer()` を通過するため非表示にならない）。
- rank8 は同一商品・同一容量なら残す。
- rank 2, 4, 5, 6, 9 のYahoo候補を dry-run で確認。
- 明確に同一商品・同一容量の候補だけ反映する。

完了条件:

- 明確な容量違い疑いリンクが表示されない。
- 未設定rankのYahoo候補レポートが確認済み。

### Phase 1: schema / offers.ts / テスト

- `src/content.config.ts` の `offerSchema` に `matchStatus` 系フィールドを追加。
- `src/lib/offers.ts` に `matchStatus` フィルタと価格比較ヘルパーを追加。
- `getVisibleOffers()` と `getComparableOffers()` を明示的に分離する。
- legacy matched 互換を入れる。
- `tests/offers.test.ts` を追加・更新。

完了条件:

- 楽天 fallback が動く。
- `matchStatus` なしYahoo offerが表示対象になる。
- `pending/review/rejected` が表示除外される。
- `getVisibleOffers()` と `getComparableOffers()` が型で区別されている。
- provider順序に依存せず最安判定できる。
- `pnpm test` が通る。

### Phase 2: update-yahoo-products 安全化

- `scripts/lib/yahoo-offers.ts` の `upsertYahooOfferInFrontmatter()` に上書きルールを追加（`matchStatus` なし / `matched` を別URL候補で上書きしない）。
- `tests/yahoo-offers.test.ts` を**必須**で追加。upsert ルールをテストで固定する。
- `update-yahoo-products.mjs` をYAML parser化し、`capacity` / `brand` / 既存 `offers[]` を読む。

完了条件:

- 既存 `matchStatus` なし / `matched` のYahoo offerが別URL候補で上書きされない。
- 同一URLなら価格・画像・在庫・更新日の更新は許可される。
- `update-yahoo-products` が `capacity` / `brand` / `rakutenUrl` を読める。
- `tests/yahoo-offers.test.ts` がグリーン。

### Phase 3: UI / JSON-LD 実装

- `ComparisonTable.astro` サーバー側で `getOfferPriceSummary()` を呼び、`lowestPrice` / `lowestProvider` / `priceRows` / `priceDifferenceLabel` をシリアライズして island に渡す。
- `ComparisonTableSort.tsx` で価格併記と最安バッジ（island 内では価格計算しない）。
- `ProductCard.astro` / `TopPickCta.astro` / `ArticleLayout.astro` を価格サマリー対応。
- JSON-LDを最安offer対応。

完了条件:

- 楽天/Yahoo価格が併記される。
- 最安バッジが正しく付く。
- feature flag OFFで楽天のみ表示。
- JSON-LDが画面表示価格と矛盾しない。
- `pnpm build` が通る。

### Phase 4: update-products 商品差し替え時 review 化

- `scripts/lib/yahoo-offers.ts` に `markProviderOffersForReview()` を追加（`updateProductInFrontmatter()` には混ぜない）。
- `scripts/update-products.mjs` の `beforeSnapshot` / `afterSnapshot` 判定後に `markProviderOffersForReview()` を呼ぶ。
- `tests/frontmatter.test.ts` に offer保持・review化テストを追加。

完了条件:

- `updateProductInFrontmatter()` でYahoo offerが保持される。
- 商品差し替え時（`newName` / `newCapacity` / `rakutenUrl` 変更）に旧Yahoo offerが `available: false` + `matchStatus: "review"` になる。
- `pnpm test` が通る。

### Phase 5: reconcile-offers 検討

このフェーズは、Phase 1〜4後に必要なら実装する。

先に決めること:

- stale判定基準
- 何日以上未更新でreviewに落とすか
- URL変化をどう扱うか
- `matchedCapacity` をどのタイミングで更新するか

実装対象:

- `scripts/reconcile-offers.mjs`

### Future

- Amazon対応
- `rank-products.mjs` 分離
- provider別 pricePerUnit
- ポイント還元込み実質価格

## 13. 変更ファイル一覧

| ファイル | 内容 | フェーズ |
|---|---|---|
| `src/content/articles/toilet-paper-comparison.md` | rank1のYahoo offer修正（削除または `available: false`） | Phase 0 |
| `src/content.config.ts` | matchStatus系optionalフィールド追加 | Phase 1 |
| `src/lib/offers.ts` | `getVisibleOffers()` / `getComparableOffers()` 分離、価格比較ヘルパー、legacy matched互換 | Phase 1 |
| `tests/offers.test.ts` | 価格比較・表示除外テスト | Phase 1 |
| `scripts/lib/yahoo-offers.ts` | pending上書き禁止、`markProviderOffersForReview()` 追加 | Phase 2 / Phase 4 |
| `scripts/update-yahoo-products.mjs` | 既存offer保護、YAML parser化、capacity取得 | Phase 2 |
| `tests/yahoo-offers.test.ts` | upsertルール固定テスト（**必須**） | Phase 2 |
| `src/components/product/ComparisonTable.astro` | 価格サマリーをサーバー側で計算してislandに渡す | Phase 3 |
| `src/components/product/ComparisonTableSort.tsx` | 価格併記、最安バッジ（サマリー受け取り専用） | Phase 3 |
| `src/components/product/ProductCard.astro` | 価格併記、最安バッジ | Phase 3 |
| `src/components/product/TopPickCta.astro` | 最安価格表示 | Phase 3 |
| `src/components/product/AffiliateLink.astro` | 価格・最安表示props | Phase 3 |
| `src/layouts/ArticleLayout.astro` | CTAとJSON-LDの価格サマリー対応 | Phase 3 |
| `scripts/update-products.mjs` | `markProviderOffersForReview()` 呼び出し追加 | Phase 4 |
| `tests/frontmatter.test.ts` | offer保持・review化テスト | Phase 4 |

## 14. 最終チェックリスト

- [ ] rank1の容量違い疑いYahooリンクが表示されない（`available: false` が付いている）
- [ ] rank8は高いだけでは削除されない
- [ ] rank 2, 4, 5, 6, 9 のYahoo候補dry-runが確認済み
- [ ] `matchStatus` なし既存Yahoo offerが表示される
- [ ] `pending/review/rejected` が表示されない
- [ ] `matchStatus: "review"` 単独では非表示にならないことをテストで確認済み
- [ ] `getVisibleOffers()` と `getComparableOffers()` が型で分離されている
- [ ] 既存 matched / matchStatus なし Yahoo offer が別URL候補で上書きされない（`tests/yahoo-offers.test.ts` でカバー）
- [ ] 価格サマリーがサーバー側で一元計算されてislandに渡されている
- [ ] 楽天/Yahoo価格が併記される
- [ ] 最安バッジが正しい
- [ ] JSON-LDが画面表示価格と矛盾しない
- [ ] `update-products` 相当でYahoo offerが保持される
- [ ] 既存Yahoo offerが `pending` に上書きされない
- [ ] `update-yahoo-products` がYAML parserでcapacityを読める
- [ ] `pnpm test` が通る
- [ ] `pnpm build` が通る

## 15. 長期計画との関係

`docs/affiliate-update-pipeline-plan.md` は長期アーキテクチャとして残す。

ただし、今回の実装では以下を延期する。

- `reconcile-offers.mjs` の本格実装
- `rank-products.mjs` 分離
- Amazon対応
- update-affiliate-products 統合コマンド
- staging GitHub Actionsの大幅変更

まずはYahoo価格併記で収益化の検証を優先する。
