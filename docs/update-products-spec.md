# update-products 仕様書

対象コマンド: `pnpm update-products`  
実体: `node scripts/update-products.mjs`  
対象ファイル: `src/content/articles/*.md`

## 前提条件

`.env` または環境変数に以下が必要。

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`
- `PUBLIC_RAKUTEN_AFFILIATE_ID`

不足時は即終了し、記事ファイルは更新しない。

## 実行モード

- `pnpm update-products`: 商品情報を更新し、差分があればファイルを書き換える
- `node scripts/update-products.mjs --dry-run`: 書き換えずに更新予定だけ表示する
- `node scripts/update-products.mjs --file=xxx.md`: 指定した記事ファイルのみ処理する

## 商品データ取得

各商品の `name` と `rakutenUrl` を使って楽天APIから商品情報を取得する。

1. `rakutenUrl` から `shopCode` / `itemCode` を抽出できる場合、まず同一商品取得を試す。ログ上は `[Item/Get]`。
2. `Item/Get` で取得できない場合、`name` から検索キーワードを作って楽天検索する。ログ上は `[Search(fallback)]`。
3. `rakutenUrl` を解析できない場合、最初から商品名検索する。ログ上は `[Search]`。

検索結果では以下を除外する。

- ふるさと納税系URL
- 商品名に `ふるさと納税` / `ふるさと` / `寄付` / `寄附` / `返礼品` を含むもの
- ショップ名に `ふるさと納税` / `furusato` を含むもの

検索APIはレビュー件数順で取得し、除外後の先頭商品を使う。

## 通常更新される値

楽天APIで商品取得に成功した場合、以下を更新する。

| field | 更新条件 |
|---|---|
| `price` | APIの `itemPrice` が `null` でない場合 |
| `rating` | APIの `reviewAverage` が `null` でない場合 |
| `reviewCount` | APIの `reviewCount` が `null` でない場合 |
| `rakutenUrl` | APIの `affiliateUrl` が取得できた場合 |
| `imageUrl` | APIの `mediumImageUrls[0]` が取得できた場合 |
| `pricePerUnit` | 既存 `capacity` があり、API価格が取得できた場合 |

`pricePerUnit` は既存の `capacity` を使って再計算する。

例:

```text
price: 1000
capacity: "500mL"
pricePerUnit: "約2円/mL"
```

## capacity / name の更新条件

基本は既存 `capacity` を使う。ただし以下の場合だけ更新する。

| 条件 | 更新内容 |
|---|---|
| `[Item/Get]` かつ API商品名から抽出した容量が販売数量の誤読っぽい | `capacity: "-"`, `pricePerUnit: "-"`, `name` から既存容量表記を削除 |
| 既存容量とAPI抽出容量が同系単位で比較可能、かつ差分が閾値超え | `capacity` をAPI抽出値へ更新、`name` もAPI商品名由来へ更新、`pricePerUnit` 再計算 |
| 既存 `capacity` が解析不能、API抽出容量は解析可能、かつ `[Item/Get]` | `capacity` をAPI抽出値へ更新、`name` もAPI商品名由来へ更新、`pricePerUnit` 再計算 |
| API商品名から容量抽出不可、かつ `[Item/Get]` | `capacity: "-"`, `pricePerUnit: "-"`, `name` から既存容量表記を削除 |

容量差分の閾値:

- `[Item/Get]`: 差分があれば更新
- `[Search]`: 5%超の差分のみ更新

現在は、単位不一致だけを理由に `capacity` をAPI値へ上書きする処理はない。

例:

```text
既存 capacity: "300g×6個"
API抽出: "6個"
結果: この理由だけでは "6個" に更新しない
```

## 商品削除条件

楽天API検索で以下のエラーになった場合、API正常性を確認する。

- `検索結果が0件です`
- `通常商品が見つかりません`

その後 `日用品` でAPI疎通確認を行う。

| 条件 | 動作 |
|---|---|
| API疎通確認に失敗 | API障害と判断して即終了。書き込みしない |
| API疎通確認に成功 | 対象商品を廃番扱いで削除 |
| 削除対象が最後の1商品 | 削除しない |
| 0件エラーが連続3件 | API障害の可能性として即終了。書き込みしない |

## 並び替え条件

全商品処理後、`pricePerUnit` を基準に並び替える。

- `約〇円/単位` または `〇円/単位` を解析できる商品が対象
- 単位は正規化される
  - `L` → `mL`
  - `kg` → `g`
  - `ml` → `mL`
- 同一単位グループ内で安い順
- 比較不能な商品は末尾
- 並び替え後、`rank` を1から振り直す

## name と capacity の整合修正

全商品処理後、商品名に含まれる容量と `capacity` が食い違う場合、商品名側を修正することがある。

更新条件:

- 商品名から容量が抽出できる
- `capacity` も解析できる
- 単位が同じ
- 数値が異なる
- 商品名側の容量表記が `×` を含まない

例:

```text
name: "... 500mL ..."
capacity: "600mL"
結果: name 側の "500mL" を "600mL" に置換
```

## ファイル更新条件

`--dry-run` なし、かつ内容に差分がある場合のみ書き込む。

書き込み時に行うこと:

- `updatedAt` を日本時間の当日 `YYYY-MM-DD` に更新
- 元ファイルを `<ファイル名>.bak` として保存
- 更新後のMarkdownを書き込み

`--dry-run` の場合:

- ファイルは書き換えない
- 削除も並び替えもログ表示のみ
- `.bak` も作らない

## 通常更新されない値

通常の `pnpm update-products` では以下は基本的に更新しない。

- `features`
- `pros`
- `cons`
- `recommendedFor`
- `brand`
- `title`
- `description`
- `tags`
- 本文Markdown

ただし `name` / `capacity` / `rank` / `updatedAt` は条件付きで更新される。
