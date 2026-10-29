---
name: kura-article-dashboard
description: |
  KuraSelect の記事別ダッシュボード（HTML）を月1回作るスキル。
  「月次のダッシュボードを出して」「記事一覧の HTML を更新して」「記事別の数字を一覧で見たい」などと頼まれた場合、
  または月次の定期実行から呼ばれた場合に使う。pnpm article-dashboard を実行して
  reports/dashboard/articles-<GSC確定日>.html を出力し、前月分と比べた要点を短く報告する。
  閲覧用の一覧なので施策の判定には使わない（判定は kura-weekly-access-review と baseline-*.json）。
---

# KuraSelect 記事別ダッシュボード（月次）

**目的は「毎月同じ形の一覧 HTML を reports/dashboard/ に1本ずつ積むこと」。** 分析レポートではない。報告は要点だけにして、施策の提案や判定はしない。

## 1. 前提の確認

1. `reports/dashboard/` の最新の `articles-*.html` の日付を見る。**確定日が25日以内のものがあれば、作り直すか先にユーザーに聞いて止まる**（定期実行から呼ばれた場合は、聞かずにそのまま実行してよい）
2. 古いファイルは消さない・上書きしない（前月との比較に使う）

## 2. 実行

```bash
pnpm article-dashboard
```

- URL 検査を記事数ぶん順番に叩くため **15分前後かかる**。Bash は `run_in_background` で実行し、終了通知を待つ（ポーリングしない）
- オプション: `-- --days=120`（日次グラフの日数・既定90）、`-- --no-inspect`（URL 検査を省く・インデックス列が空になる）、`-- --no-bing`
- 取得エラーへの対処
  - `invalid_grant` などの認証エラー → メモリ `project_ga4_gsc_service_account` に従う。直らなければ止めてユーザーに報告
  - Bing の鍵が無い／API エラー → `--no-bing` で取り直してよい（報告に明記）
  - URL 検査のクォータ超過 → `--no-inspect` で取り直してよい（報告に明記）

## 3. 出力の確認

標準出力の最後の3点を必ず拾う:

- `GSC の最新確定日は YYYY-MM-DD`
- `⚠` で始まる警告（GA4・Bing の取得失敗、商品数カウントの食い違い）
- `出力: reports\dashboard\articles-<確定日>.html（N記事）`

警告があれば、そのまま報告に書く（握りつぶさない）。

## 4. 前月との比較（要点だけ）

HTML の `<script id="data" type="application/json">` に全データが入っている。**Node.js で読む**（PowerShell 5.1 は UTF-8 を誤復号するので使わない。CLAUDE.md §13-6）。一時スクリプトはスクラッチパッドに置く。

```js
const fs = require('fs');
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8').match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
```

今回分と、ひとつ前の `articles-*.html` を読んで次だけ出す:

1. サイト全体（ページ行の合計）: GSC クリック・表示、PV、送客、Bing クリック。前月分との差
2. GSC クリック（28日）の上位5記事
3. クリックの増減が大きい記事 上下各3本（前月分の `clicks` と比べる。**両月とも 10 クリック未満の記事は除く**）
4. インデックス: `verdict !== 'PASS'` の記事数と、前月から状態が変わった記事
5. 商品数が前月から変わった記事

前月分が無ければ 1・2・4 だけ出す。

## 5. 報告

- 冒頭に「GSC の最新確定日は YYYY-MM-DD」と出力ファイルのパスを書く
- §4 の要点を短い箇条書きで。**原因の推測や施策の提案はしない**（それは週次分析・テコ入れの仕事）
- HTML は `SendUserFile`（display: attach）でユーザーに渡す

## やらないこと

- `reports/` 配下をコミットしない（gitignore 済み・実データを含む。公開リポジトリ）
- このダッシュボードの数字で施策の成否を判定しない。判定は `reports/gsc-harvest/baseline-*.json` の差分で行う（CLAUDE.md §5.0.2）
- GA4 の値は T-1 を含む窓。PV・セッション・イベント数だけ載せており、engagementRate は読まない
- 記事ファイルや台帳を書き換えない（読み取りだけのスキル）
