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
import yaml from "js-yaml";
import { buildSearchKeyword } from "./lib/frontmatter.ts";
import { searchYahooShoppingItems } from "./lib/yahoo-shopping.ts";
import { upsertYahooOfferInFrontmatter, markProviderOffersForReview } from "./lib/yahoo-offers.ts";
import {
  buildYahooSupplementalSearchQuery,
  evaluateYahooCandidate,
  toComparableCapacity,
} from "./lib/yahoo-matching.ts";

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

// 正の整数オプションを安全にパースする（NaN は default にフォールバックし min/max でクランプ）
function parsePositiveIntArg(prefix, defaultValue, { min, max }) {
  const raw = args.find((a) => a.startsWith(prefix))?.split("=")[1];
  const parsed = raw === undefined ? defaultValue : parseInt(raw, 10);
  const value = Number.isFinite(parsed) ? parsed : defaultValue;
  return Math.max(min, Math.min(max, value));
}

const CONCURRENCY = parsePositiveIntArg("--concurrency=", 2, { min: 1, max: 8 });
const PRODUCT_CONCURRENCY = parsePositiveIntArg("--product-concurrency=", 2, { min: 1, max: 4 });
const API_INTERVAL_MS = parsePositiveIntArg("--api-interval=", 250, { min: 0, max: 10000 });
const API_TIMEOUT_MS = parsePositiveIntArg("--api-timeout=", 15000, { min: 1000, max: 60000 });
const LIMIT = parsePositiveIntArg("--limit=", 0, { min: 0, max: Number.MAX_SAFE_INTEGER });

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

// エラーメッセージを1行に整形する小さなヘルパー
function formatError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\r?\n/g, " ");
}

// ─── 共有 API limiter ────────────────────────────────────────────────────────
// 並列化後も --api-interval を効かせるため、API 呼び出し開始間隔を全体で直列制御する

let nextApiStartAt = 0;
let apiLimiterQueue = Promise.resolve();

async function waitForApiSlot() {
  const previous = apiLimiterQueue;
  let release;
  apiLimiterQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const now = Date.now();
  const waitMs = Math.max(0, nextApiStartAt - now);
  if (waitMs > 0) await sleep(waitMs);
  nextApiStartAt = Date.now() + API_INTERVAL_MS;
  release();
}

async function searchYahooShoppingItemsLimited(query) {
  await waitForApiSlot();
  return searchYahooShoppingItems(query, { ...env, results: 5, timeoutMs: API_TIMEOUT_MS });
}

function todayJst() {
  return new Date().toISOString().slice(0, 10);
}

function formatProgressName(name) {
  return name.length > 45 ? `${name.slice(0, 45)}...` : name;
}

function createProgressLogger(totalFiles) {
  let completedFiles = 0;
  return {
    startArticle(file, index, productCount) {
      console.log(`📄 [${index + 1}/${totalFiles}] 開始 ${file} (${productCount}商品)`);
    },
    product(file, index, productIndex, productCount, name) {
      console.log(`   [${index + 1}/${totalFiles}] ${file} 商品 ${productIndex + 1}/${productCount}: ${formatProgressName(name)}`);
    },
    finishArticle(file, index, status) {
      completedFiles += 1;
      console.log(`✅ [${index + 1}/${totalFiles}] 完了 ${file} (完了数 ${completedFiles}/${totalFiles}): ${status}`);
    },
  };
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

// ─── frontmatter から商品リストを取得（YAMLパーサー使用）────────────────────

function parseProducts(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [];
  try {
    const data = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) ?? {};
    if (!Array.isArray(data.products)) return [];
    return data.products
      .filter((p) => p && typeof p.name === "string" && p.name)
      .map((p) => ({
        name: p.name,
        rank: typeof p.rank === "number" ? p.rank : 0,
        capacity: typeof p.capacity === "string" ? p.capacity : null,
        brand: typeof p.brand === "string" && p.brand !== "" ? p.brand : null,
        rakutenUrl: typeof p.rakutenUrl === "string" ? p.rakutenUrl : null,
        offers: Array.isArray(p.offers) ? p.offers : [],
      }));
  } catch {
    return [];
  }
}

// ─── 並列処理プール ──────────────────────────────────────────────────────────

async function runWithConcurrency(items, concurrency, worker) {
  const results = [];
  const executing = new Set();
  for (const [index, item] of items.entries()) {
    const p = Promise.resolve().then(() => worker(item, index)).then((r) => {
      executing.delete(p);
      return r;
    });
    results.push(p);
    executing.add(p);
    if (executing.size >= concurrency) await Promise.race(executing);
  }
  return Promise.all(results);
}

// ─── 1 商品の API 照合・判定（content への書き込みはしない）────────────────

async function fetchProductDecision(product) {
  const lines = [`### rank ${product.rank}: ${product.name}`];
  try {
    const query = buildSearchKeyword(product.name);
    const supplementalQuery = buildYahooSupplementalSearchQuery(product);
    const queries = supplementalQuery ? [query, supplementalQuery] : [query];
    const seenUrls = new Set();
    const searchedCandidates = [];

    let selected = null;
    let selectedEvaluation = null;
    const rejectedCandidates = [];
    let anyQuerySucceeded = false;

    for (const [queryIndex, currentQuery] of queries.entries()) {
      lines.push(queryIndex === 0
        ? `- query: ${currentQuery}`
        : `- supplemental query: ${currentQuery}`);

      let candidates;
      try {
        candidates = await searchYahooShoppingItemsLimited(currentQuery);
      } catch (error) {
        // timeout / API エラーは記録して次クエリ（supplemental）へフォールバック
        lines.push(`- query error: ${formatError(error)}`);
        continue;
      }
      anyQuerySucceeded = true;

      for (const c of candidates) {
        if (seenUrls.has(c.url)) continue;
        seenUrls.add(c.url);
        searchedCandidates.push(c);
        const evaluation = evaluateYahooCandidate(product, c);
        if (evaluation.ok) {
          selected = c;
          selectedEvaluation = evaluation;
          lines.push("- decision: auto");
          lines.push(`- candidate: ${c.name}`);
          lines.push(`- price: ${c.price ?? "-"}`);
          lines.push(`- rating: ${c.rating ?? "-"}`);
          lines.push(`- review count: ${c.reviewCount ?? "-"}`);
          lines.push(`- url: ${c.url}`);
          const candidateCap = evaluation.candidateCapacity ?? "-";
          const currentCap = product.capacity ?? "-";
          lines.push(`- capacity: ${currentCap} -> ${toComparableCapacity(currentCap)?.total ?? "-"}${toComparableCapacity(currentCap)?.unit ?? ""}`);
          lines.push(`- candidate capacity: ${candidateCap} -> ${toComparableCapacity(candidateCap)?.total ?? "-"}${toComparableCapacity(candidateCap)?.unit ?? ""}`);
          lines.push(`- url multiplier: ×${selectedEvaluation?.urlMultiplier ?? 1}`);
          if (selectedEvaluation?.urlIdentityMatch) {
            lines.push(`- url identity match: true`);
          }
          // Step 2: strictMatch 失敗理由・エイリアス候補をレポートに出力する
          if (selectedEvaluation && !selectedEvaluation.strictMatch) {
            lines.push(`- strict match: false`);
            lines.push(`- brand match: ${selectedEvaluation.brandMatch ?? "n/a"}`);
            if (selectedEvaluation.brandFailureReason) {
              lines.push(`- brand failure: ${selectedEvaluation.brandFailureReason}`);
            }
            if (selectedEvaluation.suggestedBrandAliases?.length) {
              lines.push(`- suggested brand aliases:`);
              for (const alias of selectedEvaluation.suggestedBrandAliases) {
                lines.push(`  - ${alias}`);
              }
            }
          }
          break;
        } else {
          rejectedCandidates.push({ name: c.name, url: c.url, reason: evaluation.reason, candidateCapacity: evaluation.candidateCapacity ?? null });
        }
      }

      if (selected) break; // 採用できたら supplemental は投げない
    }

    // 全クエリが reject（候補ゼロ）→ API 失敗として review 化せず終了
    if (!anyQuerySucceeded) {
      lines.push("- decision: error");
      return { product, lines, mutationAction: null };
    }

    if (!selected) {
      lines.push("- decision: review");
      lines.push(`- candidates: ${searchedCandidates.length}`);
      for (const r of rejectedCandidates.slice(0, 5)) {
        lines.push(`- rejected: ${r.name}`);
        lines.push(`  - reason: ${r.reason}`);
        if (r.candidateCapacity) {
          lines.push(`  - candidate capacity: ${r.candidateCapacity}`);
        }
      }

      // 既存の matched offer が今回の候補リストで capacity 不一致として弾かれた場合は review に降格する
      const existingMatched = product.offers.find((o) => o.provider === "yahoo" && (o.matchStatus === "matched" || !o.matchStatus));
      if (existingMatched) {
        const rejectedExisting = rejectedCandidates.find((r) => r.url === existingMatched.url);
        if (rejectedExisting) {
          lines.push(`- downgrade: matched offer が capacity 不一致（${rejectedExisting.reason}）のため review に降格`);
          return {
            product,
            lines,
            mutationAction: { type: "review", reason: `capacity不一致: ${rejectedExisting.reason}` },
          };
        }
      }
      return { product, lines, mutationAction: null };
    }

    // 既存 matched offer が今回 rejected かつ別URLの候補が選ばれた場合は forceReplaceMatched で一括置換
    const existingMatched = product.offers.find((o) => o.provider === "yahoo" && (o.matchStatus === "matched" || !o.matchStatus));
    const existingMatchedUrl = existingMatched?.url;
    let rejectedExistingMatched = existingMatchedUrl
      ? rejectedCandidates.find((r) => r.url === existingMatchedUrl)
      : null;
    if (!rejectedExistingMatched && existingMatchedUrl) {
      const existingCandidate = searchedCandidates.find((c) => c.url === existingMatchedUrl);
      if (existingCandidate) {
        const existingEvaluation = evaluateYahooCandidate(product, existingCandidate);
        if (!existingEvaluation.ok) {
          rejectedExistingMatched = {
            name: existingCandidate.name,
            url: existingCandidate.url,
            reason: existingEvaluation.reason,
            candidateCapacity: existingEvaluation.candidateCapacity ?? null,
          };
        }
      }
    }
    const shouldForceReplace = !!(rejectedExistingMatched && selected.url !== existingMatchedUrl);
    if (shouldForceReplace && rejectedExistingMatched) {
      lines.push(`- replace: matched offer が capacity 不一致（${rejectedExistingMatched.reason}）のため新候補に置換`);
    }
    return {
      product,
      lines,
      mutationAction: {
        type: "upsert",
        selected,
        options: {
          capacityVerified: true,
          strictMatch: selectedEvaluation?.strictMatch ?? false,
          forceReplaceMatched: shouldForceReplace,
        },
      },
    };
  } catch (error) {
    // 想定外例外でも throw せず必ず解決し、Promise.all を巻き込まない
    lines.push(`- error: ${formatError(error)}`);
    return { product, lines, mutationAction: null };
  }
}

// ─── 1 記事の処理 ────────────────────────────────────────────────────────────

async function processArticle(file, index, progress) {
  const path = join(ARTICLES_DIR, file);
  const originalContent = readFileSync(path, "utf8");
  let content = originalContent;
  const products = parseProducts(content);
  const articleLines = [`## ${file}`];
  const today = todayJst();

  progress?.startArticle(file, index, products.length);

  // Phase 1: API 照合を上限付き並列で実行（content への書き込みはしない）
  const decisions = await runWithConcurrency(
    products,
    PRODUCT_CONCURRENCY,
    async (product, productIndex) => {
      progress?.product(file, index, productIndex, products.length, product.name);
      // 保険: fetchProductDecision は必ず解決する設計だが、想定外の throw でも
      // Promise.all を巻き込まないよう商品単位で握りつぶす
      try {
        return await fetchProductDecision(product);
      } catch (error) {
        return {
          product,
          lines: [`- error: ${formatError(error)}`],
          mutationAction: null,
        };
      }
    }
  );

  // Phase 2: 元順序通りに content を変更する（書き込み競合を避けるため直列）
  for (const { product, lines, mutationAction } of decisions) {
    articleLines.push(...lines);

    if (!DRY_RUN && mutationAction) {
      try {
        if (mutationAction.type === "upsert") {
          const result = upsertYahooOfferInFrontmatter(
            content,
            product.name,
            mutationAction.selected,
            today,
            mutationAction.options
          );
          if (result.changed) content = result.content;
          else articleLines.push(`- write skipped: ${result.reason ?? "unchanged"}`);
        } else if (mutationAction.type === "review") {
          const result = markProviderOffersForReview(content, product.name, "yahoo", mutationAction.reason);
          if (result.changed) content = result.content;
        }
      } catch (error) {
        articleLines.push(`- write error: ${formatError(error)}`);
      }
    }

    articleLines.push("");
  }

  if (!DRY_RUN && content !== originalContent) {
    writeFileSync(path + ".bak", originalContent, "utf8");
    writeFileSync(path, content, "utf8");
    progress?.finishArticle(file, index, "変更あり");
    return { file, lines: articleLines, changed: true };
  }

  progress?.finishArticle(file, index, products.length === 0 ? "商品なし" : "変更なし");
  return { file, lines: articleLines, changed: false };
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
  `- product concurrency: ${PRODUCT_CONCURRENCY}`,
  `- api interval: ${API_INTERVAL_MS}ms`,
  `- api timeout: ${API_TIMEOUT_MS}ms`,
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
console.log(`📂 対象ファイル: ${files.length}件`);
console.log(`⚙ 並列数: ${CONCURRENCY} / 商品並列: ${PRODUCT_CONCURRENCY} / API間隔: ${API_INTERVAL_MS}ms / APIタイムアウト: ${API_TIMEOUT_MS}ms\n`);
if (DRY_RUN) console.log("⚠ --dry-run モード: ファイルは書き換えません\n");
const progress = createProgressLogger(files.length);
const results = await runWithConcurrency(files, CONCURRENCY, (file, index) => processArticle(file, index, progress));

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
