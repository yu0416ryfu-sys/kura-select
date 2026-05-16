# copy 自動再生成の改善版設計

最終目標:

- 商品が別商品に差し替わったとき
- `capacity` が変わったとき
- `name` / `rakutenUrl` / `pricePerUnit` が変わったとき

これらをトリガーにして、`features` / `pros` / `cons` / `recommendedFor` を人手なしで同期する。

## この版で解消すること

元の最小設計で懸念だった点を先に潰す。

- 商品メタ情報だけでは copy を復元しにくい
- `price` / `rating` / `reviewCount` の微小変動で copy が揺れる
- `copy_refresh_required` の永続化先が曖昧
- 既存記事への初回適用で大量ノイズ更新が起きる
- スキル側が「人が copy を詰める」前提のまま残る

## 基本方針

- copy は手書き本文ではなく、商品データから組み立てる派生情報として扱う
- 再生成の単位は `update-products` に統一する
- copy の更新は「必要なときだけ」行う
- 事実が足りないときは推測で埋めず、カテゴリテンプレの安全文に寄せる
- 永続フラグは増やさない。更新1回の中で判定して完結させる

## 変更検知

`scripts/update-products.mjs` で、copy 再生成の要否を判定する。

### copy 再生成を必須にする条件

- `name` が変わった
- `capacity` が変わった
- `rakutenUrl` が変わった
- 商品が差し替わった
- `pricePerUnit` が変わった
- `category` が変わった

### copy 再生成のトリガーにしない条件

- `price` だけが変わった
- `rating` だけが変わった
- `reviewCount` だけが変わった
- `imageUrl` だけが変わった

ただし、上の値の変化が `name` / `capacity` / `rakutenUrl` の更新を伴うなら、その時点で copy 再生成対象にする。

## 生成器の設計

新しいヘルパーを 1 つ追加する。

- `scripts/lib/product-copy.ts`

責務は 1 つだけ。

- 商品データとカテゴリルールから `features` / `pros` / `cons` / `recommendedFor` を機械的に生成する

### 入力

最小では以下を受け取る。

- `category`
- `name`
- `brand`
- `capacity`
- `pricePerUnit`
- `rakutenUrl`
- `imageUrl`
- `articleTitle`

追加で、生成精度を上げるために内部で導出する。

- `productType`
- `formFactor`
- `material`
- `packFormat`
- `unitKind`
- `sizeHint`
- `isSetProduct`
- `isRefillProduct`
- `isSpecialUseProduct`

### 重要な考え方

copy を直接「文章生成」しない。

1. 商品名と容量を解析して、事実ベースの属性を抽出する
2. 抽出できた属性だけをテンプレに流し込む
3. 不明な属性は書かない
4. どの商品でも使える一般論は最後の安全文としてだけ使う

## 生成方式

### 1. 商品分類

まず `category` と `name` から、商品を小さな型に分類する。

例:

- 保存袋
- ラップ
- 洗剤詰め替え
- 本体商品
- 専用用途商品
- セット商品
- 交換頻度が高い消耗品

分類は 100% の正確性を狙わず、テンプレ選択に使う程度に留める。

### 2. `features`

`features` は「客観的に言えること」だけに絞る。

入れる候補:

- 商品タイプ
- 形状
- 素材
- 容量表記の特徴
- セット構成
- 用途の限定性

入れないもの:

- 安い / 高い / おすすめ などの評価語
- レビュー件数や順位
- 根拠の薄い性能断定

### 3. `pros`

`pros` は「比較表で読者が得る実用上の利点」に限定する。

候補:

- まとめ買いしやすい
- 使い分けやすい
- 保管しやすい
- 用途が分かりやすい
- 単位比較しやすい

ただし `price` や `rating` に依存する表現は避ける。

### 4. `cons`

`cons` は欠点の断定ではなく、注意点として書く。

候補:

- かさばる
- 用途が限定される
- 容量表記が複雑
- サイズ選択が必要
- 汎用性は高くない

### 5. `recommendedFor`

`recommendedFor` はカテゴリと商品型から選ぶ。

候補:

- まとめ買いしたい人
- 単価を重視する人
- 使い分けしたい人
- 保管性を重視する人
- 専用用途を優先したい人

## copy の安全ルール

- 数値は `price` / `capacity` / `pricePerUnit` / `rating` / `reviewCount` に閉じ込める
- `features` / `pros` / `cons` / `recommendedFor` に数値を書かない
- 同じ文を全商品にコピペしない
- 事実が取れない項目は無理に埋めない
- `features` / `pros` / `cons` はそれぞれ役割を分ける
- `recommendedFor` はカテゴリと商品型に矛盾させない

## 更新書き戻し

`scripts/lib/frontmatter.ts` に copy 更新口を追加する。

必要な変更点:

- `ProductSnapshot` に copy 系フィールドを追加する
- `ProductUpdates` に copy 更新項目を追加する
- `updateProductInFrontmatter()` で copy を一括更新できるようにする
- `extractProductSnapshot()` で copy を取得できるようにする

### 追加したいフィールド

- `features`
- `pros`
- `cons`
- `recommendedFor`

### 実装上の注意

- `updateProductInFrontmatter()` は既存値を壊さず、更新対象だけ差し替える
- `undefined` は「触らない」
- `null` は「意図的に未設定」ではなく、基本は触らない扱いに寄せる
- YAML の配列順と引用は既存の dump ルールに合わせる

## 実行フロー

```text
1. update-products が各記事を読む
2. 商品ごとに楽天 API を照合する
3. 商品データの差分を検出する
4. name / capacity / rakutenUrl / pricePerUnit が変わったら copy 再生成対象にする
5. copy 生成器で features / pros / cons / recommendedFor を再生成する
6. frontmatter に反映する
7. updatedAt を更新する
8. .bak を保存して書き戻す
```

## 再生成の判定

### 再生成する

- 商品差し替え
- `name` 変更
- `capacity` 変更
- `rakutenUrl` 変更
- `pricePerUnit` 変更
- `category` 変更

### 再生成しない

- `price` だけ変更
- `rating` だけ変更
- `reviewCount` だけ変更
- `imageUrl` だけ変更

### 補足

`price` / `rating` / `reviewCount` の変動は copy の再生成トリガーにしない。  
copy の文言を揺らすより、数値の更新だけを反映したほうが安定する。

## 検証

書き戻し前に機械チェックを必ず入れる。

### 必須チェック

- `features` / `pros` / `cons` / `recommendedFor` に数値が残っていない
- `features` / `pros` / `cons` が完全同一になっていない
- `recommendedFor` がカテゴリと矛盾していない
- `name` と `capacity` が現在の商品に一致している
- `pricePerUnit` が `capacity` と整合している
- 1 商品内で同じ文が重複しすぎていない

### 安全な失敗条件

以下のどれかに当てはまるときは、再生成を止めずに安全テンプレへ寄せる。

- 属性抽出の確信度が低い
- 商品名が短すぎて分類できない
- セット構成が複雑すぎる
- 容量単位が曖昧
- `recommendedFor` がカテゴリと衝突する

この場合は「生成失敗」ではなく「保守的な一般テンプレで保存」にする。

## 初回移行

既存 53 記事への初回適用は一気に本番反映しない。

### 段階 1

- 生成器を追加
- `--dry-run` で差分確認
- copy 差分が広すぎる記事を洗い出す

### 段階 2

- 既存 copy を保ったまま、差分の大きい商品だけ限定更新
- 同一記事内で文面の重複が増えていないか確認する

### 段階 3

- 全記事に展開
- 問題が出たカテゴリだけテンプレを個別調整する

## スキル側の修正ポイント

### `kura-article-add`

- 追加時に人が copy を詰める前提を消す
- 初期値は安全テンプレでよい
- 追加後は `update-products` で copy まで整う前提にする

### `kura-article-create`

- 新規作成時は安全テンプレを使う
- copy は初期品質のための仮置きとみなす
- 以後の正規化は `update-products` に寄せる

### `kura-product-match-ai`

- `replace` 出力では copy を触らない
- AI は `name` / `capacity` / URL / 数値の整合に集中する
- copy の再生成は次回 `update-products` に集約する

### `kura-capacity-review-jsonl`

- `capacity` 修正だけでなく、商品差し替えの発生を copy 再生成の条件に含める
- `decision: delete` なら copy は不要化する

## 最小のデータ契約

コピー再生成器が参照する項目はこれだけに絞る。

- `category`
- `name`
- `brand`
- `capacity`
- `price`
- `pricePerUnit`
- `rating`
- `reviewCount`
- `rakutenUrl`
- `imageUrl`
- `articleTitle`

本文全文は読まない。

## 失敗時の扱い

完全自動化では、人に返すのではなく機械的に次のどちらかへ寄せる。

- 安全テンプレで再生成して保存する
- どうしても整合しない場合だけ、その商品だけ copy を据え置く

ただし、据え置きは例外にする。  
原則は「止めずに保存する」。  
ただし「事実の捏造」はしない。

## 実装順

1. `scripts/update-products.mjs` に copy 再生成トリガーを追加する
2. `scripts/lib/product-copy.ts` を新設する
3. `scripts/lib/frontmatter.ts` で copy の読み書きを可能にする
4. `tests/frontmatter.test.ts` に copy 往復テストを追加する
5. `docs/update-products-spec.md` とスキル文言を自動再生成前提に寄せる
6. `pnpm update-products --dry-run` で差分を確認する

## 実装上の補足

- `copy_refresh_required` のような永続フラグは持たない
- copy 再生成の有無は、`update-products` の実行中だけ判定する
- 生成結果が既存 copy と同程度なら、無駄な書き換えはしない
- 数値更新だけのときは copy を維持する

