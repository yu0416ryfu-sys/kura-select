---
name: kura-capacity-review-jsonl
description: |
  KuraSelect の reports/ai-capacity-input-*.jsonl や貼り付けられた capacity review JSONL をもとに、
  商品URL・商品カテゴリ・capacity/pricePerUnit の不整合を切り分け、記事MDと
  scripts/lib/frontmatter.ts / scripts/update-products.mjs / tests/frontmatter.test.ts を必要最小限で修正するスキル。
  ユーザーが JSONL の数行、capacity-review の抜粋、または「この review 結果を直して」と依頼した場合に使う。
---

# KuraSelect capacity review JSONL 対応

## 目的

capacity review JSONL の指摘を、次の3種類に分類して効率よく処理する。

1. **記事データ不整合**: `current.name` と `api.itemName` が別商品、カテゴリ外商品、楽天URL誤り。
2. **capacity抽出ロジック不備**: API商品名には正しい総量があるが、`ruleAnalysis.extractedCapacity` が誤る/低信頼になる。
3. **安全装置として妥当**: 選択式・セット式など、自動反映せず review に残すべきもの。

## 最初に読むファイル

- 対象記事: `src/content/articles/{slug}-comparison.md`
- ロジック: `scripts/lib/frontmatter.ts`
- 更新処理: `scripts/update-products.mjs`
- テスト: `tests/frontmatter.test.ts`

JSONLがファイルで渡された場合は、全件を読む前に対象カテゴリと件数を確認する。貼り付けなら貼られた分だけ処理する。

## 判定手順

各JSONL行について以下を確認する。

1. `current.name` と `api.itemName` が同じ商品か。
   - ブランド名・型番・用途・容量・商品種別を見る。
   - 例: ゴミ袋記事なのに米、コットン記事なのに洗剤なら **記事データ不整合**。
2. `api.itemUrl` / `affiliateUrl` が `current.name` の商品として妥当か。
   - URLが別商品なら、正しいURLを確定できない限り、その商品エントリは除外または要確認にする。
   - 推測で別URLを作らない。
3. `current.capacity` と API商品名の総量が同じ意味か。
   - `1000枚：100枚×10パック` は総量 `1000枚`。
   - `300枚 (100枚×3束)` は総量 `300枚`、括弧内は内訳。
   - `45L` は袋サイズであり、単価計算単位の枚数ではない。
4. `ruleAnalysis.reasons` が妥当か。
   - 内訳を複数capacity候補扱いしているだけならロジック修正候補。
   - `選べる`, `福袋`, `1枚/3枚/5枚` など実際に選択式なら review 維持。

## 修正方針

### 記事MDを直す場合

- カテゴリ外商品やURLが別商品を指す商品は、正しい楽天URLを確定できない限り削除または一時除外。
- 商品を削除したら `description` や「おすすめN選」など件数表現も合わせる。
- `capacity` は単価計算に使う単位を明示する。
  - 良い例: `100枚×10パック（1000枚）`
  - 悪い例: `45L×1セット`
- `pricePerUnit` は `price / 総枚数` で整合させる。

### `frontmatter.ts` を直す場合

既存正常ケースを壊さない最小パターンを追加する。

- 総量 + 内訳:
  - `（1000枚：100枚×10パック）` → `（1000枚）`
  - `300枚 (100枚×3束)` → `300枚`
- サイズ + 販売数量:
  - `45L 1セット` は `45L×1セット` にしない。
  - 袋カテゴリでは `L` はサイズのことが多く、枚数が別にあれば枚数を優先。
- 複数候補判定:
  - 抽出総量と同じ単位の小さい内訳値は候補から除外してよい。
  - 抽出総量が `枚` など販売数量単位なら、`45L` など実容量単位は候補比較から除外してよい。

### `update-products.mjs` を直す場合

- 既存 `rakutenUrl` から商品IDが取れる場合、Search API 0件だけで削除しない。
- 既存URLの商品名が現在の商品名と明らかに一致しない場合は、別商品で上書きせずスキップする。
- フォールバック検索で別商品に置換されないように、商品名一致ガードを置く。

## テスト追加

修正したパターンは必ず `tests/frontmatter.test.ts` に追加する。

推奨テスト:

```ts
expect(extractCapacityFromItemName("TANOSEE ゴミ袋 45L 1セット（1000枚：100枚×10パック）")).toBe("（1000枚）");
expect(analyzeCapacityFromItemName("HEIKO PP食パン袋 半斤用 300枚 (100枚×3束)")).toMatchObject({
  capacity: "300枚",
  confidence: "high",
});
```

記事URL不一致はロジックテストだけでは足りないため、対象記事で `pnpm update-products --file={file} --dry-run --verbose` を実行して確認する。

## 検証コマンド

基本:

```bash
corepack pnpm test
corepack pnpm update-products --file={slug}-comparison.md --dry-run --verbose
corepack pnpm build
```

ネットワーク制限で `fetch failed` になった場合は、同じ dry-run を承認付きで再実行する。

## 完了報告

ユーザーには簡潔に以下を伝える。

- JSONL各件の分類
- 記事から削除/修正した商品
- 追加・修正した抽出ロジック
- dry-run の結果（削除0件、review対象が消えた等）
- `pnpm test` / `pnpm build` の結果
