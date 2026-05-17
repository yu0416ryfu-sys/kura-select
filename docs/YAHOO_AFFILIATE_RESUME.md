# Yahoo Affiliate Resume Notes

このファイルは、新しいチャットで Yahoo アフィリエイト統合の続きから再開するための指示書です。

## 現在地点

- 作業ブランチ: `yahoo-affiliate`
- GitHub remote ブランチ:
  - `origin/yahoo-affiliate`
  - `origin/staging`
- 実装コミット: `52cf291 Yahooアフィリエイト統合の土台を追加`
- 本番 `main` は未変更
- `.git` の Permission denied は対応済み

## 完了済み

- `PUBLIC_ENABLE_YAHOO_AFFILIATE` feature flag 追加
- `PUBLIC_NOINDEX` による noindex 強制追加
- `products[].offers` optional schema 追加
- 楽天 fallback / Yahoo 表示制御 helper 追加
- `AffiliateLink.astro` 追加
- `RakutenLink.astro` wrapper 化
- `ProductCard` / `ComparisonTable` / `TopPickCta` / `ArticleLayout` の offers 対応
- Yahoo API 正規化レイヤ追加
- Yahoo 同期スクリプト追加
- fixture ベースのテスト追加
- staging 用 workflow 追加
- staging 運用メモ追加

## 検証済み

- `corepack pnpm test`: 成功
- `corepack pnpm build`: 成功
- `corepack pnpm update-yahoo-products:dry`: 成功
- `PUBLIC_NOINDEX=true`: `dist/index.html` に `noindex,nofollow` 出力確認
- `PUBLIC_NOINDEX=false`: noindex なし確認

## 人間待ち

ValueCommerce の審査/発行待ち。

GitHub Actions secrets に以下を追加する必要がある。

```text
YAHOO_SHOPPING_APP_ID
VALUECOMMERCE_SID
VALUECOMMERCE_PID
```

`VALUECOMMERCE_SID` と `VALUECOMMERCE_PID` の取得に数日かかる見込み。

## 次回チャットで最初にやること

1. `AGENTS.md` を読む。
2. このファイル `docs/YAHOO_AFFILIATE_RESUME.md` を読む。
3. 状態確認を行う。

```powershell
git branch --show-current
git status --short
git log --oneline -5
git branch -r
```

4. 現在ブランチが `yahoo-affiliate` でなければ切り替える。

```powershell
git switch yahoo-affiliate
```

5. 人間に GitHub Actions secrets の設定が完了したか確認する。

## secrets 設定後に進める作業

### 1. staging dry-run

GitHub Actions の `Yahoo商品データ検証更新（staging）` workflow を `staging` ブランチで手動実行する。

初回は write しない。

```text
write: false
article: toilet-paper-comparison
```

またはローカルで credentials が `.env` にある場合のみ以下。

```powershell
corepack pnpm update-yahoo-products -- --dry-run --article=toilet-paper-comparison --limit=1
```

### 2. dry-run report 確認

`reports/yahoo-products-dry-run-*.md` を確認し、以下をチェックする。

- 候補URLが ValueCommerce 経由になっている
- 明らかな別商品が auto になっていない
- 価格・商品名が大きくズレていない
- credentials の実値が report に出ていない

### 3. 人間判断

dry-run 結果を見て、人間に次を確認する。

- write 対象記事
- 自動採用してよい候補
- review のまま残す候補

### 4. staging write

人間の了承後、1〜3記事だけ staging で write する。

```powershell
corepack pnpm update-yahoo-products -- --write --article=<slug> --api-interval=1000
```

または GitHub Actions で:

```text
write: true
article: <slug>
```

### 5. staging 表示確認

staging deploy 環境で確認する。

- `PUBLIC_ENABLE_YAHOO_AFFILIATE=true`
- `PUBLIC_NOINDEX=true`
- 楽天・Yahoo ボタンが表示される
- Yahoo OFF では楽天のみになる
- `rel="sponsored nofollow noopener"` が維持される
- HTML に `noindex,nofollow` がある

### 6. 本番投入

staging 検証後に進める。

1. `main` にコードだけマージ
2. 本番 env は `PUBLIC_ENABLE_YAHOO_AFFILIATE=false`
3. 本番 deploy
4. 既存楽天表示が壊れていないことを確認
5. 本番 Yahoo ON のタイミングを人間に確認

## 注意

- `main` に Yahoo 同期 cron を追加しない。
- `.github/workflows/update-products.yml` に Yahoo secrets を混ぜない。
- `rakutenUrl` を削除しない。
- `offers` を必須化しない。
- 全記事を一括変換しない。
- `.md.bak` は触らない。
- secrets の実値をチャット、docs、ログに書かない。
