# Yahoo価格併記・同一商品チェック 実装計画

対象: KuraSelect の比較記事における楽天 / Yahoo!ショッピング価格表示

目的: 案2「同じ商品で楽天価格・Yahoo価格をそれぞれ表示」を採用し、読者が価格差を見て購入先を選べる状態にする。同時に、Yahoo候補が楽天商品と同一商品・同一容量であることを機械的にチェックし、容量違いの誤掲載を防ぐ。

## 1. 採用方針

案2を採用する。

表示イメージ:

```text
1位 商品A
最安: 楽天 5,300円
楽天価格: 5,300円
Yahoo価格: 5,350円
楽天が安い
[楽天市場で見る] [Yahoo!ショッピングで見る]
```

理由:

- 「コスパ比較」記事として価格透明性が高く、読者の信頼を得やすい。
- 楽天派・Yahoo派の両方を取りこぼしにくい。
- 最安だけを出す案1より、購入ボタンの選択肢が残るため収益機会が広い。
- 価格差が小さい場合も、ポイント還元や普段使う経済圏で選びたい読者に対応できる。

## 2. 現状

すでに存在する実装:

- `src/content.config.ts`
  - `products[].offers[]` が optional で定義済み。
- `src/lib/offers.ts`
  - 楽天 fallback offer 生成。
  - Yahoo feature flag による表示制御。
  - `getVisibleOffers()` / `getPrimaryOffer()`。
- `src/components/product/AffiliateLink.astro`
  - 楽天 / Yahoo の共通アフィリエイトリンク。
- `src/components/product/ComparisonTable.astro`
  - `visibleOffers` を作って `ComparisonTableSort.tsx` に渡している。
- `src/components/product/ComparisonTableSort.tsx`
  - 購入欄に楽天 / Yahoo ボタンを表示可能。
- `scripts/update-yahoo-products.mjs`
  - Yahoo offer を frontmatter に追加・更新するスクリプト。

課題:

- 表示上、楽天価格とYahoo価格の併記がまだ弱い。
- `product.price` が楽天価格前提のままなので、Yahooが安い場合の「最安」が読者に伝わりにくい。
- Yahoo候補が同一商品・同一容量かを保証するチェックが不足している。
- 例: `toilet-paper-comparison.md` の1位は楽天 `100m×60ロール` に対し、Yahoo URL が `mori100ms30` に見え、容量違いの可能性がある。

## 3. ゴール

- 比較表・商品カード・1位CTAで楽天価格 / Yahoo価格を併記する。
- 最安販売元と価格差を表示する。
- Yahoo候補が同一商品・同一容量と判断できない場合は、自動表示しない。
- 同一性チェックの結果を frontmatter またはレポートに残し、目視確認しやすくする。
- 既存の楽天のみ記事は壊さない。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=false` の場合は従来通り楽天中心表示に戻る。
- `pnpm test` / `pnpm build` が通る。

## 4. 非ゴール

- 全記事へのYahoo offer一括投入。
- `products[].rakutenUrl` の削除。
- `products[].price` の即時廃止。
- 楽天更新スクリプトとYahoo更新スクリプトの統合。
- ポイント還元込みの実質価格計算。
- Amazonなど他モール対応。

## 5. データモデル方針

既存の `products[].price` は当面「楽天基準価格」として残す。

`offers[]` を販売元別価格の正とする。

```yaml
products:
  - rank: 1
    name: "商品名"
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
```

追加候補フィールド:

| フィールド | 場所 | 目的 |
|---|---|---|
| `matchStatus` | `offers[]` | `matched` / `review` / `rejected` |
| `matchConfidence` | `offers[]` | `high` / `medium` / `low` |
| `matchedCapacity` | `offers[]` | Yahoo候補から抽出した容量 |
| `matchNotes` | `offers[]` | 判定理由の短文 |

初期実装では `matchStatus` だけでもよい。ただし、将来のレビュー効率を考えると `matchedCapacity` と `matchNotes` も入れる。

## 6. 同一商品・同一容量チェック仕様

### 6.1 判定対象

Yahoo候補ごとに以下を比較する。

- 既存記事の商品名 `product.name`
- 既存記事のブランド `product.brand`
- 既存記事の容量 `product.capacity`
- Yahoo候補の商品名
- Yahoo候補の商品説明または追加フィールド
- Yahoo候補URL / itemCode

### 6.2 容量抽出

既存の `scripts/lib/frontmatter.ts` にある容量抽出ロジックを再利用する。

方針:

- 新規に別ロジックを乱立させない。
- `extractCapacityTotal` 相当の関数を Yahoo 判定でも使えるように export / wrapper 化する。
- `100m×60ロール`、`170m×48ロール`、`150m 48ロール`、`30ロール` など表記ゆれを正規化する。

判定例:

| 楽天 capacity | Yahoo候補 | 判定 |
|---|---|---|
| `100m×60ロール` | `100m 60ロール` | matched |
| `100m×60ロール` | `100m 30ロール` | rejected |
| `170m×48ロール` | `170m 48個入` | matched |
| `150m×48ロール` | `48ロール` のみ | review |
| `250m×16ロール` | 容量不明 | review |

### 6.3 商品名・ブランド判定

最低条件:

- ブランドまたは主要ブランド語が一致する。
- 商品名の主要トークンが一定数一致する。
- 明確な別SKU語があれば rejected にする。

別SKU語の例:

- `30ロール` vs `60ロール`
- `ダブル` vs `シングル`
- `香り付き` vs `無香料`
- `詰め替え` vs `本体`
- `大容量` と通常容量の混在

### 6.4 自動採用ルール

自動で `available: true` として表示できる条件:

- `matchStatus: matched`
- 容量合計が一致する、または同等と判断できる。
- ブランド / 商品名スコアがしきい値以上。
- Yahoo price が正の整数。
- Yahoo affiliate URL が有効。

自動表示しない条件:

- `matchStatus: review` または `rejected`
- 容量不一致。
- 容量不明で商品名だけでは同一性を判断できない。
- URLが無効。
- price が欠落または0以下。

## 7. 表示仕様

### 7.1 共通ヘルパー

`src/lib/offers.ts` に以下を追加する。

- `getOfferPriceSummary(product, options)`
- `getLowestOffer(product, options)`
- `getOfferByProvider(product, provider, options)`
- `getPriceDifferenceLabel(summary)`

戻り値イメージ:

```ts
{
  offers: ProductOffer[];
  rakutenOffer: ProductOffer | null;
  yahooOffer: ProductOffer | null;
  lowestOffer: ProductOffer | null;
  priceLabel: "楽天が50円安い" | "Yahoo!が50円安い" | "同価格";
}
```

注意:

- `available: false`、`matchStatus: review`、`matchStatus: rejected` の offer は価格比較に使わない。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=false` の場合、Yahoo価格も表示しない。

### 7.2 比較表

対象: `src/components/product/ComparisonTableSort.tsx`

変更内容:

- 価格列を「最安価格」に変更する。
- 楽天価格 / Yahoo価格を同じセル内で併記する。
- 最安販売元に小さなバッジを付ける。
- 価格ソートは最安価格で並べる。

PC表示例:

```text
最安価格
¥5,300 楽天
楽天 ¥5,300 / Yahoo ¥5,350
楽天が50円安い
```

モバイル表示例:

```text
最安 ¥5,300 楽天
楽天 ¥5,300
Yahoo ¥5,350
```

### 7.3 商品カード

対象: `src/components/product/ProductCard.astro`

変更内容:

- 現在の価格表示を「最安価格」中心にする。
- 楽天 / Yahoo の価格を並べて表示する。
- 価格差ラベルを表示する。
- ボタンは両方残す。

### 7.4 1位CTA / 記事内結論CTA

対象:

- `src/components/product/TopPickCta.astro`
- `src/layouts/ArticleLayout.astro`

変更内容:

- `product.price` ではなく価格サマリーから最安価格を表示する。
- 「楽天が安い」「Yahoo!が安い」「同価格」を短く表示する。
- ボタンは楽天 / Yahoo の両方を表示する。

### 7.5 JSON-LD

対象: `src/layouts/ArticleLayout.astro`

変更内容:

- `getPrimaryOffer()` は楽天優先ではなく、価格比較に使える最安 offer を返す設計に変更するか、新規 `getStructuredDataOffer()` を作る。
- Yahoo feature flag OFF では楽天 offer を使う。
- feature flag ON では `matchStatus: matched` の最安 offer を使う。

注意:

- `review` / `rejected` の offer を JSON-LD に出さない。
- 構造化データ上の価格と画面表示の最安価格を一致させる。

## 8. スクリプト改修

対象: `scripts/update-yahoo-products.mjs`

変更内容:

- Yahoo候補取得後に同一商品・同一容量チェックを実行する。
- 判定結果を dry-run / write レポートに出す。
- `matched` のみ write 対象にする。
- `review` はレポートに残すが、frontmatter へ自動追加しない。
- `rejected` は理由だけレポートに残す。

レポート例:

```text
### rank 1: 森を守ろう トイレットペーパー シングル
- rakuten capacity: 100m×60ロール
- yahoo candidate: 森を守ろう 100m 30ロール
- yahoo capacity: 100m×30ロール
- decision: rejected
- reason: ロール数が一致しない
```

write例:

```yaml
offers:
  - provider: "yahoo"
    label: "Yahoo!"
    price: 5350
    url: "..."
    available: true
    updatedAt: "2026-05-18"
    matchStatus: "matched"
    matchConfidence: "high"
    matchedCapacity: "100m×60ロール"
    matchNotes: "容量合計と主要商品名が一致"
```

## 9. テスト計画

追加・更新対象:

- `tests/offers.test.ts`
- `tests/frontmatter.test.ts`
- 必要なら `tests/yahoo-offers.test.ts` を新規追加

テストケース:

- 楽天のみ商品では従来通り楽天価格を返す。
- 楽天 / Yahoo 両方あり、楽天が安い場合に楽天を最安とする。
- Yahooが安い場合にYahooを最安とする。
- 同価格の場合に「同価格」とする。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=false` 相当ではYahooを無視する。
- `matchStatus: review` のYahoo offerは表示・価格比較に使わない。
- `matchStatus: rejected` のYahoo offerは表示・価格比較に使わない。
- `100m×60ロール` と `100m×30ロール` を容量不一致として rejected にする。
- `100m×60ロール` と `100m 60ロール` を一致として matched にする。

検証コマンド:

```bash
pnpm test
pnpm build
```

Yahoo表示確認:

```bash
$env:PUBLIC_ENABLE_YAHOO_AFFILIATE="true"; pnpm build
```

## 10. 実装フェーズ

### Phase 1: offer型と価格サマリー

- `src/lib/offers.ts` の `ProductOffer` に match系 optional フィールドを追加。
- `getVisibleOffers()` で `review` / `rejected` を除外。
- 価格サマリーヘルパーを追加。
- `tests/offers.test.ts` を更新。

完了条件:

- 楽天のみ / 楽天+Yahoo / review除外 / rejected除外のテストが通る。

### Phase 2: 表示コンポーネント

- `ComparisonTableSort.tsx` で最安価格・楽天価格・Yahoo価格を表示。
- 価格ソートを最安価格ベースに変更。
- `ProductCard.astro` で価格併記。
- `TopPickCta.astro` と `ArticleLayout.astro` の結論CTAを価格サマリー対応。

完了条件:

- `PUBLIC_ENABLE_YAHOO_AFFILIATE=false` で楽天のみ表示。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=true` で価格併記表示。
- モバイル表示で価格・ボタンが崩れない。

### Phase 3: 同一商品・同一容量チェック

- 容量正規化ヘルパーを `scripts/lib` 配下に整理。
- `update-yahoo-products.mjs` に match判定を追加。
- dry-run レポートに `matched` / `review` / `rejected` と理由を出す。
- write は `matched` のみに限定。

完了条件:

- `toilet-paper-comparison.md` の容量違い候補が `rejected` になる。
- 容量一致候補だけ `offers[]` に書き込まれる。

### Phase 4: JSON-LDとSEO整合

- 画面表示の最安 offer と JSON-LD の offer を一致させる。
- review / rejected offer を JSON-LD に出さない。
- 記事下部の免責文は維持する。

完了条件:

- `pnpm build` が通る。
- 生成HTML内の Product JSON-LD が valid な価格・URLを持つ。

### Phase 5: 個別記事で検証

最初の対象:

- `src/content/articles/toilet-paper-comparison.md`

手順:

```bash
pnpm update-yahoo-products:dry -- --article=toilet-paper-comparison
```

レポート確認後、問題なければ:

```bash
pnpm update-yahoo-products -- --write --article=toilet-paper-comparison
pnpm test
pnpm build
```

確認観点:

- 1位の容量違い候補が自動採用されない。
- 容量一致した商品だけYahoo価格が表示される。
- 楽天価格 / Yahoo価格 / 最安表示が矛盾しない。
- CTAと比較表と商品カードの価格が一致する。

## 11. リスクと対策

| リスク | 対策 |
|---|---|
| Yahoo候補が容量違い | 容量一致しない場合は `rejected` |
| 容量が抽出できない | `review` にして自動表示しない |
| 価格表示とJSON-LDがズレる | 共通価格サマリーヘルパーを使う |
| 楽天のみ記事が壊れる | `offers` optional、楽天 fallback 維持 |
| Yahoo feature flag OFFで表示が変わる | OFF時はYahooを完全除外 |
| 価格差が数円で過剰訴求になる | 「安い」は機械表示に留め、本文で断定しない |

## 12. 実装順序の推奨

1. `src/lib/offers.ts` と `tests/offers.test.ts`
2. `ComparisonTableSort.tsx`
3. `ProductCard.astro` / `TopPickCta.astro` / `ArticleLayout.astro`
4. `scripts/update-yahoo-products.mjs`
5. `toilet-paper-comparison.md` で dry-run 検証
6. `pnpm test`
7. `pnpm build`

この順序なら、表示側とデータチェック側を分けて検証でき、既存楽天運用への影響を最小化できる。
