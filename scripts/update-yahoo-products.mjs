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
const CONCURRENCY = Math.max(1, Math.min(8, parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "1", 10)));
const API_INTERVAL_MS = parseInt(args.find((a) => a.startsWith("--api-interval="))?.split("=")[1] ?? "2000", 10);
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

      let selected = null;
      let selectedEvaluation = null;
      const rejectedCandidates = [];
      for (const c of candidates) {
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

      if (!selected) {
        lines.push("- decision: review");
        lines.push(`- candidates: ${candidates.length}`);
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
            if (!DRY_RUN) {
              const result = markProviderOffersForReview(content, product.name, "yahoo", `capacity不一致: ${rejectedExisting.reason}`);
              if (result.changed) content = result.content;
            }
          }
        }
      } else {
        // 既存 matched offer が今回 rejected かつ別URLの候補が選ばれた場合は forceReplaceMatched で一括置換
        const existingMatched = product.offers.find((o) => o.provider === "yahoo" && (o.matchStatus === "matched" || !o.matchStatus));
        const existingMatchedUrl = existingMatched?.url;
        let rejectedExistingMatched = existingMatchedUrl
          ? rejectedCandidates.find((r) => r.url === existingMatchedUrl)
          : null;
        if (!rejectedExistingMatched && existingMatchedUrl) {
          const existingCandidate = candidates.find((c) => c.url === existingMatchedUrl);
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
        if (!DRY_RUN) {
          const result = upsertYahooOfferInFrontmatter(content, product.name, selected, today, {
            capacityVerified: true,
            strictMatch: selectedEvaluation?.strictMatch ?? false,
            forceReplaceMatched: shouldForceReplace,
          });
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
