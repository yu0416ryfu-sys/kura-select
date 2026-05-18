# Yahooアフィリエイト統合 実装計画書 v3（AI実行用）

対象リポジトリ: `C:\Projects\KuraSelect`

目的: KuraSelect に Yahoo!ショッピング / ValueCommerce アフィリエイトの商品リンク・価格表示を追加する。ただし、本番 GitHub Pages / `main` ブランチ / 既存楽天アフィリエイト運用に影響を出さないことを最優先にする。

この計画書は AI 実装者へ渡す前提の指示書です。実装AIは本書を上から順に読み、フェーズ単位で作業・検証・報告してください。

## 0. 絶対方針

- 本番 `main` の挙動を即変更しない。
- Yahoo機能は feature flag で制御し、本番では初期 `OFF` にする。
- 初回実装で `products[].rakutenUrl` を削除しない。
- 初回実装で `products[].offers` を必須にしない。
- 全記事の一括マイグレーションをしない。
- 既存の楽天自動更新 `scripts/update-products.mjs` に Yahoo 同期を直接混ぜない。
- Yahoo同期は新規 `scripts/update-yahoo-products.mjs` として分離する。
- `.github/workflows/update-products.yml` の本番楽天 cron に Yahoo secret / Yahoo 同期を混ぜない。
- staging / preview は必ず `noindex` にする。
- アフィリエイトリンクは楽天・Yahooとも `rel="sponsored nofollow noopener"` を維持する。
- 外部APIに依存するテストを書かない。fixture を使う。
- `pnpm` 固定。`npm` / `yarn` は使わない。

## 1. 実行規則

1. 作業開始前に `AGENTS.md` を読む。
2. ファイルを編集する前に必ず現在の内容を読む。
3. `node_modules`, `dist`, `.astro/`, `*.md.bak` は読まない・編集しない。
4. 日本語記事本文は原則変更しない。
5. 大規模一括置換を避け、1ファイルで確認してから横展開する。
6. 各フェーズ末尾の完了確認コマンドを実行する。
7. 失敗した検証は隠さず報告する。
8. secrets の実値をコード・docs・ログに書かない。
9. 仕様不明点は公式ドキュメントを確認し、推測で実装しない。
10. 手動作業マークの項目はAIが勝手に代行しない。

## 2. 現状サマリー

技術スタック:

- Astro 6.1 SSG
- Preact 10
- Tailwind CSS v4
- TypeScript strict
- Content Collections + Zod
- pnpm
- Node 22+
- 本番 deploy: GitHub Pages

既存の重要ファイル:

| ファイル | 役割 |
|---|---|
| `src/content.config.ts` | 記事・カテゴリの Zod schema。唯一の正 |
| `src/content/articles/*.md` | 比較記事 |
| `src/components/product/ProductCard.astro` | 商品カード。現状は楽天リンク前提 |
| `src/components/product/RakutenLink.astro` | 楽天リンクコンポーネント |
| `src/components/product/ComparisonTable.astro` | 比較表 |
| `src/components/product/ComparisonTableSort.tsx` | 比較表のソート island |
| `src/components/product/TopPickCta.astro` | 1位商品CTA |
| `src/layouts/ArticleLayout.astro` | 記事レイアウト、JSON-LD、CTA、商品一覧 |
| `src/pages/search.astro` | 検索ページ |
| `scripts/update-products.mjs` | 楽天商品データ更新 |
| `scripts/lib/frontmatter.ts` | frontmatter 操作 |
| `.github/workflows/deploy.yml` | `main` push で GitHub Pages deploy |
| `.github/workflows/update-products.yml` | 楽天商品データの本番 cron 更新 |
| `tests/frontmatter.test.ts` | frontmatter utility tests |

現在の `products[]` は楽天前提:

```yaml
products:
  - rank: 1
    name: 商品名
    brand: ブランド
    price: 3980
    capacity: 12ロール
    pricePerUnit: 1ロールあたり331円
    rakutenUrl: https://hb.afl.rakuten.co.jp/...
    imageUrl: https://thumbnail.image.rakuten.co.jp/...
```

## 3. 公式仕様確認

実装前に以下を確認すること。

- Yahoo!ショッピングのアフィリエイト利用は ValueCommerce 連携が前提。
- 商品取得は Yahoo!ショッピング Web API v3 または ValueCommerce 商品APIを候補にする。
- 実際に使う API と affiliate URL 生成方式は、公式ドキュメント確認後に確定する。

参照:

- https://developer.yahoo.co.jp/webapi/shopping/affiliate.html
- https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html
- https://pub-docs.valuecommerce.ne.jp/docs/as-63-item-api/

注意:

- APIパラメータ名・認証方式・アフィリエイトURL生成方式は変更される可能性がある。
- 計画書内のコード例は設計意図を示すもので、公式仕様と現コードを確認してから実装する。

## 4. 最終ゴール

- 楽天リンクに加えて Yahoo!ショッピングリンクを商品カード・比較表・CTAで表示できる。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=false` または未設定なら、既存楽天表示だけになる。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=true` なら、`offers[]` 内の Yahoo offer を表示できる。
- 既存の楽天のみ記事は変更なしで `pnpm build` できる。
- Yahoo同期は `update-yahoo-products` として楽天同期から分離されている。
- staging で実データ同期・ビルド・表示・リンクを確認できる。
- 本番投入時は feature flag OFF のままコードだけ先にマージできる。
- `pnpm test` と `pnpm build` が通る。

## 5. 対象外

初回では実施しない。

- 全記事への Yahoo offer 一括追加
- `rakutenUrl` の削除
- `offers[]` の必須化
- 本番 Yahoo 自動更新 cron
- 既存 `update-products.mjs` の全面リライト
- 記事本文コピーの改善
- Amazon など Yahoo 以外のモール対応
- CSP の本格設定

## 6. ブランチ / 環境構成

### 6.1 ブランチ

| ブランチ | 用途 | Yahoo機能 |
|---|---|---|
| `main` | 本番 GitHub Pages | 初期OFF |
| `staging` | 本番相当検証 | ON |
| `feature/yahoo-affiliate` | 実装PR | ON/OFF両方確認 |

### 6.2 デプロイ環境

推奨:

- 本番: 既存 GitHub Pages
- staging / PR preview: Vercel または Cloudflare Pages

理由:

- 本番 GitHub Pages 設定を壊さず preview URL を作れる。
- PRごとに表示確認できる。
- staging 固定URLを `noindex` で運用できる。

### 6.3 手動作業: Vercel を使う場合

ユーザーが実施する。

1. Vercel で GitHub リポジトリを接続。
2. Framework Preset: `Astro`。
3. Install Command: `pnpm install`。
4. Build Command: `pnpm build`。
5. Output Directory: `dist`。
6. Production Branch は `staging` にする。
7. Preview Deployments を有効化。
8. 必要なら `staging.kura-select.com` を追加。
9. DNS に CNAME を設定する。

### 6.4 GitHub Environments / Secrets

ユーザーが設定する。

`production`:

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`
- `PUBLIC_RAKUTEN_AFFILIATE_ID`
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=false`
- `PUBLIC_NOINDEX=false`

`staging`:

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`
- `PUBLIC_RAKUTEN_AFFILIATE_ID`
- `YAHOO_SHOPPING_APP_ID` または公式仕様に合わせた Yahoo API credential
- `VALUECOMMERCE_SID`
- `VALUECOMMERCE_PID`
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=true`
- `PUBLIC_NOINDEX=true`

## 7. 環境変数

`.env.example` に追加する。

```env
# Yahoo affiliate display flag
PUBLIC_ENABLE_YAHOO_AFFILIATE=false

# Force noindex for staging / preview builds
PUBLIC_NOINDEX=false

# Yahoo Shopping / ValueCommerce server-side credentials
YAHOO_SHOPPING_APP_ID=your_yahoo_app_id_here
VALUECOMMERCE_SID=your_valuecommerce_sid_here
VALUECOMMERCE_PID=your_valuecommerce_pid_here
```

注意:

- `PUBLIC_` はクライアント公開される。
- API credential は `PUBLIC_` を付けない。
- SSG のため feature flag はビルド時に確定する。

## 8. データモデル設計

### 8.1 初期方針

初回は既存モデルを壊さず、`offers` を optional 追加する。

```yaml
products:
  - rank: 1
    name: 商品名
    brand: ブランド
    price: 3980
    capacity: 12ロール
    pricePerUnit: 1ロールあたり331円
    rakutenUrl: https://hb.afl.rakuten.co.jp/...
    imageUrl: https://thumbnail.image.rakuten.co.jp/...
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

ルール:

- `rakutenUrl` は残す。
- `offers` は optional。
- 既存記事は未変更でも valid。
- `offers` がない場合は `rakutenUrl` から楽天 offer を生成して表示する。
- `offers` がある場合も、楽天 offer が欠けていれば `rakutenUrl` を fallback に使う。

### 8.2 Zod schema 方針

`src/content.config.ts` に `offerSchema` を追加し、`products[]` に `offers: z.array(offerSchema).optional()` を追加する。

例:

```ts
const offerSchema = z.object({
  provider: z.enum(["rakuten", "yahoo"]),
  label: z.string().optional(),
  price: z.number().int().nonnegative().optional(),
  url: z.string().url(),
  imageUrl: z.string().url().optional(),
  available: z.boolean().optional(),
  updatedAt: z.coerce.date().optional(),
});
```

既存フィールドは維持:

- `price`
- `pricePerUnit`
- `rakutenUrl`
- `imageUrl`

禁止:

- `rakutenUrl` を削除しない。
- `offers` を `.min(1)` にしない。
- `offers` を必須にしない。
- 全記事を機械的に変換しない。

## 9. offer helper 設計

新規ファイル候補:

```text
src/lib/offers.ts
```

責務:

- Astro コンポーネント・ページから import する表示用 helper と型を置く。
- 既存 `rakutenUrl` から fallback offer を生成する。
- feature flag に応じて Yahoo offer を表示対象から除外する。
- primary offer を安全に取得する。
- JSON-LD や CTA で空URLを返さない。

注意:

- `src/lib/offers.ts` は UI / SSG 表示用。
- frontmatter 書き込み用 helper は `scripts/lib/yahoo-offers.ts` に置く。
- `scripts/lib/offers.ts` という名前は使わない。`src/lib/offers.ts` と混同しやすいため。

関数案:

```ts
export type OfferProvider = "rakuten" | "yahoo";

export interface ProductOffer {
  provider: OfferProvider;
  label?: string;
  price?: number;
  url: string;
  imageUrl?: string;
  available?: boolean;
  updatedAt?: Date | string;
}

export function getRakutenFallbackOffer(product: {
  rakutenUrl?: string;
  price?: number;
  imageUrl?: string;
}): ProductOffer | null {}

export function getVisibleOffers(
  product: {
    offers?: ProductOffer[];
    rakutenUrl?: string;
    price?: number;
    imageUrl?: string;
  },
  options: { enableYahoo: boolean }
): ProductOffer[] {}

export function getPrimaryOffer(
  product: {
    offers?: ProductOffer[];
    rakutenUrl?: string;
    price?: number;
    imageUrl?: string;
  },
  options: { enableYahoo: boolean }
): ProductOffer | null {}
```

表示順:

1. 楽天
2. Yahoo

primary offer:

- 楽天を優先。
- 楽天がなければ visible offer の先頭。
- 何もなければ `null`。

## 10. UI設計

### 10.1 新規 `AffiliateLink.astro`

新規:

```text
src/components/product/AffiliateLink.astro
```

責務:

- provider に応じたラベル・色・GAイベントを出し分ける。
- `rel="sponsored nofollow noopener"` を必ず付与。
- `target="_blank"` を必ず付与。
- `aria-label` を生成。
- 楽天・Yahoo以外の provider は schema で防ぐ。

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

GAイベント:

- 既存計測維持を優先するなら楽天は `click_rakuten_link`。
- Yahooは `click_yahoo_link`。
- 将来統一するなら `click_affiliate_link` + `data-ga-provider` を追加。

### 10.2 `RakutenLink.astro`

削除しない。

対応:

- 既存 props を維持。
- 内部で `AffiliateLink.astro` を呼ぶ thin wrapper にする。
- 既存呼び出し側の段階移行を可能にする。

### 10.3 `ProductCard.astro`

対応:

- `offers` がある場合は `getVisibleOffers()` で表示対象を取得。
- Yahoo feature flag OFF なら Yahoo offer は表示しない。
- `offers` がない場合は `rakutenUrl` fallback で楽天ボタンを表示。
- 価格表示は当面 `product.price` のまま。
- ボタン順は楽天、Yahoo。
- 全offerが非表示なら楽天 fallback を試す。

### 10.4 `ArticleLayout.astro`

対応:

- JSON-LD の `offers.url` は `getPrimaryOffer()` を使う。
- primary offer がない商品は JSON-LD product から除外するか、安全にURLなしを避ける。
- CTA は primary offer または visible offers を使う。
- `rakutenUrl` 直接参照は段階的に helper 経由へ移行。

### 10.5 `ComparisonTable.astro` / `ComparisonTableSort.tsx`

対応:

- 表示リンクは `getVisibleOffers()` に統一。
- feature flag OFF では既存楽天のみ表示と同等にする。
- `ComparisonTableSort.tsx` に渡す props がシリアライズ可能であること。
- 新規 island は追加しない。

### 10.6 `TopPickCta.astro`

対応:

- primary offer を使う。
- 既存の見た目を大きく変えない。
- Yahooだけの offer は feature flag ON のときだけ表示。

### 10.7 `search.astro`

対応:

- 実装前に `src/pages/search.astro` を読み、`products`, `rakutenUrl`, `price`, `imageUrl` の参照箇所を確認する。
- 商品検索結果にリンクを出している場合は `getVisibleOffers()` または `getPrimaryOffer()` に置き換える。
- 検索インデックス用JSONに `offers` を含める場合、SSGでシリアライズ可能な値だけにする。
- feature flag OFF では楽天のみ記事の検索結果が既存同等になること。
- feature flag ON でも Yahoo offer がない記事で検索結果が壊れないこと。

## 11. noindex 設計

staging / preview は検索エンジンに出さない。

推奨:

- `PUBLIC_NOINDEX=true` のとき、`BaseSeo.astro` で robots meta を強制する。
- 個別ページ props の `noindex` より環境変数を優先する。

確認:

- staging HTML に `noindex,nofollow` が入る。
- 本番 HTML に入らない。

Vercel を使う場合:

- `X-Robots-Tag: noindex, nofollow` ヘッダーを追加してもよい。
- ただし Vercel を将来本番に使う可能性があるため、ヘッダー固定ではなく環境変数で制御すること。

## 12. Yahoo API / 同期スクリプト設計

### 12.1 分離方針

既存 `scripts/update-products.mjs` には Yahoo 同期を直接追加しない。

新規候補:

```text
scripts/update-yahoo-products.mjs
scripts/lib/yahoo-shopping.ts
scripts/lib/yahoo-offers.ts
```

理由:

- 楽天本番 cron の安定性を守る。
- Yahoo API / ValueCommerce の仕様差分を閉じ込める。
- stagingで単独検証しやすい。
- 失敗時に既存楽天データを壊しにくい。

### 12.2 `scripts/lib/yahoo-shopping.ts`

責務:

- Yahoo API または ValueCommerce API を呼ぶ。
- レスポンスを内部 offer 候補形式に正規化する。
- affiliate URL 生成方式を閉じ込める。
- APIエラーを安全に返す。

注意:

- 公式仕様確認後にパラメータを確定する。
- `fetch` は Node 22 前提で利用可。
- テストは fixture / mocked fetch を使う。

### 12.3 `scripts/update-yahoo-products.mjs`

CLI案:

```bash
pnpm update-yahoo-products -- --dry-run
pnpm update-yahoo-products -- --write --article=toilet-paper-comparison
pnpm update-yahoo-products -- --dry-run --limit=5 --api-interval=1000
```

package.json 追加:

```json
{
  "scripts": {
    "update-yahoo-products": "node scripts/update-yahoo-products.mjs",
    "update-yahoo-products:dry": "node scripts/update-yahoo-products.mjs --dry-run"
  }
}
```

安全仕様:

- 実書き込みには `--write` を必須にする。
- `--dry-run` は記事を書き換えず reports だけ出す。
- `*.md.bak` は対象外。
- API失敗時に既存楽天データを消さない。
- Yahoo候補の同一性が低い場合は自動反映しない。
- 価格・容量が明らかに不整合なら自動反映しない。
- 最初は `--article=<slug>` で1記事だけ更新できるようにする。

reports 出力候補:

```text
reports/yahoo-products-dry-run-YYYYMMDD-HHmmss.md
reports/yahoo-products-write-YYYYMMDD-HHmmss.md
```

レポートに含める:

- 対象記事
- 対象商品
- 検索キーワード
- 候補商品名
- 候補URL
- 候補価格
- 自動採用 / 要確認 / 除外理由

### 12.4 `scripts/lib/yahoo-offers.ts`

責務:

- `update-yahoo-products.mjs` から import する frontmatter 書き込み用 helper を置く。
- 記事frontmatterの `products[].offers` に Yahoo offer を追加・更新する。
- 既存 `rakutenUrl` と楽天 offer を削除しない。
- `src/lib/offers.ts` は import しない。Astro側の表示 helper とスクリプト側の書き込み helper を分離する。

命名理由:

- `scripts/lib/offers.ts` という名前は使わない。
- `src/lib/offers.ts` と同名にすると、AI実装時に import 先を誤るリスクがある。

## 13. Workflow設計

### 13.1 本番 deploy

`.github/workflows/deploy.yml` は最小変更。

追加する場合:

- `PUBLIC_ENABLE_YAHOO_AFFILIATE` を渡す。
- 本番は `false`。
- `PUBLIC_NOINDEX=false`。

禁止:

- 本番 deploy workflow に staging 用 noindex を混入しない。
- 本番 deploy workflow に Yahoo API secret を不要に渡さない。

### 13.2 staging deploy

Vercel / Cloudflare Pages の設定で対応できるなら workflow 追加は不要。

GitHub Actionsで作る場合:

```text
.github/workflows/deploy-staging.yml
```

条件:

- `staging` push で実行。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE=true`。
- `PUBLIC_NOINDEX=true`。
- deploy先は本番と別。

### 13.3 Yahoo同期 staging workflow

新規候補:

```text
.github/workflows/update-yahoo-products-staging.yml
```

条件:

- `workflow_dispatch` のみ。
- 初期 schedule なし。
- 対象ブランチは `staging`。
- 初期は dry-run。
- 手動入力 `write=true` の場合のみ `--write`。
- `main` に push しない。

workflow方針:

```yaml
on:
  workflow_dispatch:
    inputs:
      write:
        description: "Write changes to staging"
        required: true
        default: "false"
      article:
        description: "Optional article slug"
        required: false
```

実行コマンド方針:

- `write=false`: `pnpm update-yahoo-products -- --dry-run`
- `write=true`: `pnpm update-yahoo-products -- --write --article=<slug>`

## 14. テスト計画

### 14.1 追加テスト

候補:

```text
tests/offers.test.ts
tests/yahoo-shopping.test.ts
tests/frontmatter.test.ts への追記
```

### 14.2 offer helper テスト

観点:

- `offers` がない商品から楽天 fallback offer を生成できる。
- `offers` がある商品でも楽天 fallback が欠けていれば補完できる。
- feature flag OFF では Yahoo offer を除外する。
- feature flag ON では Yahoo offer を含める。
- 表示順は楽天、Yahoo。
- primary offer は楽天優先。
- URL が不正な offer は schema または helper で検出される。

### 14.3 Yahoo API 正規化テスト

fixture:

```text
tests/fixtures/yahoo/item-search-success.json
tests/fixtures/yahoo/item-search-empty.json
tests/fixtures/yahoo/item-search-error.json
```

観点:

- 成功レスポンスを内部候補形式へ変換できる。
- 空レスポンスで空配列になる。
- エラーレスポンスで既存データを壊さない。
- ValueCommerce URL に `sid` / `pid` / 遷移先URLが含まれる。
- 同一性判定が明らかな別商品を採用しない。

### 14.4 回帰テスト

観点:

- 既存記事に `offers` がなくても schema valid。
- 既存楽天ボタンが表示可能。
- `rakutenUrl` が残っている記事で build が通る。
- `rel="sponsored nofollow noopener"` が維持される。

### 14.5 手動確認

最低限:

- トップページ
- 記事詳細
- 商品カード
- 比較表
- 1位CTA
- 検索ページ
- RSS
- OGP生成
- staging noindex

## 15. 実装フェーズ

### Phase 1: 環境変数・noindex・feature flag

作業:

- `.env.example` に Yahoo / noindex 用 env を追加。
- `PUBLIC_ENABLE_YAHOO_AFFILIATE` を読む helper を追加。
- `PUBLIC_NOINDEX=true` で noindex を強制する。
- staging / preview 運用手順を docs に残す。

完了確認:

```bash
pnpm build
```

noindex 確認:

PowerShell:

```powershell
$env:PUBLIC_NOINDEX = "true"
pnpm build
Select-String -Path dist\index.html -Pattern "noindex"

$env:PUBLIC_NOINDEX = "false"
pnpm build
Select-String -Path dist\index.html -Pattern "noindex"
```

Bash:

```bash
PUBLIC_NOINDEX=true pnpm build
grep -r "noindex" dist/index.html

PUBLIC_NOINDEX=false pnpm build
grep -r "noindex" dist/index.html
```

期待結果:

- `PUBLIC_NOINDEX=true` では `noindex,nofollow` 相当が出力される。
- `PUBLIC_NOINDEX=false` では `dist/index.html` に noindex が出力されない。
- 可能なら記事ページの `dist/articles/**/index.html` でも同様に確認する。

完了条件:

- env 未設定時に Yahoo は無効。
- `PUBLIC_NOINDEX=true` の build で noindex が入る。
- 本番 env では noindex が入らない設計。

### Phase 2: optional offers schema と helper

作業:

- `src/content.config.ts` に optional `offers` schema を追加。
- `src/lib/offers.ts` を追加。
- `tests/offers.test.ts` を追加。

完了確認:

```bash
pnpm test
pnpm build
```

完了条件:

- 既存記事を変更せず build が通る。
- `rakutenUrl` は残っている。
- `offers` は optional。
- helper テストが通る。

### Phase 3: UI抽象化

作業:

- `src/components/product/AffiliateLink.astro` を追加。
- `RakutenLink.astro` を wrapper 化。
- `ProductCard.astro` を offers 対応。
- `ArticleLayout.astro` の JSON-LD / CTA を helper 経由にする。
- `ComparisonTable.astro` / `ComparisonTableSort.tsx` を必要最小限修正。
- `TopPickCta.astro` を必要最小限修正。

完了確認:

```bash
pnpm test
pnpm build
pnpm dev
```

目視確認:

- 既存楽天のみ記事の表示が変わらない。
- `offers` 入りのテスト記事または一時fixtureで楽天・Yahooボタンが表示できる。
- feature flag OFF で Yahooボタンが出ない。
- feature flag ON で Yahooボタンが出る。
- 外部リンクの `rel` が正しい。

### Phase 4: Yahoo API 正規化レイヤ

作業:

- 公式仕様を再確認。
- `scripts/lib/yahoo-shopping.ts` を追加。
- Yahoo / ValueCommerce レスポンスを内部 offer 候補へ正規化。
- fixture テストを追加。

完了確認:

```bash
pnpm test
pnpm build
```

完了条件:

- 外部APIなしでテストが通る。
- APIエラー時に例外または安全な失敗として扱える。
- secrets 未設定時のエラーが明確。

### Phase 5: Yahoo同期スクリプト

作業:

- `scripts/update-yahoo-products.mjs` を追加。
- `--dry-run`, `--write`, `--article`, `--limit`, `--api-interval` を実装。
- reports 出力を追加。
- `package.json` に scripts を追加。
- `scripts/lib/yahoo-offers.ts` に frontmatter へ Yahoo offer を追記・更新する helper を追加する。
- `scripts/lib/frontmatter.ts` を変更する場合は必要最小限に留める。既存楽天関数は壊さない。

完了確認:

```bash
pnpm update-yahoo-products:dry
pnpm test
pnpm build
```

完了条件:

- dry-run は記事を書き換えない。
- `--write --article=<slug>` で対象記事だけ更新できる。
- 不一致候補は自動反映されず reports に出る。
- 既存楽天データは消えない。

### Phase 6: staging workflow / staging検証

作業:

- 必要なら `.github/workflows/update-yahoo-products-staging.yml` を追加。
- `staging` ブランチで Yahoo feature flag ON。
- staging で dry-run。
- 1から3記事だけ `--write` で Yahoo offer を追加。
- staging deploy。

完了確認:

```bash
pnpm test
pnpm build
```

staging確認:

- 楽天・Yahooリンクが表示される。
- noindex が入っている。
- 本番 `main` に影響がない。
- 主要ページが表示される。
- クリック先が affiliate URL になっている。

### Phase 7: 本番段階投入

作業:

- `main` にコードだけマージ。
- 本番 feature flag は OFF。
- 本番 deploy 後、既存楽天表示を確認。
- 問題なければ限定記事に Yahoo offer を追加。
- 本番で `PUBLIC_ENABLE_YAHOO_AFFILIATE=true` にするか判断。

完了条件:

- 本番で既存楽天リンクが維持される。
- Yahoo OFF で既存表示が壊れない。
- Yahoo ON 後も主要記事・比較表・検索が壊れない。

## 16. 禁止事項

| 禁止事項 | 理由 |
|---|---|
| `rakutenUrl` を削除する | 既存記事・楽天更新・表示が壊れる |
| `offers[]` を必須にする | 全記事マイグレーションが必要になりリスクが高い |
| 全記事を一括変換する | 差分が巨大になりレビュー困難 |
| `update-products.mjs` にYahoo同期を混ぜる | 本番楽天cronを不安定にする |
| 本番 `update-products.yml` にYahoo secretを追加する | 本番データ汚染リスク |
| stagingをnoindexなしで公開する | SEO上の重複・低品質リスク |
| 外部APIを叩くテストを書く | CIが不安定になる |
| `.md.bak` を編集・削除する | AGENTS.md方針違反 |
| `npm` / `yarn` を使う | lockfile破損リスク |
| `client:load` を追加する | パフォーマンス方針違反 |

## 17. ユーザー確認が必要な判断ポイント

| タイミング | 確認内容 |
|---|---|
| Phase 1前 | Vercel / Cloudflare Pages を使うか |
| Phase 1前 | `staging.kura-select.com` を作るか |
| Phase 4前 | Yahoo API v3 と ValueCommerce 商品APIのどちらを主に使うか |
| Phase 5前 | Yahoo候補の自動採用基準 |
| Phase 6前 | stagingで `--write` する対象記事 |
| Phase 7前 | 本番 feature flag をONにするタイミング |

## 18. ロールバック手順

### 18.1 コード変更のロールバック

未コミットの場合:

```bash
git diff
git status
```

ユーザー確認後に対象ファイルだけ戻す。AIは勝手に `git reset --hard` しない。

コミット済みの場合:

```bash
git revert <commit-sha>
```

### 18.2 staging ブランチの復旧

原則:

- `git reset --hard` や force push はユーザー承認なしに実行しない。

必要な場合のみ、ユーザー承認後:

```bash
git checkout staging
git reset --hard origin/main
git push origin staging --force-with-lease
```

### 18.3 Yahoo offer 追加の取り消し

推奨:

- `reports/yahoo-products-write-*.md` で変更対象を確認。
- 対象記事の `offers` 内 Yahoo offer だけを削除。
- `rakutenUrl` は触らない。
- `pnpm build` で確認。

### 18.4 本番 feature flag の緊急停止

本番で問題が出た場合:

1. hosting / GitHub Environment の `PUBLIC_ENABLE_YAHOO_AFFILIATE=false` に戻す。
2. 本番を再ビルド・再デプロイする。
3. 必要なら Yahoo offer データは後で削除する。feature flag OFF なら表示されない。

## 19. レビュー観点

レビュー時に必ず確認する。

- `src/content.config.ts` が後方互換。
- `rakutenUrl` が削除されていない。
- `offers` が optional。
- 既存記事の大規模変更がない。
- `scripts/update-products.mjs` への不要な変更がない。
- 新規 Yahoo 同期が `scripts/update-yahoo-products.mjs` に分離されている。
- 本番 workflow に Yahoo 同期が混ざっていない。
- staging workflow が `main` に push しない。
- API失敗時に既存楽天データを消さない。
- affiliate link の `rel` が正しい。
- 画像に `alt`, `width`, `height` がある。
- `pnpm test` / `pnpm build` が成功。
- `PUBLIC_NOINDEX=true` で noindex。
- `PUBLIC_NOINDEX=false` で noindex なし。

## 20. 完了報告テンプレート

実装AIは各フェーズ完了時に以下で報告する。

```text
実装フェーズ:
-

実装概要:
-

変更ファイル:
-

環境変数:
-

実行した検証:
- pnpm test:
- pnpm build:
- その他:

本番影響:
-

未解決事項:
-

次に進む前の確認事項:
-
```

## 21. 推奨PR分割

PR 1: 安全な土台（Phase 1 + Phase 2 相当）

- `.env.example`
- feature flag helper
- noindex
- optional `offers` schema
- `src/lib/offers.ts`
- `tests/offers.test.ts`

PR 2: UI対応（Phase 3 相当）

- `AffiliateLink.astro`
- `RakutenLink.astro` wrapper化
- `ProductCard.astro`
- `ArticleLayout.astro`
- `ComparisonTable*`
- `TopPickCta.astro`
- `search.astro`

PR 3: Yahoo API / fixture（Phase 4 相当）

- `scripts/lib/yahoo-shopping.ts`
- fixture
- `tests/yahoo-shopping.test.ts`

PR 4: Yahoo同期スクリプト（Phase 5 相当）

- `scripts/update-yahoo-products.mjs`
- `scripts/lib/yahoo-offers.ts`
- reports
- package scripts

PR 5: staging運用（Phase 6 相当）

- staging workflow
- staging dry-run
- 限定記事 `--write`
- staging目視確認

PR 6: 本番段階投入（Phase 7 相当）

- feature flag OFF で `main` にコード投入
- 本番既存表示確認
- Yahoo ON 判断
