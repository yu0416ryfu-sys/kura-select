# 価格・購入UI 統合表示 実装計画

## 目的

比較表の「最安価格」と「購入」導線を近づけ、どのショップが最安なのかを一目で分かるようにする。

現状は「最安」ラベルが最安価格欄に単独で表示されるため、楽天市場とYahoo!ショッピングのどちらが最安なのか、また同価格なのかが分かりにくい。

## 目標UI

ショップ別に価格と購入ボタンを同じ行へ並べる。

```text
価格・購入
最安 ¥780  Yahoo!で購入
     ¥800  楽天市場で購入
```

同価格の場合は両方に最安ラベルを表示する。

```text
価格・購入
最安 ¥582  楽天市場で購入
最安 ¥582  Yahoo!で購入
```

## 対象ファイル

- `src/components/product/ComparisonTableSort.tsx`
- 必要に応じて `src/components/product/ProductCard.astro`

まずは比較表を主対象にする。商品カード側は比較表の表示確認後、必要なら横展開する。

## 実装方針

### 1. 価格行データを生成する

`ComparisonTableSort.tsx` 内で、`visibleOffers` を主ループ基準にして表示用の行データを作る。

`priceSummary.priceRows` は `priceRows.find((row) => row.provider === offer.provider)` で価格を補完する。購入ボタンには有効なURLが必須のため、価格データだけを基準にしない。

現行の `getOfferPriceSummary()` は内部で `getVisibleOffers()` を経由するため、通常の生成経路では `priceRows` は `visibleOffers` の価格付きサブセットになる。ただし `ComparisonTableSort.tsx` のpropsはoptionalな型なので、実装側では不整合に耐える。

必要な値:

- `provider`
- `price`
- `url`
- `label`
- `isLowest`

`isLowest` は `priceSummary.lowestPrice !== null && row.price === priceSummary.lowestPrice` で判定する。これにより同額最安の場合、楽天市場とYahoo!ショッピングの両方に「最安」を表示できる。

`lowestPrice === null` または行の価格が未取得の場合は「最安」ラベルを表示しない。

価格未取得時の表示:

- 楽天市場: `row.price` がなければ既存の `product.price` をフォールバック表示できる
- Yahoo!: `product.price` は楽天側の旧価格である可能性が高いため流用しない
- 価格が表示できない行は、価格部分を「価格確認」などにして購入ボタンのみ有効にする

### 2. PCテーブルの列構成を変更する

現在:

- 最安価格
- 容量
- コスパ
- 評価
- 購入

変更後:

- 価格・購入
- 容量
- コスパ
- 評価

独立した「購入」列は削除し、「価格・購入」セル内にショップ別の購入ボタンを表示する。

「価格・購入」列は価格とボタンを横並びにするため、`min-w-[240px]` から `min-w-[280px]` 程度を目安に確保する。テーブル全体は既存の `overflow-x-auto` を活かし、狭いPC幅では横スクロールで崩れを防ぐ。

行内レイアウトは以下を目安にする。

- 最安ラベル領域: 幅を固定または `invisible` で占有し、価格の開始位置を揃える
- 価格領域: `tabular-nums` 相当の指定を検討する
- ボタン領域: `whitespace-nowrap` を維持し、短い文言で幅を抑える

ソートキーは現状通り `price` のまま、基準は `priceSummary.lowestPrice ?? product.price` とする。表示名は列ヘッダーとのズレを避けるため、ソートボタンを「最安価格順」から「安い順」または「価格順」に変更する。

### 3. 価格・購入セルの表示

複数ショップがある場合:

```text
最安 ¥780  Yahoo!で購入
     ¥800  楽天市場で購入
```

単一ショップのみの場合:

```text
¥980  楽天市場で購入
```

価格が取れないが購入URLはある場合は、楽天市場行のみ既存の `product.price` をフォールバック候補にする。Yahoo!行には楽天側の旧価格を流用せず、「価格確認」などの表示にする。

### 4. モバイルカードの表示を揃える

現在は価格表示と購入ボタンが分かれているため、モバイルでもショップ別の価格・購入行として表示する。

スマホでは横幅が狭いため、1行内のボタンは短めの文言にする。

- 楽天市場で購入
- Yahoo!で購入

必要ならボタン幅は固定せず、価格側とボタン側を `grid` または `flex` で自然に折り返す。

### 5. 既存仕様を維持する

以下は変更しない。

- `rel="sponsored nofollow noopener"`
- `target="_blank"`
- `data-ga-event`
- `data-ga-provider`
- `data-ga-product`
- `PUBLIC_ENABLE_YAHOO_AFFILIATE` によるYahoo!表示制御
- `price` ソートの基準
- frontmatterスキーマ

ボタン文言は、比較表内では意図的に「見る」から「購入」へ寄せる。価格と購入導線を一体化したUIであることを明確にするため。

## 注意点

### 同額最安

現状の `lowestProvider` は1つのproviderのみを返すため、同価格の場合に片方だけ「最安」表示になりやすい。

今回のUIでは `lowestProvider` ではなく `price === lowestPrice` を使う。

`lowestBadgeCls` は単一の `lowestProvider` ではなく、各価格行の `provider` を受け取って色を決める形にする。同額最安では楽天市場行とYahoo!行の両方に、それぞれのprovider色で「最安」を表示する。

### コスパ表示

`pricePerUnit` は既存データの算出前提が楽天価格寄りの可能性があるため、今回の変更では触らない。

Yahoo!が最安の場合のコスパ再計算は別タスクに分ける。

### ラベル文言

ヘッダーは「最安価格」ではなく「価格・購入」にする。

「最安価格」のままだと、最安ではないショップ価格も同じ列に並ぶため意味がずれる。

## 確認項目

- 楽天のみの商品で表示が崩れない
- 楽天とYahoo!の両方がある商品で2行表示される
- Yahoo!の方が安い場合、Yahoo!行だけに「最安」が付く
- 楽天の方が安い場合、楽天行だけに「最安」が付く
- 同額の場合、両方に「最安」が付く
- PCテーブルで横幅が破綻しない
- モバイルカードで価格、ラベル、購入ボタンが重ならない
- アフィリエイト属性とGA属性が維持される

## 検証コマンド

```bash
pnpm test
pnpm build
```

必要に応じて開発サーバーで対象記事を確認する。

```bash
pnpm dev
```
