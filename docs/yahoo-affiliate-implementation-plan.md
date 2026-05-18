# Yahooアフィリエイト対応 実装計画書

この計画書は、KuraSelect に Yahoo!ショッピング / バリューコマース系のアフィリエイト商品表示・同期機能を追加するための AI 実装指示書です。実装AIは本書を上から順に読み、既存の楽天アフィリエイト本番運用を壊さないことを最優先に作業してください。

## 0. 最重要方針

- 本番 `main` / GitHub Pages の挙動を即変更しない。
- Yahoo機能は feature flag で制御し、初期状態では本番無効にする。
- 既存記事の `products[].rakutenUrl` 前提を一度に破壊しない。
- 既存の楽天自動更新 workflow を Yahoo 同期と混ぜない。
- スキーマ変更は段階移行にし、既存記事がそのまま `pnpm build` できる状態を維持する。
- アフィリエイトリンクは楽天・Yahooとも `rel="sponsored nofollow noopener"` を維持する。
- staging / preview は必ず `noindex` にする。

## 1. 現状把握

対象リポジトリ: `C:\Projects\KuraSelect`

技術前提:

- Astro 6.1 SSG
- Preact 10
- Tailwind CSS v4
- TypeScript strict
- pnpm 固定
- Node 22 以上
- 本番 deploy: GitHub Pages

既存の重要ファイル:

- `src/content.config.ts`
  - `products[].rakutenUrl` が必須。
  - ここを破壊的に変えると全記事に影響する。
- `src/components/product/ProductCard.astro`
  - 楽天リンクを直接表示している。
- `src/components/product/RakutenLink.astro`
  - 楽天専用リンクコンポーネント。
- `src/layouts/ArticleLayout.astro`
  - JSON-LD、比較表、CTA、商品カードで `rakutenUrl` を参照している。
- `src/components/product/ComparisonTable.astro`
- `src/components/product/ComparisonTableSort.tsx`
- `src/components/product/TopPickCta.astro`
- `src/pages/search.astro`
- `scripts/update-products.mjs`
  - 楽天 API 同期の中心。
- `scripts/lib/frontmatter.ts`
  - frontmatter の読み書き・商品更新ロジック。
- `.github/workflows/deploy.yml`
  - `main` push で本番 deploy。
- `.github/workflows/update-products.yml`
  - 楽天商品データを自動更新し、変更があれば `main` に push。

公式仕様の前提:

- Yahoo!ショッピングのアフィリエイト利用はバリューコマース連携が前提。
- 商品データ取得には Yahoo!ショッピング Web API の商品検索 v3 が利用候補。
- 実装前に必ず公式ドキュメントを再確認する。
  - https://developer.yahoo.co.jp/webapi/shopping/affiliate.html
  - https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html
  - https://pub-docs.valuecommerce.ne.jp/docs/as-63-item-api/

## 2. ゴール

最終的に以下を満たすこと。

- 楽天商品リンクに加えて、Yahoo!ショッピングのアフィリエイトリンクを商品カード・比較表・CTAで表示できる。
- Yahoo機能は `PUBLIC_ENABLE_YAHOO_AFFILIATE` で表示制御できる。
- staging では Yahoo 機能を有効化し、本番では初期無効にできる。
- 商品データモデルを販売元別 offer に拡張し、将来 Amazon などを追加しても破綻しにくい形にする。
- 既存の楽天のみ記事は壊さない。
- 楽天自動更新と Yahoo 自動更新は分離し、段階的に検証できる。
- `pnpm test` と `pnpm build` が通る。

## 3. 非ゴール

初回実装で無理にやらないこと。

- 全記事への Yahoo 商品一括追加。
- 本番 cron で Yahoo 同期を即有効化。
- 既存記事本文のコピー改善。
- 楽天自動更新ロジックの全面リライト。
- CSP の本格導入。
- Amazon など Yahoo 以外のモール対応。

## 4. 推奨ブランチ / 環境構成

### 4.1 ブランチ

- `main`
  - 本番用。
  - GitHub Pages deploy 対象。
  - Yahoo機能は初期 `OFF`。
- `staging`
  - 本番相当検証用。
  - Yahoo機能を `ON` にして検証する。
- `feature/yahoo-affiliate`
  - 実装用。
  - PR preview で表示確認する。

### 4.2 デプロイ環境

推奨:

- 本番: 既存 GitHub Pages
- staging / PR preview: Vercel または Cloudflare Pages

理由:

- GitHub Pages 本番設定を壊さずに preview URL を作れる。
- PRごとに表示確認できる。
- staging 固定URLを `noindex` で運用できる。

### 4.3 環境変数

`.env.example` に追加する候補:

```env
# Yahoo / ValueCommerce
PUBLIC_ENABLE_YAHOO_AFFILIATE=false
YAHOO_CLIENT_ID=your_yahoo_client_id_here
VALUECOMMERCE_SID=your_valuecommerce_sid_here
VALUECOMMERCE_PID=your_valuecommerce_pid_here

# Staging / Preview
PUBLIC_NOINDEX=false
```

注意:

- `YAHOO_CLIENT_ID`, `VALUECOMMERCE_SID`, `VALUECOMMERCE_PID` はサーバ側用途として扱う。
- クライアント公開が必要な値だけ `PUBLIC_` を付ける。
- staging と production の GitHub/Vercel/Cloudflare secrets は分ける。

## 5. データモデル設計

### 5.1 段階移行方針

既存記事は以下のような楽天専用モデル。

```yaml
products:
  - rank: 1
    name: 商品名
    brand: ブランド
    price: 3980
    capacity: 12ロール
    pricePerUnit: 1ロールあたり331円
    rakutenUrl: https://hb.afl.rakuten.co.jp/...
```

将来形は `offers` を追加する。

```yaml
products:
  - rank: 1
    name: 商品名
    brand: ブランド
    price: 3980
    capacity: 12ロール
    pricePerUnit: 1ロールあたり331円
    rakutenUrl: https://hb.afl.rakuten.co.jp/...
    offers:
      - provider: rakuten
        label: 楽天市場
        price: 3980
        url: https://hb.afl.rakuten.co.jp/...
        imageUrl: https://thumbnail.image.rakuten.co.jp/...
        available: true
        updatedAt: 2026-05-17
      - provider: yahoo
        label: Yahoo!ショッピング
        price: 3880
        url: https://ck.jp.ap.valuecommerce.com/...
        imageUrl: https://item-shopping.c.yimg.jp/...
        available: true
        updatedAt: 2026-05-17
```

初期実装では `rakutenUrl` を残し、`offers` は optional にする。

理由:

- 既存53記事の一括移行リスクを避ける。
- `scripts/update-products.mjs` の既存楽天更新を壊さない。
- 表示側から段階的に `offers` を参照できる。

### 5.2 Zod schema

`src/content.config.ts` の `products[]` に `offers` を optional で追加する。

例:

```ts
const offerSchema = z.object({
  provider: z.enum(["rakuten", "yahoo"]),
  label: z.string(),
  price: z.number().int().nonnegative().optional(),
  url: z.string().url(),
  imageUrl: z.string().url().optional(),
  available: z.boolean().optional(),
  updatedAt: z.coerce.date().optional(),
});
```

既存フィールドは維持する。

- `price`
- `pricePerUnit`
- `rakutenUrl`
- `imageUrl`

禁止:

- 初回で `rakutenUrl` を削除しない。
- 初回で `offers` を必須にしない。
- 既存記事の全frontmatterを機械的に大規模変換しない。

## 6. 表示コンポーネント設計

### 6.1 新規コンポーネント

`src/components/product/AffiliateLink.astro` を新規作成する。

責務:

- provider に応じたラベル・色・GAイベント名を出し分ける。
- `rel="sponsored nofollow noopener"` を必ず付ける。
- `target="_blank"` を必ず付ける。
- アクセシブルな `aria-label` を生成する。

props 案:

```ts
interface Props {
  href: string;
  provider: "rakuten" | "yahoo";
  label?: string;
  variant?: "primary" | "outline";
  size?: "sm" | "md" | "lg";
  productName?: string;
}
```

`RakutenLink.astro` はすぐ削除しない。

対応案:

- `RakutenLink.astro` は `AffiliateLink.astro` の薄い wrapper に変更する。
- 既存呼び出し側の段階移行をしやすくする。

### 6.2 ProductCard

`ProductCard.astro` は以下に対応する。

- `offers` がある場合は販売元別ボタンを表示する。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE !== "true"` の場合、Yahoo offer は表示しない。
- `offers` がない場合は既存 `rakutenUrl` から楽天ボタンを表示する。
- 価格表示は当面既存の `product.price` を維持する。

表示ルール:

- 楽天とYahooが両方ある場合は2ボタン表示。
- ボタン順は楽天、Yahoo。
- Yahooだけ存在する場合でも feature flag OFF なら表示しない。
- 全offerが非表示の場合は既存 `rakutenUrl` にフォールバックする。

### 6.3 比較表 / CTA / JSON-LD

対象:

- `ArticleLayout.astro`
- `ComparisonTable.astro`
- `ComparisonTableSort.tsx`
- `TopPickCta.astro`

対応:

- 既存 `rakutenUrl` 参照を一気に削除しない。
- helper 関数で primary offer を取得する。
- JSON-LD の `offers.url` は初期は楽天URLを優先する。
- Yahoo機能ONでも JSON-LD が不正URLや空URLにならないこと。

推奨 helper:

```ts
export function getVisibleOffers(product, options) {}
export function getPrimaryOffer(product, options) {}
export function getRakutenFallbackOffer(product) {}
```

配置候補:

- `src/lib/offers.ts`

## 7. 同期スクリプト設計

### 7.1 初期方針

既存 `scripts/update-products.mjs` に Yahoo API 連携を直接混ぜ込まない。

理由:

- 楽天自動更新の安定性を保つため。
- Yahoo API / ValueCommerce の仕様差分を閉じ込めるため。
- staging で単独検証しやすくするため。

### 7.2 新規スクリプト候補

```text
scripts/update-yahoo-products.mjs
scripts/lib/yahoo-shopping.ts
scripts/lib/offers.ts
```

役割:

- `update-yahoo-products.mjs`
  - 記事frontmatterを読み、商品名/JAN/キーワード等からYahoo候補を取得。
  - dry-run をデフォルトに近い安全設計にする。
  - staging で明示実行してから本番検討。
- `scripts/lib/yahoo-shopping.ts`
  - Yahoo API / ValueCommerce API 呼び出しとレスポンス正規化。
- `scripts/lib/offers.ts`
  - frontmatterの `offers` 追加・更新処理。

CLI案:

```bash
pnpm update-yahoo-products -- --dry-run
pnpm update-yahoo-products -- --article=toilet-paper-comparison
pnpm update-yahoo-products -- --limit=5 --api-interval=1000
```

### 7.3 package.json

追加候補:

```json
{
  "scripts": {
    "update-yahoo-products": "node scripts/update-yahoo-products.mjs",
    "update-yahoo-products:dry": "node scripts/update-yahoo-products.mjs --dry-run"
  }
}
```

### 7.4 安全条件

- デフォルトは `--dry-run` 相当、または実更新には `--write` を必須にする。
- `src/content/articles/*.md.bak` は読まない・書かない。
- API失敗時に既存楽天データを消さない。
- Yahoo候補の同一性が低い場合は自動追加せず、reports に出す。
- 価格・容量が不整合な場合は自動反映しない。

## 8. Workflow設計

### 8.1 本番 deploy

`.github/workflows/deploy.yml` は原則最小変更。

追加する場合:

- `PUBLIC_ENABLE_YAHOO_AFFILIATE` を secrets/vars から渡す。
- 本番では初期 `false`。
- `PUBLIC_NOINDEX=false`。

### 8.2 staging deploy

新規 workflow 候補:

```text
.github/workflows/deploy-staging.yml
```

条件:

- `staging` push で実行。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=true`。
- `PUBLIC_NOINDEX=true`。
- deploy先は Vercel / Cloudflare Pages / 別GitHub Pages のいずれか。

### 8.3 Yahoo商品同期

新規 workflow 候補:

```text
.github/workflows/update-yahoo-products-staging.yml
```

条件:

- `workflow_dispatch` のみから開始。
- 初期は schedule なし。
- 対象ブランチは `staging`。
- `--dry-run` を標準にし、手動入力で `write=true` のときのみ更新。

禁止:

- 初回から `main` に Yahoo同期結果を自動pushしない。
- 既存 `.github/workflows/update-products.yml` に Yahoo API secret を混ぜない。

## 9. SEO / noindex

staging / preview は検索エンジンに出さない。

実装候補:

- `PUBLIC_NOINDEX=true` のとき `BaseLayout.astro` または `BaseSeo.astro` で noindex を強制。
- 個別ページ props の `noindex` より環境変数を優先する。

確認:

- staging HTML に `<meta name="robots" content="noindex,nofollow">` 相当が入る。
- 本番 HTML には入らない。

## 10. テスト計画

### 10.1 単体テスト

追加候補:

- `tests/offers.test.ts`
- `tests/yahoo-shopping.test.ts`
- `tests/frontmatter.test.ts` への追記

テスト観点:

- `offers` がない既存商品から楽天 fallback offer を生成できる。
- feature flag OFF では Yahoo offer を表示対象から除外する。
- feature flag ON では Yahoo offer を表示対象に含める。
- 楽天 + Yahoo の primary offer は楽天優先。
- URL が空・不正なら schema または helper で検出する。
- `rel="sponsored nofollow noopener"` が維持される。

### 10.2 fixture

APIレスポンスを直接テストで外部取得しない。

追加候補:

```text
tests/fixtures/yahoo/item-search-success.json
tests/fixtures/yahoo/item-search-empty.json
tests/fixtures/yahoo/item-search-error.json
```

### 10.3 手動確認

最低限確認するページ:

- トップページ
- 記事詳細ページ
- 比較表
- 商品カード
- 検索ページ
- RSS
- OGP生成

コマンド:

```bash
pnpm test
pnpm build
pnpm update-yahoo-products:dry
```

## 11. 実装フェーズ

### Phase 1: 環境分離とfeature flag

作業:

- `.env.example` に Yahoo / staging 用 env を追加。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE` を読み取る helper を追加。
- `PUBLIC_NOINDEX` による noindex 強制を追加。
- staging workflow 草案を追加するか、docs に運用手順を追加。

完了条件:

- 本番 env 未設定時に Yahoo 機能は無効。
- `pnpm build` が通る。
- `PUBLIC_NOINDEX=true` で noindex が入る。

### Phase 2: offers schema と helper

作業:

- `src/content.config.ts` に optional `offers` schema を追加。
- `src/lib/offers.ts` を追加。
- `tests/offers.test.ts` を追加。

完了条件:

- 既存記事を変更せず `pnpm build` が通る。
- offer helper のテストが通る。

### Phase 3: UI抽象化

作業:

- `AffiliateLink.astro` を追加。
- `RakutenLink.astro` を wrapper 化。
- `ProductCard.astro` を offers 対応。
- `TopPickCta.astro`, `ComparisonTable*.astro/tsx`, `ArticleLayout.astro` を最小修正。
- GAイベント名を `click_affiliate_link` など provider 非依存にする。ただし既存計測を維持したい場合は楽天だけ従来名を残す。

完了条件:

- 楽天のみ記事の表示が変わらない。
- `offers` 入りテスト記事で楽天・Yahooボタンが表示できる。
- feature flag OFF で Yahooボタンが出ない。
- feature flag ON で Yahooボタンが出る。

### Phase 4: Yahoo API 正規化レイヤ

作業:

- `scripts/lib/yahoo-shopping.ts` を追加。
- APIレスポンスを内部 offer 形式へ変換する。
- fixture テストを追加。

完了条件:

- 外部APIなしで fixture テストが通る。
- APIエラー時に既存データを壊さない設計になっている。

### Phase 5: Yahoo同期スクリプト

作業:

- `scripts/update-yahoo-products.mjs` を追加。
- `--dry-run`, `--write`, `--article`, `--limit`, `--api-interval` を実装。
- reports 出力を追加。
- `package.json` に scripts を追加。

完了条件:

- `pnpm update-yahoo-products:dry` が記事を書き換えずにレポートを出す。
- `--write --article=<slug>` で対象記事だけ更新できる。
- 不一致候補は自動反映されず reports に出る。

### Phase 6: staging検証

作業:

- `staging` ブランチで Yahoo feature flag を ON。
- staging deploy。
- staging で `update-yahoo-products:dry`。
- 1から3記事だけ `--write` で Yahoo offer を追加。
- 表示・リンク・noindex・buildを確認。

完了条件:

- staging で楽天・Yahooリンクが表示される。
- 本番 `main` には影響がない。
- staging に noindex が入っている。
- `pnpm test` と `pnpm build` が通る。

### Phase 7: 本番段階投入

作業:

- `main` にコードだけマージし、feature flag は OFF。
- 本番 build/deploy 後、既存楽天表示が壊れていないことを確認。
- その後、対象記事を限定して Yahoo offer を追加。
- 最後に `PUBLIC_ENABLE_YAHOO_AFFILIATE=true` を本番で有効化するか判断。

完了条件:

- 本番で既存楽天リンクが維持される。
- Yahoo表示ON後も主要記事・比較表・検索が壊れない。
- 計測イベントが送信される。

## 12. レビュー観点

実装後、レビューAIまたは人間は以下を確認する。

- `src/content.config.ts` の変更が後方互換になっているか。
- `rakutenUrl` 削除や必須変更が入っていないか。
- `scripts/update-products.mjs` の既存楽天更新に不要な影響がないか。
- Yahoo API失敗時にfrontmatterが壊れないか。
- `.md.bak`, `node_modules`, `dist`, `.astro` を触っていないか。
- 本番 workflow に staging 用 noindex や Yahoo ON が混入していないか。
- staging workflow が `main` に push しないか。
- 全外部リンクに `rel="sponsored nofollow noopener"` があるか。
- 画像に `alt`, `width`, `height` があるか。
- `client:load` を追加していないか。

## 13. 実装AIへの作業ルール

- 作業前に `AGENTS.md` を読む。
- ファイル変更前に対象ファイルを必ず読む。
- `pnpm` 以外を使わない。
- スキーマ変更は optional 追加に留める。
- 日本語記事本文は原則変更しない。
- 大規模一括置換を避ける。
- 1フェーズごとに `pnpm test` または関連テストを実行する。
- 最後に `pnpm build` を実行する。
- 外部APIに依存するテストを書かない。
- secrets をコードや docs に実値で書かない。
- 仕様不明点は公式ドキュメントを確認し、推測で実装しない。

## 14. 完了報告テンプレート

実装AIは作業完了時に以下を報告する。

```text
実装概要:
- 

変更ファイル:
- 

環境変数:
- 

実行した検証:
- pnpm test: 成功/失敗
- pnpm build: 成功/失敗
- pnpm update-yahoo-products:dry: 成功/失敗

本番影響:
- 

残課題:
- 
```

## 15. 初回タスク分割案

最初のPRでは Phase 1 から Phase 3 までに絞るのが安全。

PR 1:

- feature flag
- noindex
- optional offers schema
- offer helper
- AffiliateLink
- 楽天表示の後方互換
- テスト

PR 2:

- Yahoo API 正規化レイヤ
- fixture テスト
- dry-run reports

PR 3:

- Yahoo同期スクリプト
- staging workflow
- 1から3記事でstaging検証

PR 4:

- 本番 feature flag OFF でコード投入
- 限定記事で Yahoo offer 追加
- 本番ON判断

