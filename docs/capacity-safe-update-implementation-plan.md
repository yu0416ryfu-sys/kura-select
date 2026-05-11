# capacity 安全更新・AI確認フロー 実装指示書

最終更新: 2026-05-11

## 目的

`pnpm update-products` 実行時に、楽天 API の商品名から誤った `capacity` / `pricePerUnit` が自動反映されることを防ぐ。

同時に、記事追加時に AI が比較的正確に判断した既存 `capacity` を壊さず、怪しい商品だけを AI 確認に回して精度を上げる。

最優先は「正しい情報を増やす」より先に「不確実な情報を公開しない」こと。

## 前提

- 楽天商品ページ HTML の大量巡回・高頻度スクレイピングはしない。
- 通常更新では楽天 Web Service API で取得できる情報を使う。
- AI 確認は全商品ではなく、ルール判定で怪しい商品だけに限定する。
- 記事作成時に AI が入力した既存 `capacity` は、まず信頼資産として扱う。
- 既存 `capacity` が解析可能なら、API 商品名から容量が取れないだけで削除・上書きしない。

## 対象ファイル

- `scripts/lib/frontmatter.ts`
- `scripts/update-products.mjs`
- `tests/frontmatter.test.ts`
- 必要に応じて `docs/update-products-spec.md`

## 実装ゴール

1. `capacity` の自動更新に信頼度ゲートを入れる。
2. `pricePerUnit` は確実な `capacity` に基づく場合だけ更新する。
3. 既存 md の `capacity` を原則維持する。
4. 怪しい商品を `reports/` に出力する。
5. AI 確認用の小さい JSONL を生成する。
6. 初期運用では、AI 判定の自動反映までは行わない。

## 推奨実装順

### 1. capacity 解析結果に信頼度を追加

既存の `extractCapacityFromItemName(itemName): string | null` は互換性維持のため残す。

新規に安全判定用の関数を追加する。

```ts
export type CapacityConfidence = "high" | "medium" | "low";

export interface CapacityAnalysis {
  capacity: string | null;
  total: { total: number; unit: string } | null;
  normalizedTotal: { total: number; unit: string } | null;
  confidence: CapacityConfidence;
  reasons: string[];
  shouldAutoUpdate: boolean;
}

export function analyzeCapacityFromItemName(itemName: string): CapacityAnalysis
```

判定目安:

- `high`
  - 容量候補が 1 つだけ
  - `500mL`, `400mL×3`, `30枚`, `12ロール×4パック` など、既存ロジックで合計値を安定算出できる
  - 選択式・複数容量・本体+詰替などの曖昧語がない
- `medium`
  - 既存 `capacity` と整合するが、商品名だけではやや曖昧
  - 販売数量らしき表記だが、既存値との矛盾はない
- `low`
  - 複数容量候補がある
  - `選べる`, `セット`, `詰め合わせ`, `本体+詰替`, `お試し`, `各種`, `サイズ選択` などを含む
  - 容量ではなく販売個数だけを拾った可能性が高い
  - 既存 `capacity` と API 抽出値が大きく矛盾する
  - API 商品名から `capacity` を抽出できない

### 2. 既存 capacity を尊重する更新ルールに変更

`update-products.mjs` の capacity 更新処理を次の方針にする。

自動更新してよい:

- API 取得方法が `[Item/Get]`
- `analyzeCapacityFromItemName(data.name).confidence === "high"`
- 既存 `capacity` がない、または既存値と同単位で整合する
- 複数容量バリエーションではない

自動更新しない:

- confidence が `medium` または `low`
- API 商品名から `capacity` が取れない
- 既存 `capacity` と API 抽出値が矛盾する
- 既存 `capacity` が解析可能で、API 抽出値のほうが弱い
- 商品名に複数容量・選択式・詰め合わせ系の疑いがある

重要:

- API 商品名から容量が取れない場合でも、既存 `capacity` が解析可能なら維持する。
- 既存 `capacity` 維持時は、API 価格だけ更新し、既存 `capacity` で `pricePerUnit` を再計算してよい。
- ただし既存 `capacity` 自体に矛盾疑いがある場合は `pricePerUnit` も更新保留にする。

### 3. pricePerUnit 更新を capacity 判定と連動させる

`pricePerUnit` 更新可:

- 既存 `capacity` が解析可能
- または high confidence の API 抽出 `capacity` に更新した
- API 価格が取得できている

`pricePerUnit` 更新不可:

- `capacity` が `medium` / `low`
- `capacity` が販売数量か内容量か曖昧
- 既存値と API 抽出値が矛盾する
- 複数容量バリエーション商品

初期実装では、不確実な場合は既存 `pricePerUnit` を維持する。
`"-"` に置き換えるのは表示影響が大きいため、後続判断とする。

### 4. capacity 要確認レポートを生成

`pnpm update-products` と `pnpm update-products:dry` の両方で、怪しい商品をレポートに出す。

出力先:

```text
reports/capacity-review-YYYY-MM-DD.md
```

記載項目:

```md
## src/content/articles/mask-comparison.md

### 商品名
- 現在 name: ...
- 現在 capacity: 50枚
- 現在 pricePerUnit: 約52円/枚
- API 商品名: ...
- API 抽出 capacity: 7枚
- 信頼度: low
- 理由:
  - 既存値と API 抽出値が大きく異なる
  - 販売数量だけを拾った可能性
- 自動対応:
  - capacity は更新しない
  - pricePerUnit は既存 capacity で再計算、または維持
- 楽天URL: ...
```

### 5. AI 確認用 JSONL を生成

AI に記事全文を読ませず、怪しい商品だけを小さな入力にする。

出力先:

```text
reports/ai-capacity-input-YYYY-MM-DD.jsonl
```

1 行 1 商品。

```json
{
  "articleFile": "src/content/articles/mask-comparison.md",
  "category": "mask",
  "current": {
    "name": "mdの商品名",
    "capacity": "50枚",
    "pricePerUnit": "約52円/枚"
  },
  "api": {
    "itemName": "楽天APIの商品名",
    "price": 2600,
    "rating": 4.71,
    "reviewCount": 168,
    "itemUrl": "https://item.rakuten.co.jp/...",
    "affiliateUrl": "https://hb.afl.rakuten.co.jp/...",
    "imageUrl": "https://thumbnail.image.rakuten.co.jp/..."
  },
  "ruleAnalysis": {
    "extractedCapacity": "7枚",
    "confidence": "low",
    "reasons": [
      "既存capacityとAPI抽出値が矛盾",
      "販売数量だけを拾った可能性"
    ]
  }
}
```

AI への想定指示:

```text
reports/ai-capacity-input-YYYY-MM-DD.jsonl を確認し、
capacity / pricePerUnit の反映可否を判断してください。
high confidence のものだけ md に反映し、
曖昧なものは reports に残してください。
```

AI 出力の想定:

```json
{
  "articleFile": "src/content/articles/mask-comparison.md",
  "decision": "keep_existing",
  "capacity": "50枚",
  "normalizedName": "必要なら正規化後の商品名",
  "confidence": "high",
  "reason": "API商品名の7枚はお試し表記の可能性が高く、既存capacityを維持するのが妥当",
  "needsHumanReview": false
}
```

初期実装では AI 出力の自動適用コマンドは作らない。
運用が安定してから `pnpm apply-capacity-review` のような反映コマンドを検討する。

## 実装後の運用

### 商品情報更新

実装前:

```text
pnpm update-products
→ capacity / pricePerUnit も条件次第で自動更新
→ 怪しい差分は後から記事を見て確認
```

実装後:

```text
pnpm update-products
→ 価格・レビュー・画像・URLはAPIで更新
→ capacity は high confidence のみ更新
→ 既存 capacity は原則維持
→ pricePerUnit は確実な capacity のみ再計算
→ 怪しい商品は reports/ai-capacity-input-*.jsonl へ
→ 必要時だけ AI 確認を依頼
```

AI 確認が必要なケース:

- `reports/ai-capacity-input-*.jsonl` が生成された
- `reports/capacity-review-*.md` に要確認商品がある
- ログに capacity 要確認が出た

AI 確認が不要なケース:

- レポートが空
- high confidence の更新だけで完了
- 価格・レビュー・画像・URLだけの更新
- 既存 `capacity` と API 情報に矛盾がない

### 商品追加

商品追加時に AI が判断した `capacity` は、追加後の `update-products` で壊さない。

追加後の `update-products` は:

- 価格・レビュー・画像・URLを更新
- 既存 `capacity` を維持
- 既存 `capacity` が解析可能なら `pricePerUnit` を再計算
- API 商品名と矛盾する場合は自動上書きせず AI 確認レポートへ

### 記事追加

記事作成時に AI が商品ページや候補文脈から判断した `capacity` を尊重する。

将来的には新規記事作成用に、楽天 API 候補を整形した `article-create-input-*.json` を作り、AI には構造化入力だけ渡す。

## トークン削減見込み

実装前を 100% とした概算。

| 運用 | 実装後目安 | 削減率 |
|---|---:|---:|
| 商品情報更新 | 20-40% | 60-80% |
| 商品追加 | 35-60% | 40-65% |
| 記事追加 | 30-50% | 50-70% |

理由:

- AI が全記事・全商品を読まず、要確認商品の JSONL だけを見る。
- 既存 `capacity` を信頼資産として維持するため、再確認対象が減る。
- 商品追加・記事追加では、スクリプトで候補情報を構造化してから AI に渡せる。

## テスト方針

`tests/frontmatter.test.ts` に以下を追加する。

- `500mL×3` を high confidence として扱える
- `30枚` を high confidence として扱える
- `12ロール×4パック` を high confidence として扱える
- `500mL 250mL 選べる` を low confidence として扱う
- `本体+詰替` を low confidence として扱う
- 既存 `50枚` に対して API 抽出 `7枚` は自動更新不可
- API 商品名から容量が取れなくても、既存 `capacity` が解析可能なら維持
- 不確実な `capacity` では `pricePerUnit` を新規再計算しない

## 完了条件

- low / medium confidence の `capacity` が md に自動反映されない
- 既存 `capacity` が API 抽出失敗だけで消されない
- `pricePerUnit` が不確実な `capacity` で再計算されない
- `reports/capacity-review-*.md` が生成される
- `reports/ai-capacity-input-*.jsonl` が生成される
- `pnpm test` が通る
- 可能なら `pnpm update-products:dry --file=mask-comparison.md` で挙動確認できる

## 後続検討

- `capacitySource`, `capacityVerifiedAt`, `capacityConfidence` を frontmatter に追加するか
  - スキーマ変更になるため別途確認が必要
- AI 判定結果を読み込む `pnpm apply-capacity-review` の追加
- GitHub Actions での AI 確認自動化
  - high confidence のみ自動反映
  - medium / low はレポート止まり
- 楽天商品ページの低頻度・明示実行・キャッシュ前提の確認
  - 実装前に規約確認が必要
