# update-products.mjs 使い方ガイド

## 基本コマンド

| コマンド | 内容 |
|---|---|
| `pnpm update-products` | 全記事の価格・評価・画像を最新化（本番） |
| `pnpm update-products:dry` | ↑ のファイル書き込みなし確認実行 |
| `pnpm check-additions` | 商品数10未満の記事に追加候補を提案 |
| `pnpm check-replacements` | 現在の商品より人気商品が存在する場合に提案 |

---

## オプション一覧

```bash
# 特定の記事だけ対象にする
node scripts/update-products.mjs --file=toilet-paper-comparison.md
node scripts/update-products.mjs --check-additions --file=toilet-paper-comparison.md

# 目標商品数を変更（check-additions、デフォルト: 11）
node scripts/update-products.mjs --check-additions --target=8

# 入れ替え候補の閾値を変更（check-replacements、デフォルト: 2倍）
node scripts/update-products.mjs --check-replacements --threshold=3

# 組み合わせ例
node scripts/update-products.mjs --check-additions --file=shampoo-comparison.md --target=10
```

---

## レポートの出力先

`check-additions` / `check-replacements` はどちらも `reports/` フォルダに Markdown で出力されます。

```
reports/
  addition-candidates-2026-05-08.md    ← check-additions の結果
  replacement-candidates-2026-05-08.md ← check-replacements の結果
```

> `reports/` は `.gitignore` 済みのためコミットされません。

---

## 典型的なワークフロー

```bash
# 1. 商品追加候補を確認
pnpm check-additions

# 2. reports/ のレポートを開き、URL を確認・選定
# 3. 追加したい商品は kura-article-add スキルで記事に追記

# 4. 全記事の価格・評価を最新化（週次 GitHub Actions でも自動実行）
pnpm update-products
```

---

## 環境変数（`.env`）

```
RAKUTEN_APPLICATION_ID=（楽天 Web Service アプリID）
RAKUTEN_ACCESS_KEY=（楽天 Web Service アクセスキー）
PUBLIC_RAKUTEN_AFFILIATE_ID=（楽天アフィリエイトID）
```

GitHub Actions での自動実行は `.github/workflows/update-products.yml` の secrets に設定済みです（毎週月曜 12:00 JST）。

---

## 更新対象フィールド（update-products）

`pnpm update-products` 実行時に各商品で更新されるフィールドは以下のとおりです。

| フィールド | 内容 |
|---|---|
| `price` | 現在の販売価格 |
| `rating` | 楽天レビュー平均点 |
| `reviewCount` | レビュー件数 |
| `rakutenUrl` | アフィリエイトURL |
| `imageUrl` | 商品サムネイル画像URL |
| `pricePerUnit` | 容量から自動再計算（例: 約3.2円/枚） |

### 自動処理される追加機能

- **廃番検出**: 検索0件かつAPI正常時は商品ブロックを自動削除
- **容量差異修正**: APIで取得した商品名の容量と `capacity` フィールドに乖離がある場合に自動修正
- **コスパ順並び替え**: `pricePerUnit` 更新後にランクを自動ソート
- **バックアップ作成**: 更新前に `*.bak` ファイルを自動生成
