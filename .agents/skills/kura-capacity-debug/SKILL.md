---
name: kura-capacity-debug
description: |
  KuraSelectのcapacity抽出バグを根本原因から特定し、scripts/lib/frontmatter.ts への
  修正案をdiff形式で提示するスキル。
  capacity値が楽天の商品表記と一致しない・update-productsを実行してもcapacityが正しく
  取れない・extractCapacityTotal関数のロジックを見直したい場合に使う。
  ユーザーが「正しいcapacity」「rakutenUrl」「対象MDファイル」の3点を提供することが前提。
---

# KuraSelect capacity デバッグスキル

capacity抽出バグの根本原因を特定し、後方互換性を保った最小限の修正案を提示する。

## 入力（必須3点）

| 項目 | 内容 |
|------|------|
| MDファイル or products[] | 問題のある商品エントリ |
| `rakutenUrl` | 問題のある商品の楽天URL |
| **正しいcapacity** | ユーザーが楽天ページで確認した実際の表記と総量（唯一の基準値） |

---

## Step 1: 差異の確認

MDファイルを Read し、対象商品の現在の `capacity` 値を取得する。ユーザー提供の正しい値と並べて差異を明記する:

```
現在のcapacity : "（MDファイルの値）"
正しいcapacity : "（ユーザー確認済みの値）"
```

---

## Step 2: 楽天ページをWebFetch

`rakutenUrl` をWebFetchし、**商品タイトルの完全な文字列**を取得する。

`extractCapacityTotal` はこのタイトル文字列を入力として処理するため、タイトルの正確な表記（全角/半角・記号・セット構成の記述形式）が分析の出発点になる。

---

## Step 3: `extractCapacityTotal` の分析

ファイルを Read する:
- **ロジック本体**: `scripts/lib/frontmatter.ts`（`extractCapacityTotal` 関数）
- **既存テスト**: `tests/frontmatter.test.ts`

以下を分析する:
- `normalizeItemName` による正規化後の文字列がどう変化するか
- `bracketRe`・`mulBaseRe`・`simpleRe` のどのパターンがマッチしたか（またはしなかったか）
- 今回の商品タイトルが各パターンを通過するときの挙動

---

## Step 4: 原因特定

以下の形式で記述する:

```
【失敗したパターン】
  正規表現: /（該当パターン）/
  マッチした文字列: "（実際にマッチした箇所）"
  生成されたcapacity: "（誤った値）"

【期待される処理】
  商品タイトル: "（WebFetchで確認した表記）"
  期待されるcapacity: "（ユーザー提供の正しい値）"

【失敗の理由】
  （正規表現の構造・優先順位・正規化処理のどこが原因かを1〜3文で説明）
```

---

## Step 5: 修正案（diff形式）

**後方互換性を最優先**として以下の原則で修正案を作成する:

- 既存の正常ケースに影響しない最小限の変更のみ
- 新しいパターンを追加する場合は既存パターンの **後ろ** に追加
- 既存パターンを変更する場合は影響範囲を明示してから変更

```diff
// scripts/lib/frontmatter.ts
  const mulBaseRe = ...
+ const newPatternRe = /（新しいパターン）/;  // 追加理由: 〇〇の形式に対応
```

類似パターン（同じ問題が起きそうな別の楽天表記）への対応も提案する。

---

## Step 6: リスク評価

| 評価項目 | 内容 |
|---------|------|
| 既存テストへの影響 | 影響なし / 要確認（影響するテストケースを列挙） |
| 類似商品への波及 | なし / あり（対象カテゴリ・表記パターンを列挙） |
| 変更の侵襲度 | 小（追加のみ） / 中（既存パターン変更） / 大（ロジック再構成） |

---

## Step 7: 追加テストケース

`tests/frontmatter.test.ts` に追加すべきケースを列挙する:

```
- 入力: "（商品タイトル文字列）"
  期待capacity: "（正しい値）"
  カバーする理由: （どのエッジケースを防ぐか）
```

---

## 完了後の案内

修正案を提示した後、ユーザーに以下を伝える:

```
修正を適用したら:
1. pnpm test          （回帰テスト — 既存ケースへの影響確認）
2. pnpm update-products  （修正後のcapacity再取得）
3. pnpm build         （スキーマ検証）
4. git add / commit / push
```
