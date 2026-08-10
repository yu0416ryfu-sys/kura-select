#!/usr/bin/env node
/**
 * IndexNow への URL 送信スクリプト（Bing / Yandex などが購読）。
 *
 * Bing は KuraSelect の送客第1チャネルだが、通常クロールは数日〜数週間かかる。
 * IndexNow で「更新した URL」を能動的に通知することで、記事の更新反映を早める。
 *
 * 使い方:
 *   node scripts/indexnow-submit.mjs               # 直前のコミットで変わった記事だけ送信
 *   node scripts/indexnow-submit.mjs --all         # サイトマップ相当の全 URL を送信（初回のみ）
 *   node scripts/indexnow-submit.mjs --url=/articles/foo/ --url=/  # 個別指定
 *   node scripts/indexnow-submit.mjs --all --dry-run
 *
 * キーは public/<KEY>.txt として配信される必要がある（IndexNow の所有権証明）。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const ARTICLES_DIR = path.join(ROOT, "src/content/articles");
const PUBLIC_DIR = path.join(ROOT, "public");
const DIST_DIR = path.join(ROOT, "dist");

const SITE = (process.env.PUBLIC_SITE_URL || "https://www.kura-select.com").replace(/\/$/, "");
const HOST = new URL(SITE).host;
const ENDPOINT = "https://api.indexnow.org/IndexNow";
/** IndexNow は 1 リクエスト最大 10,000 URL。余裕を持って分割する。 */
const CHUNK_SIZE = 1000;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const submitAll = args.includes("--all");
const explicitUrls = args
  .filter((a) => a.startsWith("--url="))
  .map((a) => a.slice("--url=".length));

/** public/ 直下の <32桁hex>.txt を IndexNow キーとして採用する。 */
function resolveKey() {
  if (process.env.INDEXNOW_KEY) return process.env.INDEXNOW_KEY;
  const file = fs
    .readdirSync(PUBLIC_DIR)
    .find((name) => /^[0-9a-f]{8,128}\.txt$/i.test(name));
  if (!file) {
    throw new Error(
      "IndexNow キーが見つかりません。public/<key>.txt を作成するか INDEXNOW_KEY を設定してください。",
    );
  }
  const key = file.replace(/\.txt$/, "");
  const body = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf-8").trim();
  if (body !== key) {
    throw new Error(`public/${file} の中身がファイル名（${key}）と一致しません。`);
  }
  return key;
}

function toAbsolute(pathname) {
  if (/^https?:\/\//.test(pathname)) return pathname;
  return SITE + (pathname.startsWith("/") ? pathname : `/${pathname}`);
}

/** ビルド済み dist のサイトマップから URL を集める（無ければ null）。 */
function urlsFromSitemap() {
  if (!fs.existsSync(DIST_DIR)) return null;
  const files = fs.readdirSync(DIST_DIR).filter((f) => /^sitemap-\d+\.xml$/.test(f));
  if (files.length === 0) return null;
  const urls = [];
  for (const file of files) {
    const xml = fs.readFileSync(path.join(DIST_DIR, file), "utf-8");
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.push(m[1].trim());
  }
  return urls.length > 0 ? urls : null;
}

/** dist が無いとき用のフォールバック。記事 frontmatter から URL を組み立てる。 */
function urlsFromContent() {
  const urls = [`${SITE}/`];
  for (const file of fs.readdirSync(ARTICLES_DIR)) {
    if (!/\.mdx?$/.test(file)) continue;
    const raw = fs.readFileSync(path.join(ARTICLES_DIR, file), "utf-8");
    const frontmatter = raw.split(/^---\s*$/m)[1] ?? "";
    if (/^draft:\s*true/m.test(frontmatter)) continue;
    urls.push(`${SITE}/articles/${file.replace(/\.mdx?$/, "")}/`);
  }
  return urls;
}

/** 直前のコミットで変更された記事ファイルを記事 URL に変換する。 */
function urlsFromGitDiff() {
  let out;
  try {
    out = execFileSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], {
      cwd: ROOT,
      encoding: "utf-8",
    });
  } catch {
    console.warn("git diff に失敗しました（浅いクローン？）。送信対象なしとして終了します。");
    return [];
  }
  const urls = new Set();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^src\/content\/articles\/(.+)\.mdx?$/);
    if (!m) continue;
    const file = path.join(ARTICLES_DIR, `${m[1]}.md`);
    const mdx = path.join(ARTICLES_DIR, `${m[1]}.mdx`);
    // 削除された記事は通知しない
    if (!fs.existsSync(file) && !fs.existsSync(mdx)) continue;
    urls.add(`${SITE}/articles/${m[1]}/`);
  }
  return [...urls];
}

function resolveUrls() {
  if (explicitUrls.length > 0) return explicitUrls.map(toAbsolute);
  if (submitAll) return urlsFromSitemap() ?? urlsFromContent();
  return urlsFromGitDiff();
}

async function submit(key, urlList) {
  const payload = {
    host: HOST,
    key,
    keyLocation: `${SITE}/${key}.txt`,
    urlList,
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  const key = resolveKey();
  const urls = resolveUrls().filter((u) => u.startsWith(SITE));

  if (urls.length === 0) {
    console.log("送信対象の URL がありません。終了します。");
    return;
  }

  console.log(`IndexNow 送信対象: ${urls.length} URL（key=${key}）`);
  for (const u of urls.slice(0, 10)) console.log(`  - ${u}`);
  if (urls.length > 10) console.log(`  … 他 ${urls.length - 10} 件`);

  if (dryRun) {
    console.log("--dry-run のため送信しません。");
    return;
  }

  for (let i = 0; i < urls.length; i += CHUNK_SIZE) {
    const chunk = urls.slice(i, i + CHUNK_SIZE);
    const { status, text } = await submit(key, chunk);
    // 200: 受理 / 202: 受理（キー検証待ち）
    const ok = status === 200 || status === 202;
    console.log(`[${ok ? "OK" : "NG"}] HTTP ${status} — ${chunk.length} URL ${text ? `: ${text.slice(0, 200)}` : ""}`);
    if (!ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
