# 価格比較表示（案2）実装プラン

楽天・Yahoo! 両方の価格を並べて表示し、安い方を「最安」バッジで強調する。
どちらをクリックしてもアフィリエイト収益になり、ユーザーが安心して購入先を選べる。

---

## 現状と課題

| rank | 楽天価格 | Yahoo価格 | 状態 |
|------|----------|-----------|------|
| 1 | 3,550円 | 3,500円 | ⚠️ Yahoo URL が30ロール品（楽天は60ロール）→ SKU不一致 |
| 2 | 4,980円 | なし | offers 未設定 |
| 3 | 5,130円 | 5,130円 | OK |
| 4 | 5,148円 | なし | offers 未設定 |
| 5 | 4,840円 | なし | offers 未設定 |
| 6 | 4,980円 | なし | offers 未設定 |
| 7 | 5,038円 | 4,980円 | OK |
| 8 | 3,532円 | 5,300円 | ⚠️ Yahoo が1,768円高い |
| 9 | 2,981円 | なし | offers 未設定 |
| 10 | 4,235円 | 4,235円 | OK |

---

## フェーズ1: データ整備（UI実装の前提）

### 1-1. 既存 offer の修正（手作業）

**rank 1**
Yahoo の `vc_url` が `mori100ms30.html`（30ロール）になっている。
楽天商品（60ロール）に対応する Yahoo 出品の URL に差し替えるか、offer を削除する。

**rank 8**
Yahoo 価格（5,300円）が楽天（3,532円）より大幅に高く、比較表示すると逆効果。
offer を削除する。

### 1-2. 未設定 rank への offer 展開

```bash
# dry-run で候補を確認
pnpm update-yahoo-products:dry -- --file=toilet-paper*

# レポートで誤マッチを目視確認してから write
pnpm update-yahoo-products -- --file=toilet-paper*
```

目標: 全10商品のうち8商品以上に offers を設定する。

---

## フェーズ2: 価格比較ロジック

### 新規ファイル: `src/lib/priceComparison.ts`

```typescript
type Provider = "rakuten" | "yahoo";

export interface PriceComparison {
  rakutenPrice: number;
  yahooPrice: number | null;
  cheaper: Provider | "equal" | null; // null = Yahooデータなし
  diff: number;                        // yahooPrice - rakutenPrice（正 = Yahoo高い）
}

export function comparePrices(
  rakutenPrice: number,
  yahooPrice?: number
): PriceComparison {
  if (yahooPrice == null) {
    return { rakutenPrice, yahooPrice: null, cheaper: null, diff: 0 };
  }
  const diff = yahooPrice - rakutenPrice;
  const cheaper: Provider | "equal" =
    Math.abs(diff) <= 100 ? "equal" : diff > 0 ? "rakuten" : "yahoo";
  return { rakutenPrice, yahooPrice, cheaper, diff };
}
```

差額が100円以下は「ほぼ同額」とする（全価格帯の2〜3%相当）。

---

## フェーズ3: UI実装

### 表示パターン

| 状況 | 楽天ボタン | Yahoo ボタン |
|------|-----------|-------------|
| Yahooデータなし | 現状のまま | 非表示 |
| 楽天が安い | ★最安 バッジ + 価格 | 価格のみ |
| Yahooが安い | 価格のみ | ★最安 バッジ + 価格 |
| ほぼ同額（±100円） | 価格のみ | 価格のみ（バッジなし） |

デザインイメージ（モバイル）:

```
┌─────────────────────┐  ┌─────────────────────┐
│ ★最安  楽天市場      │  │       Yahoo!         │
│       ¥5,300        │  │      ¥5,350          │
└─────────────────────┘  └─────────────────────┘
```

### 3-1. `src/components/product/AffiliateLink.astro`

変更内容:
- Props に `price?: number`（楽天価格）と `comparison?: PriceComparison` を追加
- ボタン内に価格を表示（`¥X,XXX` 形式）
- `comparison.cheaper === provider` のとき「★最安」バッジを追加
- バッジカラーは `--color-accent`

### 3-2. `src/components/product/ComparisonTableSort.tsx`

変更内容（PC テーブルのボタン列）:
- `comparePrices()` を呼び出して `PriceComparison` を生成
- ボタン下に価格を表示
- 安い方のボタンにバッジを付与
- `items-stretch` は維持（現状のボタン高さ統一を維持）

### 3-3. `src/layouts/ArticleLayout.astro`

変更内容:
- 各 product に対して `comparePrices(product.price, product.offers?.[0]?.price)` を呼び出す
- `AffiliateLink` に `comparison` を渡す

---

## フェーズ4: ビルド・動作検証

```bash
PUBLIC_ENABLE_YAHOO_AFFILIATE=true PUBLIC_NOINDEX=true pnpm build
pnpm preview
```

確認チェックリスト:
- [ ] 価格が正しく表示されている（楽天・Yahoo）
- [ ] 安い方に「★最安」バッジが付いている
- [ ] ほぼ同額の商品はバッジなし
- [ ] Yahooデータなし商品は楽天ボタンのみ（レイアウト崩れなし）
- [ ] モバイル・PC 両方でレイアウト正常
- [ ] Yahoo ボタンを押して正しい商品ページに飛ぶ（全商品）
- [ ] Lighthouse Performance 95+ を維持
- [ ] `pnpm test` グリーン

---

## フェーズ5: 本番デプロイ

```bash
git add src/ docs/
git commit -m "価格比較表示（案2）実装：楽天・Yahoo最安バッジ追加"
git push origin main
```

---

## 変更ファイル一覧

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `src/lib/priceComparison.ts` | 新規 | 価格比較ロジック |
| `src/components/product/AffiliateLink.astro` | 改修 | 価格・最安バッジ表示 |
| `src/components/product/ComparisonTableSort.tsx` | 改修 | 価格・最安バッジ表示（PCテーブル） |
| `src/layouts/ArticleLayout.astro` | 改修 | `comparePrices()` 呼び出し・Props渡し |
| `src/content/articles/toilet-paper-comparison.md` | データ修正 | rank1/8 offer修正、rank2/4/5/6/9 offer追加 |
| `tests/priceComparison.test.ts` | 新規 | `comparePrices()` のユニットテスト |

---

## リスクと制約

- **Zod スキーマ変更不要**: `offers[].price` は既存フィールド
- **新規 island 追加なし**: 既存の `ComparisonTableSort`（`client:visible`）に変更を加えるのみ
- **feature flag 対応**: `PUBLIC_ENABLE_YAHOO_AFFILIATE=false` 環境では Yahoo ボタン自体が非表示のため、比較表示も自動的に非表示になる
- **Yahoo offer なし商品**: 楽天ボタンのみ表示（現状維持）。既存ユーザー体験を壊さない
- **価格の鮮度**: `update-yahoo-products` で定期更新するが、リアルタイム価格ではない旨を「価格表記について」注釈に追記する

---

## 作業順序サマリー

```
1. rank 1 Yahoo offer → SKU確認・差し替えまたは削除
2. rank 8 Yahoo offer → 削除
3. rank 2/4/5/6/9 → pnpm update-yahoo-products:dry → 確認 → write
4. src/lib/priceComparison.ts 作成
5. tests/priceComparison.test.ts 作成・通過確認
6. AffiliateLink.astro 改修
7. ArticleLayout.astro 改修
8. ComparisonTableSort.tsx 改修
9. pnpm build → pnpm preview で全商品確認
10. git push → 本番デプロイ
```
