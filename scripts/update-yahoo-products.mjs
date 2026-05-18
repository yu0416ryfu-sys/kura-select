/**
 * Yahoo!ショッピング / ValueCommerce offer dry-run and limited writer.
 *
 * Defaults to dry-run. Real writes require --write.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { buildSearchKeyword } from "./lib/frontmatter.ts";
import { searchYahooShoppingItems } from "./lib/yahoo-shopping.ts";
import { upsertYahooOfferInFrontmatter } from "./lib/yahoo-offers.ts";

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

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const DRY_RUN = args.includes("--dry-run") || !WRITE;
const ARTICLE = args.find((arg) => arg.startsWith("--article="))?.split("=")[1] ?? null;
const LIMIT = parseInt(args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? "0", 10);
const API_INTERVAL_MS = parseInt(args.find((arg) => arg.startsWith("--api-interval="))?.split("=")[1] ?? "1000", 10);
const ARTICLES_DIR = join(process.cwd(), "src", "content", "articles");
const REPORTS_DIR = join(process.cwd(), "reports");

const env = {
  appId: rawEnv.YAHOO_SHOPPING_APP_ID ?? "",
  valueCommerceSid: rawEnv.VALUECOMMERCE_SID ?? "",
  valueCommercePid: rawEnv.VALUECOMMERCE_PID ?? "",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProducts(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [];
  const products = [];
  const blocks = match[1].split(/\n(?=\s{2}- rank: )/);
  for (const block of blocks) {
    const name = block.match(/^\s{4}name:\s*["']?(.+?)["']?\s*$/m)?.[1];
    const rank = Number(block.match(/^\s{4}rank:\s*(\d+)/m)?.[1] ?? 0);
    if (name) products.push({ name, rank });
  }
  return products;
}

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
  const matched = tokens.filter((token) => normalizedCandidate.includes(token)).length;
  return matched >= Math.min(2, tokens.length);
}

function targetArticleFiles() {
  return readdirSync(ARTICLES_DIR)
    .filter((file) => file.endsWith(".md"))
    .filter((file) => !file.endsWith(".md.bak"))
    .filter((file) => {
      if (!ARTICLE) return true;
      const stem = file.replace(/\.md$/, "");
      return file === ARTICLE || stem === ARTICLE;
    })
    .slice(0, LIMIT > 0 ? LIMIT : undefined);
}

function reportPath() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return join(REPORTS_DIR, `yahoo-products-${WRITE ? "write" : "dry-run"}-${stamp}.md`);
}

const hasCredentials = Boolean(env.appId && env.valueCommerceSid && env.valueCommercePid);
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

const lines = [
  `# Yahoo products ${WRITE ? "write" : "dry-run"}`,
  "",
  `- mode: ${WRITE ? "write" : "dry-run"}`,
  `- article: ${ARTICLE ?? "(all)"}`,
  `- credentials: ${hasCredentials ? "present" : "missing"}`,
  "",
];

let changedFiles = 0;

for (const file of targetArticleFiles()) {
  const path = join(ARTICLES_DIR, file);
  let content = readFileSync(path, "utf8");
  const products = parseProducts(content);
  lines.push(`## ${file}`);

  if (!hasCredentials) {
    lines.push("- skipped: Yahoo / ValueCommerce credentials are missing", "");
    continue;
  }

  for (const product of products) {
    const query = buildSearchKeyword(product.name);
    lines.push(`### rank ${product.rank}: ${product.name}`);
    lines.push(`- query: ${query}`);

    try {
      const candidates = await searchYahooShoppingItems(query, { ...env, results: 5 });
      const selected = candidates.find((candidate) => isLikelySameProduct(product.name, candidate.name));

      if (!selected) {
        lines.push("- decision: review");
        lines.push(`- candidates: ${candidates.length}`);
      } else {
        lines.push("- decision: auto");
        lines.push(`- candidate: ${selected.name}`);
        lines.push(`- price: ${selected.price ?? "-"}`);
        lines.push(`- url: ${selected.url}`);

        if (WRITE) {
          const result = upsertYahooOfferInFrontmatter(
            content,
            product.name,
            selected,
            new Date().toISOString().slice(0, 10)
          );
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

  if (WRITE) {
    writeFileSync(path, content, "utf8");
    changedFiles += 1;
  }
}

const outputPath = reportPath();
writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Report written: ${outputPath}`);
if (DRY_RUN) console.log("Dry-run only. No article files were changed.");
else console.log(`Write completed. Files processed: ${changedFiles}`);
