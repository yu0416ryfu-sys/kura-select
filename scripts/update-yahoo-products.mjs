/**
 * Yahoo!ショッピング / ValueCommerce offer 同期スクリプト。
 *
 * デフォルトで書き込みを行う。確認だけしたい場合は --dry-run を使う。
 *
 * 使い方:
 *   node scripts/update-yahoo-products.mjs                        # 全記事を更新
 *   node scripts/update-yahoo-products.mjs --dry-run              # 書き込みなし確認
 *   node scripts/update-yahoo-products.mjs --file=toilet-paper*   # glob 指定
 *   node scripts/update-yahoo-products.mjs --file=/^shampoo/      # 正規表現指定
 *   node scripts/update-yahoo-products.mjs --concurrency=4        # 並列数指定
 *   node scripts/update-yahoo-products.mjs --api-interval=2000    # API間隔(ms)指定
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { buildSearchKeyword } from "./lib/frontmatter.ts";
import { searchYahooShoppingItems } from "./lib/yahoo-shopping.ts";
import { upsertYahooOfferInFrontmatter } from "./lib/yahoo-offers.ts";

// ─── 環境変数を読み込み ──────────────────────────────────────────────────────

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = {};
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      parsed[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return parsed;
  }
  return process.env;
}

const rawEnv = loadEnv();

// ─── CLI 引数パース ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FILE_FILTER = args.find((a) => a.startsWith("--file="))?.split("=")[1] ?? null;
const CONCURRENCY = Math.max(1, Math.min(8, parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "2", 10)));
const API_INTERVAL_MS = parseInt(args.find((a) => a.startsWith("--api-interval="))?.split("=")[1] ?? "1000", 10);
const LIMIT = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0", 10);

const ARTICLES_DIR = join(process.cwd(), "src", "content", "articles");
const REPORTS_DIR = join(process.cwd(), "reports");

const env = {
  appId: rawEnv.YAHOO_SHOPPING_APP_ID ?? "",
  valueCommerceSid: rawEnv.VALUECOMMERCE_SID ?? "",
  valueCommercePid: rawEnv.VALUECOMMERCE_PID ?? "",
};

// ─── ファイルフィルタ（update-products.mjs と同仕様）────────────────────────

function normalizeArticleFileName(value) {
  return value.endsWith(".md") ? value : `${value}.md`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob) {
  const escaped = escapeRegExp(glob).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function parseSlashRegExp(value) {
  const m = value.match(/^\/(.+)\/([gimsuy]*)$/);
  return m ? new RegExp(m[1], m[2]) : null;
}

function matchesFileFilter(file) {
  if (!FILE_FILTER) return true;
  const slashRe = parseSlashRegExp(FILE_FILTER);
  if (slashRe) return slashRe.test(file);
  const normalized = normalizeArticleFileName(FILE_FILTER);
  if (FILE_FILTER.includes("*") || FILE_FILTER.includes("?")) return globToRegExp(normalized).test(file);
  return file === normalized;
}

// ─── ユーティリティ ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayJst() {
  return new Date().toISOString().slice(0, 10);
}

function reportPath() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return join(REPORTS_DIR, `yahoo-products-${DRY_RUN ? "dry-run" : "write"}-${stamp}.md`);
}

function targetArticleFiles() {
  const files = readdirSync(ARTICLES_DIR)
    .filter((file) => file.endsWith(".md"))
    .filter((file) => !file.endsWith(".md.bak"))
    .filter((file) => matchesFileFilter(file));
  return LIMIT > 0 ? files.slice(0, LIMIT) : files;
}

// ─── frontmatter から商品リストを取得 ────────────────────────────────────────

function parseProducts(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [];
  const products = [];
  const blocks = match[1].split(/\n(?=\s{2}- rank: )/);
  for (const block of blocks) {
    const name = block.match(/^\s{4}name:\s*["']?(.+?)["']?\s*$/m)?.[1];
    const rank = Number(block.match(/^\s{2}-\s+rank:\s*(\d+)/m)?.[1] ?? 0);
    if (name) products.push({ name, rank });
  }
  return products;
}

// ─── 商品名マッチング ────────────────────────────────────────────────────────

function normalizeTokens(value) {
  return buildSearchKeyword(value)
    .toLowerCase()
    .split(/[\s　・、。／/｜|]+/)
    .filter((token) => token.length >= 2)
    .filter((token) => !/^[\d.,]+/.test(token));
}

function isLikelySameProduct(currentName, candidateName) {
  const tokens = normalizeTokens(currentName);
  if (tokens.length === 0) return false;
  const normalizedCandidate = candidateName.toLowerCase();
  // 最初のトークン（ブランド名相当）が候補に含まれない場合は別商品と判定
  if (!normalizedCandidate.includes(tokens[0])) return false;
  const matched = tokens.filter((token) => normalizedCandidate.includes(token)).length;
  return matched >= Math.min(2, tokens.length);
}

// ─── 並列処理プール ──────────────────────────────────────────────────────────

async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(task).then((r) => {
      executing.delete(p);
      return r;
    });
    results.push(p);
    executing.add(p);
    if (executing.size >= concurrency) await Promise.race(executing);
  }
  return Promise.all(results);
}

// ─── 1 記事の処理 ────────────────────────────────────────────────────────────

async function processArticle(file) {
  const path = join(ARTICLES_DIR, file);
  const originalContent = readFileSync(path, "utf8");
  let content = originalContent;
  const products = parseProducts(content);
  const lines = [`## ${file}`];
  const today = todayJst();

  for (const product of products) {
    const query = buildSearchKeyword(product.name);
    lines.push(`### rank ${product.rank}: ${product.name}`);
    lines.push(`- query: ${query}`);

    try {
      const candidates = await searchYahooShoppingItems(query, { ...env, results: 5 });
      const selected = candidates.find((c) => isLikelySameProduct(product.name, c.name));

      if (!selected) {
        lines.push("- decision: review");
        lines.push(`- candidates: ${candidates.length}`);
      } else {
        lines.push("- decision: auto");
        lines.push(`- candidate: ${selected.name}`);
        lines.push(`- price: ${selected.price ?? "-"}`);
        lines.push(`- url: ${selected.url}`);

        if (!DRY_RUN) {
          const result = upsertYahooOfferInFrontmatter(content, product.name, selected, today);
          if (result.changed) content = result.content;
          else lines.push(`- write skipped: ${result.reason ?? "unchanged"}`);
        }
      }
    } catch (error) {
      lines.push(`- error: ${(error instanceof Error ? error.message : String(error)).replace(/\r?\n/g, " ")}`);
    }

    lines.push("");
    if (API_INTERVAL_MS > 0) await sleep(API_INTERVAL_MS);
  }

  if (!DRY_RUN && content !== originalContent) {
    writeFileSync(path + ".bak", originalContent, "utf8");
    writeFileSync(path, content, "utf8");
    return { file, lines, changed: true };
  }

  return { file, lines, changed: false };
}

// ─── メイン ──────────────────────────────────────────────────────────────────

const hasCredentials = Boolean(env.appId && env.valueCommerceSid && env.valueCommercePid);
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

const header = [
  `# Yahoo products ${DRY_RUN ? "dry-run" : "write"}`,
  "",
  `- mode: ${DRY_RUN ? "dry-run" : "write"}`,
  `- file: ${FILE_FILTER ?? "(all)"}`,
  `- concurrency: ${CONCURRENCY}`,
  `- credentials: ${hasCredentials ? "present" : "missing"}`,
  "",
];

if (!hasCredentials) {
  const outputPath = reportPath();
  writeFileSync(outputPath, `${header.join("\n")}\n- skipped: credentials are missing\n`, "utf8");
  console.error("❌ YAHOO_SHOPPING_APP_ID / VALUECOMMERCE_SID / VALUECOMMERCE_PID が設定されていません");
  process.exit(1);
}

const files = targetArticleFiles();
const tasks = files.map((file) => () => processArticle(file));
const results = await runWithConcurrency(tasks, DRY_RUN ? 1 : CONCURRENCY);

const allLines = [...header];
let changedFiles = 0;
for (const r of results) {
  allLines.push(...r.lines, "");
  if (r.changed) changedFiles += 1;
}

const outputPath = reportPath();
writeFileSync(outputPath, `${allLines.join("\n")}\n`, "utf8");
console.log(`Report written: ${outputPath}`);
if (DRY_RUN) {
  console.log("Dry-run only. No article files were changed.");
} else {
  console.log(`Write completed. Files changed: ${changedFiles} / ${files.length}`);
}
