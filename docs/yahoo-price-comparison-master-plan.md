# Yahoo価格併記・同一商品チェック 統合実装プラン

対象: KuraSelect の比較記事における楽天 / Yahoo!ショッピング価格表示

目的: 楽天価格とYahoo価格を同じ商品内で併記し、安い販売元をわかりやすく示す。同時に、Yahoo候補が楽天商品と同一商品・同一容量であることをチェックし、容量違い・SKU違いの誤掲載を防ぐ。

この計画は `docs/IMPLEMENTATION_PLAN_YAHOO.md` を基本方針とし、`docs/price-comparison-plan.md` の具体的なUI案と `toilet-paper-comparison.md` の現状分析を取り込んだ統合版。

## 1. 結論

案2を採用する。

```text
1位 商品A
最安: 楽天 5,300円
楽天価格: 5,300円
Yahoo価格: 5,350円
楽天が50円安い
[楽天市場で見る] [Yahoo!ショッピングで見る]
```

方針:

- 楽天 / Yahoo の両方の価格とボタンを表示する。
- 最安販売元には「最安」バッジを付ける。
- Yahooが高くても、同一商品・同一容量なら原則表示する。
- 容量違い・SKU違い・同一性不明のYahoo候補は自動表示しない。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=false` では従来通り楽天中心表示に戻す。

## 2. 収益化上の狙い

- 価格透明性が高まり、比較サイトとしての信頼が上がる。
- 楽天派・Yahoo派の両方を取りこぼしにくい。
- Yahooが最安でない場合でも、PayPay経済圏の読者がYahooを選ぶ可能性がある。
- 最安バッジでクリック先を迷いにくくしつつ、複数モールの購入機会を残せる。

Yahoo offer は「高いから削除」ではなく、「同一商品・同一容量でない」「誤マッチ」「価格やURLが無効」の場合だけ除外する。

## 3. 現状サマリー

既存実装:

- `src/content.config.ts`
  - `products[].offers[]` は optional で定義済み。
- `src/lib/offers.ts`
  - 楽天 fallback offer、Yahoo feature flag、`getVisibleOffers()` / `getPrimaryOffer()` がある。
- `src/components/product/AffiliateLink.astro`
  - 楽天 / Yahoo 共通リンクがある。
- `src/components/product/ComparisonTable.astro`
  - `visibleOffers` を作って `ComparisonTableSort.tsx` に渡している。
- `src/components/product/ComparisonTableSort.tsx`
  - 楽天 / Yahoo ボタンを表示できる。
- `scripts/update-yahoo-products.mjs`
  - Yahoo offer を frontmatter に追加・更新できる。

主な課題:

- 楽天価格 / Yahoo価格の併記が弱い。
- `product.price` が楽天基準のままで、Yahooが安い場合に最安が伝わりにくい。
- `offers[0]` のような順序依存で価格比較すると誤判定しやすい。
- Yahoo候補の同一商品・同一容量チェックが不足している。
- 楽天価格更新時に、`products[].price` と `offers[].provider: "rakuten"` の価格がズレる可能性がある。
- 商品差し替え・容量変更時に、旧商品のYahoo offerが残る可能性がある。
- `update-yahoo-products.mjs` は現状 `parseProducts()` で `name` / `rank` しか読んでおらず、容量チェックに必要な `capacity` や既存offer情報を使えていない。

## 4. toilet-paper-comparison.md の現状

現時点の確認対象:

| rank | 楽天価格 | Yahoo価格 | 状態 | 対応 |
|---:|---:|---:|---|---|
| 1 | 3,550円 | 3,500円 | Yahoo URL が `mori100ms30` に見え、楽天 `100m×60ロール` と容量不一致の疑い | 自動採用禁止。正しい60ロールURLへ差し替え、なければ `rejected` |
| 2 | 4,980円 | なし | offers 未設定 | dry-runで候補確認 |
| 3 | 5,130円 | 5,130円 | 価格一致。容量一致ならOK | `matched` にする |
| 4 | 5,148円 | なし | offers 未設定 | dry-runで候補確認 |
| 5 | 4,840円 | なし | offers 未設定 | dry-runで候補確認 |
| 6 | 4,980円 | なし | offers 未設定 | dry-runで候補確認 |
| 7 | 5,038円 | 4,980円 | Yahooが安い。容量一致ならOK | `matched` にする |
| 8 | 3,532円 | 5,300円 | Yahooが高い。同一商品なら表示可 | 容量一致なら残す。高いだけでは削除しない |
| 9 | 2,981円 | なし | offers 未設定 | dry-runで候補確認 |
| 10 | 4,235円 | 4,235円 | 価格一致。容量一致ならOK | `matched` にする |

最初の検証記事は `src/content/articles/toilet-paper-comparison.md` とする。

## 5. データモデル

既存の `products[].price` は当面「楽天基準価格」として残す。

販売元別価格の正は `offers[]` に寄せる。ただし楽天 offer がない既存記事では `rakutenUrl` と `price` から楽天 fallback offer を生成する。

```yaml
products:
  - rank: 1
    name: "商品名"
    brand: "ブランド"
    price: 5300
    capacity: "100m×60ロール"
    pricePerUnit: "約0.88円/m"
    rakutenUrl: "https://hb.afl.rakuten.co.jp/..."
    offers:
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

追加する optional フィールド:

| フィールド | 値 | 目的 |
|---|---|---|
| `matchStatus` | `matched` / `review` / `rejected` | 表示可否とレビュー状態 |
| `matchConfidence` | `high` / `medium` / `low` | 自動判定の信頼度 |
| `matchedCapacity` | 文字列 | Yahoo候補から抽出した容量 |
| `matchNotes` | 文字列 | 判定理由 |

表示に使うのは原則 `matchStatus` が未設定または `matched` の offer のみ。ただしYahoo自動同期で追加する offer は必ず `matchStatus` を付ける。

楽天価格について:

- 初期状態では `products[].price` / `products[].rakutenUrl` / `products[].imageUrl` から楽天 fallback offer を生成する。
- 将来的に `offers[]` に `provider: "rakuten"` を明示保存する場合、`update-products.mjs` が楽天 offer も同時更新する。
- 価格比較ヘルパーは、明示的な楽天 offer が古い場合に備え、原則として `products[].price` 由来の楽天 fallback を最新楽天価格として扱う。

## 6. 同一商品・同一容量チェック

### 判定対象

- `product.name`
- `product.brand`
- `product.capacity`
- Yahoo候補の商品名
- Yahoo候補の商品説明
- Yahoo候補URL / itemCode
- Yahoo候補の価格

### 容量判定

既存の `scripts/lib/frontmatter.ts` の容量抽出ロジックを再利用する。新しい容量判定を別系統で作らない。

判定例:

| 楽天 capacity | Yahoo候補 | 判定 |
|---|---|---|
| `100m×60ロール` | `100m 60ロール` | `matched` |
| `100m×60ロール` | `100m 30ロール` | `rejected` |
| `170m×48ロール` | `170m 48個入` | `matched` |
| `150m×48ロール` | `48ロール` のみ | `review` |
| `250m×16ロール` | 容量不明 | `review` |

### 商品名・SKU判定

自動採用条件:

- ブランドまたは主要ブランド語が一致する。
- 主要トークンが一定数一致する。
- 容量が一致する、または同等と判断できる。
- `シングル` / `ダブル`、ロール数、詰め替え / 本体などのSKU差分がない。
- price が正の整数。
- affiliate URL が有効。

自動除外条件:

- 容量が明確に違う。
- `シングル` と `ダブル` が違う。
- ロール数・枚数・容量違いが明確。
- URLが無効。
- price が欠落または0以下。

判断不能は `review` とし、自動表示しない。

## 7. 価格比較ロジック

`offers[0]` には依存しない。必ず provider で取得する。

`src/lib/offers.ts` に以下を追加する。

- `getOfferByProvider(product, provider, options)`
- `getLowestOffer(product, options)`
- `getOfferPriceSummary(product, options)`
- `getPriceDifferenceLabel(summary)`

戻り値イメージ:

```ts
{
  offers: ProductOffer[];
  rakutenOffer: ProductOffer | null;
  yahooOffer: ProductOffer | null;
  lowestOffer: ProductOffer | null;
  priceDiff: number | null;
  priceLabel: "楽天が50円安い" | "Yahoo!が50円安い" | "同価格" | null;
}
```

価格差ラベル:

- 完全同額なら `同価格`
- 差額があるなら `楽天が50円安い` / `Yahoo!が50円安い`
- 「ほぼ同額」は初期実装では使わない

理由:

- トイレットペーパーなどの低単価比較では100円差でも印象が変わる。
- 閾値を入れるなら後続改善で、価格比率も含めて検討する。

## 8. 表示仕様

### 比較表

対象: `src/components/product/ComparisonTableSort.tsx`

変更:

- 価格列を「最安価格」に変更する。
- 楽天価格 / Yahoo価格を同じセル内で併記する。
- 最安販売元に「最安」バッジを付ける。
- 価格ソートは `lowestOffer.price` ベースにする。
- Yahoo feature flag OFF では楽天価格のみ表示する。

PC表示:

```text
最安価格
¥5,300 楽天 最安
楽天 ¥5,300 / Yahoo ¥5,350
楽天が50円安い
```

モバイル表示:

```text
最安 ¥5,300 楽天
楽天 ¥5,300
Yahoo ¥5,350
```

### 商品カード

対象: `src/components/product/ProductCard.astro`

変更:

- 現在の価格表示を「最安価格」中心にする。
- 楽天 / Yahoo の価格を並べて表示する。
- 最安バッジと価格差ラベルを表示する。
- ボタンは楽天 / Yahoo の両方を表示する。

ボタン例:

```text
[最安 楽天市場 ¥5,300] [Yahoo! ¥5,350]
```

### 1位CTA / 記事内結論CTA

対象:

- `src/components/product/TopPickCta.astro`
- `src/layouts/ArticleLayout.astro`

変更:

- `product.price` 直参照ではなく価格サマリーから表示する。
- 最安価格、販売元、価格差ラベルを表示する。
- 楽天 / Yahoo ボタンを両方出す。

### AffiliateLink

対象: `src/components/product/AffiliateLink.astro`

変更候補:

- `price?: number`
- `isLowest?: boolean`
- `priceLabel?: string`

ただし価格比較ロジックを `AffiliateLink` 内に持たせない。`AffiliateLink` は表示専用にする。

### JSON-LD

対象: `src/layouts/ArticleLayout.astro`

変更:

- 画面表示と同じ `lowestOffer` を Product JSON-LD の offer に使う。
- feature flag OFF では楽天 offer を使う。
- `review` / `rejected` の offer は JSON-LD に出さない。

## 9. Yahoo更新スクリプト

対象: `scripts/update-yahoo-products.mjs`

変更:

- Yahoo候補取得後に同一商品・同一容量チェックを実行する。
- dry-run レポートに判定結果と理由を出す。
- write は `matched` のみ。
- `review` / `rejected` は frontmatter に自動追加しない。

レポート例:

```text
### rank 1: 森を守ろう トイレットペーパー シングル
- rakuten capacity: 100m×60ロール
- yahoo candidate: 森を守ろう 100m 30ロール
- yahoo capacity: 100m×30ロール
- decision: rejected
- reason: ロール数が一致しない
```

検証コマンド:

```bash
pnpm update-yahoo-products:dry -- --file=toilet-paper-comparison
```

write:

```bash
pnpm update-yahoo-products -- --file=toilet-paper-comparison
```

## 10. 楽天更新スクリプト

対象: `scripts/update-products.mjs` / `scripts/lib/frontmatter.ts`

結論: 楽天価格が変わった時の価格比較精度を守るため、`update-products` 側も改修対象に含める。

現状:

- `updateProductInFrontmatter()` は YAML 全体をパースして対象商品の既存フィールドを更新するため、`offers[]` 自体は保持される。
- ただし、`offers[]` に `provider: "rakuten"` が明示保存されている場合、その `price` / `url` / `imageUrl` は現在の楽天更新処理だけでは同期されない。
- 明示的な楽天 offer が古いまま残ると、案2の最安表示・価格差表示・JSON-LD が誤る可能性がある。
- さらに商品差し替え時は、既存のYahoo offerが旧商品を指したまま残る可能性がある。

初期実装の必須対応:

- `update-products` 実行後も `offers[]` が保持されることをテストで保証する。
- 価格比較ヘルパーでは、楽天価格は `products[].price` / `rakutenUrl` から作る fallback offer を優先または同期済みとして扱う。

推奨対応:

- `updateProductInFrontmatter()` に楽天 offer 同期処理を追加する。
- 楽天API更新で `price` / `affiliateUrl` / `imageUrl` が更新されたら、同じ商品の `offers[]` 内の `provider: "rakuten"` も更新する。
- 楽天 offer が存在しない場合は、初期フェーズでは追加しなくてもよい。既存 fallback で表示できるため。

同期ルール:

| 状態 | 対応 |
|---|---|
| 楽天 offer なし | `products[].price` から fallback 生成。frontmatter追記は任意 |
| 楽天 offer あり | `price` / `url` / `imageUrl` / `updatedAt` を楽天API結果で同期 |
| Yahoo offer あり | 触らない |
| `matchStatus: review/rejected` のYahoo offer | 触らない |

テストケース:

- `updateProductInFrontmatter()` が `offers[]` のYahoo offerを保持する。
- 楽天 offer がある場合、楽天価格更新に合わせて `offers[].price` も更新される。
- 楽天URL更新に合わせて `offers[].url` も更新される。
- Yahoo offer の `price` / `url` / `matchStatus` は変わらない。

## 11. 起こりうる更新ケースと対応方針

`update-products` は単純な価格更新だけでなく、容量補正、商品削除、並び替え、AI照合による差し替えまで行う。案2では、各ケースで `offers[]` をどう扱うかを明示する。

### ケース一覧

| ケース | 現状処理 | Yahoo offer対応 | 楽天 offer対応 | 備考 |
|---|---|---|---|---|
| 楽天価格のみ変更 | `price` 更新、`pricePerUnit` 再計算 | 維持 | 同期 | 通常ケース。Yahoo価格との比較を再計算 |
| 楽天評価/レビュー数のみ変更 | `rating` / `reviewCount` 更新 | 維持 | 変更不要 | 価格比較には影響なし |
| 楽天画像のみ変更 | `imageUrl` 更新 | 維持 | `imageUrl` 同期 | 表示画像は商品本体側を優先 |
| 楽天affiliate URLのみ変更 | `rakutenUrl` 更新 | 維持 | `url` 同期 | direct item が同じなら同一商品 |
| 楽天URLが別商品へ変更 | `rakutenUrl` / `name` / `capacity` 等が変わりうる | 無効化して再照合 | 同期 | 旧Yahoo offerを残すと誤掲載 |
| capacity変更 | `capacity` / `pricePerUnit` 更新 | 容量一致を再判定。判断不能なら無効化 | 維持/同期 | 数量変更が最も危険 |
| pricePerUnitのみ変更 | `pricePerUnit` 更新 | 維持 | 維持 | capacityが変わらないならOK |
| 商品名変更 | `newName` 更新 | 原則無効化 | 同期 | AI差し替えや商品名補正で発生 |
| AI商品差し替え | `applyAiMatchToContent()` から `updateProductInFrontmatter()` | 必ず無効化 | 新楽天情報へ同期 | 旧商品のYahooが残る最大リスク |
| 検索0件による商品削除 | `removeProductFromFrontmatter()` | 商品ごと削除 | 商品ごと削除 | 問題なし |
| rank 11以下削除 | `limitProductsByRank()` | 商品ごと削除 | 商品ごと削除 | 問題なし |
| コスパ順並び替え | `reorderProductsByPricePerUnit()` | 商品オブジェクトごと移動 | 商品オブジェクトごと移動 | 問題なし |
| title/description 件数同期 | `syncTitleProductCount()` | 影響なし | 影響なし | 問題なし |
| name/capacity矛盾修正 | `fixNameCapacityConflicts()` | capacity変更なら再判定 | 維持 | Yahoo容量との整合を確認 |
| Yahoo価格のみ変更 | `update-yahoo-products` | Yahoo offer更新 | 影響なし | Yahoo側の通常ケース |
| Yahoo候補が売切/消滅 | 現状未整備 | `available: false` または `review` | 影響なし | 表示・JSON-LDから除外 |

### 価格改定

楽天価格が変わった場合:

- `products[].price` を更新する。
- 明示的な `provider: "rakuten"` offer があれば `price` / `url` / `imageUrl` / `updatedAt` を同期する。
- Yahoo offer は維持する。
- 表示側は `getOfferPriceSummary()` で最安を再計算する。

Yahoo価格が変わった場合:

- `update-yahoo-products.mjs` が `provider: "yahoo"` offer を更新する。
- `matchStatus: matched` のofferのみ表示対象にする。
- 価格だけの変化では楽天側に影響を与えない。

### 商品差し替え

楽天側の商品が別商品に差し替わった場合、旧Yahoo offerは信頼できない。

判定条件:

- `rakutenUrl` の direct item URL が変わった。
- `newName` が設定された。
- `newCapacity` が設定され、既存容量と比較値が変わった。
- AI match の `action: replace` が適用された。

対応:

- Yahoo offer を削除するか、`available: false` + `matchStatus: "review"` にする。
- 初期実装では履歴が残る `available: false` + `matchStatus: "review"` を推奨する。
- `matchNotes` に `楽天商品差し替えのためYahoo再照合が必要` を入れる。
- 次回 `update-yahoo-products` で再照合し、matched のみ復帰させる。

### 数量変更・容量変更

容量変更は価格比較の信頼性に直結する。楽天価格が正しくても、Yahooが旧容量なら単価比較が壊れる。

対応:

- `capacity` が変わった場合、Yahoo offer の `matchedCapacity` と新 `capacity` を再比較する。
- 一致する場合は維持してよい。
- 不一致または `matchedCapacity` がない場合は `review` に落とし、表示しない。
- `pricePerUnit` は楽天基準のまま更新し、Yahoo offerの単価は初期実装では持たない。

### 商品削除・順位変更

- 商品削除では `offers[]` も商品ブロックごと消えるため追加対応不要。
- rank並び替えでは商品オブジェクトごと移動するため、offerは商品に追随する。
- rank 11以下削除でも商品ブロックごと削除されるため、offerだけが残ることはない。

### stale offer の表示禁止

表示側では以下の offer を必ず除外する。

- `available: false`
- `matchStatus: "review"`
- `matchStatus: "rejected"`
- `url` が不正
- `price` が0以下
- Yahoo feature flag OFF 時のYahoo offer

これにより、更新処理が一時的に stale offer をfrontmatterに残しても画面・JSON-LDには出ない。

## 12. update-yahoo-productsの改修

対象: `scripts/update-yahoo-products.mjs` / `scripts/lib/yahoo-offers.ts`

現状の問題:

- `parseProducts()` が正規表現で `name` / `rank` しか抽出していない。
- `capacity` / `brand` / `rakutenUrl` / 既存 `offers[]` を参照できない。
- 商品名トークン一致だけで `decision: auto` になり、容量違いを防げない。
- `upsertYahooOfferInFrontmatter()` は `provider: "yahoo"` を1件だけ更新するため、将来複数Yahoo候補を扱う設計では拡張が必要。

改修方針:

- 正規表現パースをやめ、YAML parserで `products[]` を読む。
- `name` / `rank` / `brand` / `capacity` / `rakutenUrl` / `offers` を取得する。
- Yahoo候補ごとに同一商品・同一容量チェックを実行する。
- `matched` のみ write する。
- `review` / `rejected` はレポートに残し、frontmatterへ自動追加しない。
- 既存のYahoo offerがあり、新候補が見つからない場合は即削除せず `review` へ落とすか、レポートで確認対象にする。

レポートに必須で出す項目:

- current rank
- current name
- current brand
- current capacity
- current rakutenUrl direct item
- candidate name
- candidate price
- candidate url
- candidate extracted capacity
- decision: `matched` / `review` / `rejected`
- reason

## 13. frontmatter更新ヘルパーの改修

対象: `scripts/lib/frontmatter.ts`

追加する責務:

- 楽天 offer 同期
- Yahoo offer の無効化
- offer保持テストのための snapshot 抽出

追加候補関数:

```ts
syncRakutenOffer(product, updates, updatedAt)
invalidateNonRakutenOffers(product, reason, updatedAt)
shouldInvalidateOffers(beforeSnapshot, afterSnapshot, updates)
```

無効化時の例:

```yaml
offers:
  - provider: "yahoo"
    label: "Yahoo!"
    price: 4980
    url: "https://ck.jp.ap.valuecommerce.com/..."
    available: false
    matchStatus: "review"
    matchNotes: "楽天商品の容量変更によりYahoo再照合が必要"
    updatedAt: "2026-05-18"
```

注意:

- Yahoo offer を即削除すると、後からなぜ消えたか追跡しにくい。
- 初期実装では `available: false` にして履歴を残すほうが安全。

## 14. 既存コマンド仕様の注意

現状のYahoo更新スクリプトは `--article` ではなく `--file` を使う。

```bash
pnpm update-yahoo-products:dry -- --file=toilet-paper-comparison
pnpm update-yahoo-products -- --file=toilet-paper-comparison
```

計画内の `--article` 表記は、実装時に `--file` へ統一するか、互換aliasとして `--article` を追加する。

## 15. テスト計画

対象:

- `tests/offers.test.ts`
- `tests/frontmatter.test.ts`
- 必要なら `tests/yahoo-offers.test.ts`

ケース:

- 楽天のみ商品では楽天価格を最安にする。
- 楽天 / Yahoo 両方あり、楽天が安い場合に楽天を最安にする。
- Yahooが安い場合にYahooを最安にする。
- 同価格なら `同価格` にする。
- feature flag OFF 相当ではYahooを無視する。
- `matchStatus: review` は表示・価格比較・JSON-LDから除外する。
- `matchStatus: rejected` は表示・価格比較・JSON-LDから除外する。
- `100m×60ロール` と `100m×30ロール` を `rejected` にする。
- `100m×60ロール` と `100m 60ロール` を `matched` にする。
- `offers[]` の順序が変わっても provider 別価格が正しく取得される。
- `update-products` 相当の楽天価格更新でYahoo offerが保持される。
- 楽天 offer が明示されている場合、楽天価格更新に追随する。
- 商品差し替え時にYahoo offerが `available: false` / `review` へ落ちる。
- capacity変更時に `matchedCapacity` と不一致ならYahoo offerが表示除外される。
- rank並び替えでofferが商品に追随する。
- rank削除でofferも商品ごと消える。
- `update-yahoo-products` が容量違い候補を `rejected` にする。

検証:

```bash
pnpm test
pnpm build
```

Yahoo表示あり:

```powershell
$env:PUBLIC_ENABLE_YAHOO_AFFILIATE="true"; $env:PUBLIC_NOINDEX="true"; pnpm build
```

## 16. 実装フェーズ

### Phase 1: 価格サマリーとoffer除外

- `ProductOffer` に match系 optional フィールドを追加。
- `getVisibleOffers()` で `review` / `rejected` を除外。
- provider別取得と価格サマリーヘルパーを追加。
- `tests/offers.test.ts` を更新。

完了条件:

- 楽天のみ、楽天+Yahoo、review除外、rejected除外、順序非依存のテストが通る。

### Phase 2: update-productsの楽天価格同期

- `updateProductInFrontmatter()` が `offers[]` を保持するテストを追加。
- 楽天 offer がある場合は楽天API更新に合わせて同期する。
- Yahoo offer は変更しない。
- 商品差し替え・容量変更時はYahoo offerを `review` に落とす。

完了条件:

- 楽天価格変更時に `products[].price` と明示楽天 offer がズレない。
- Yahoo offer が保持される。
- 別商品への差し替え時に旧Yahoo offerが表示されない。

### Phase 3: update-yahoo-productsの同一性判定

- 正規表現の `parseProducts()` をYAML parserベースに変更。
- `brand` / `capacity` / `rakutenUrl` / 既存offersを読めるようにする。
- 容量判定と商品名判定を追加。
- `matched` のみ write する。
- `review` / `rejected` をレポートに出す。

完了条件:

- `100m×60ロール` に対する `100m×30ロール` 候補が `rejected`。
- capacity不明候補が `review`。
- matched だけが表示対象としてfrontmatterに入る。

### Phase 4: UI表示

- `ComparisonTableSort.tsx` で最安価格・楽天価格・Yahoo価格を表示。
- 価格ソートを最安価格ベースに変更。
- `ProductCard.astro` で価格併記。
- `TopPickCta.astro` と `ArticleLayout.astro` を価格サマリー対応。
- `AffiliateLink.astro` は表示用propsだけ追加。

完了条件:

- feature flag OFF で楽天のみ表示。
- feature flag ON で楽天 / Yahoo 価格併記。
- PC / モバイルでレイアウトが崩れない。

### Phase 5: JSON-LDとSEO整合

- 画面表示の最安 offer と JSON-LD offer を一致させる。
- review / rejected offer を JSON-LD に出さない。
- 価格注釈とアフィリエイト表記は維持する。

完了条件:

- `pnpm build` が通る。
- HTML内の Product JSON-LD の価格・URLが画面表示と矛盾しない。

### Phase 6: toilet-paper で実データ検証

手順:

```bash
pnpm update-yahoo-products:dry -- --file=toilet-paper-comparison
```

レポート確認後:

```bash
pnpm update-yahoo-products -- --file=toilet-paper-comparison
pnpm test
pnpm build
```

確認:

- rank1 の容量違い候補が `rejected` または `review` になる。
- rank3 / rank7 / rank10 は容量一致なら `matched`。
- rank8 は高いだけでは削除せず、同一商品なら表示される。
- 比較表、商品カード、CTA、JSON-LD の価格が一致する。

## 17. 変更ファイル一覧

想定:

| ファイル | 内容 |
|---|---|
| `src/lib/offers.ts` | match系フィールド、provider別取得、最安価格サマリー |
| `src/content.config.ts` | match系フィールドをZod schemaへ追加 |
| `src/components/product/ComparisonTableSort.tsx` | 最安価格・価格併記・最安バッジ |
| `src/components/product/ProductCard.astro` | 最安価格・価格併記・最安バッジ |
| `src/components/product/TopPickCta.astro` | 最安価格表示 |
| `src/components/product/AffiliateLink.astro` | 価格・最安バッジ表示props |
| `src/layouts/ArticleLayout.astro` | 結論CTAとJSON-LDを最安offer対応 |
| `scripts/update-yahoo-products.mjs` | 同一商品・同一容量チェック |
| `scripts/update-products.mjs` | 楽天価格更新時の楽天 offer 同期確認 |
| `scripts/lib/frontmatter.ts` | 容量抽出ロジックの再利用整理、楽天offer同期、Yahoo offer無効化 |
| `scripts/lib/yahoo-offers.ts` | matchStatus付きYahoo offer upsert、review/rejected制御 |
| `tests/offers.test.ts` | 価格サマリーと除外判定テスト |
| `tests/frontmatter.test.ts` | 容量判定テスト |
| `src/content/articles/toilet-paper-comparison.md` | 検証後、matched offerのみ反映 |

## 18. リスクと対策

| リスク | 対策 |
|---|---|
| Yahoo候補が容量違い | 容量不一致は `rejected` |
| 容量が抽出できない | `review` として自動表示しない |
| `offers[]` 順序で誤判定 | provider別取得に統一 |
| 楽天価格更新後に楽天 offer が古くなる | `update-products` で楽天 offer を同期 |
| 商品差し替え後に旧Yahoo offerが残る | 非楽天offerを `available:false` / `review` に落とす |
| 容量変更後にYahooだけ旧容量になる | `matchedCapacity` と再比較し、不一致なら表示除外 |
| Yahooスクリプトが容量を読めない | 正規表現パースを廃止しYAML parserでproductsを読む |
| 画面価格とJSON-LD価格がズレる | 共通価格サマリーヘルパーを使う |
| Yahooが高くてクリック率が落ちる | 最安バッジで主導線を明示しつつ、Yahoo派の選択肢を残す |
| 楽天のみ記事が壊れる | 楽天 fallback と optional offers を維持 |
| feature flag OFF で表示が変わる | OFF時はYahoo offerを完全除外 |

## 19. 最終チェックリスト

- [ ] `pnpm test` が通る
- [ ] `pnpm build` が通る
- [ ] feature flag OFF で楽天のみ表示
- [ ] feature flag ON で楽天 / Yahoo価格併記
- [ ] 最安バッジが正しい
- [ ] 価格ソートが最安価格ベース
- [ ] review / rejected offer が表示されない
- [ ] review / rejected offer がJSON-LDに出ない
- [ ] `update-products` 実行相当でYahoo offerが保持される
- [ ] 明示楽天 offer がある場合、楽天価格更新に追随する
- [ ] 商品差し替え時に旧Yahoo offerが表示されない
- [ ] 容量変更時にYahoo offerが再判定される
- [ ] Yahoo更新スクリプトが `capacity` を読んで判定する
- [ ] toilet-paper rank1 の容量違い疑いが自動採用されない
- [ ] モバイルで価格・ボタンが崩れない

## 20. 推奨実装順

1. `src/lib/offers.ts` と `tests/offers.test.ts`
2. `src/content.config.ts`
3. `scripts/lib/frontmatter.ts` の楽天 offer 同期
4. `scripts/lib/frontmatter.ts` のYahoo offer無効化
5. `scripts/update-yahoo-products.mjs` / `scripts/lib/yahoo-offers.ts`
6. `ComparisonTableSort.tsx`
7. `ProductCard.astro`
8. `TopPickCta.astro` / `ArticleLayout.astro`
9. `toilet-paper-comparison.md` で dry-run 検証
10. `pnpm test`
11. `pnpm build`

この順序なら、表示ロジックとYahoo候補チェックを段階的に検証でき、既存楽天運用への影響を最小化できる。
