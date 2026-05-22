/**
 * RAGデータエクスポートスクリプト。
 * 記事frontmatter・AI判定履歴・capacity入力レポートを読み込み、
 * data/rag/ に JSONL + summary.json を生成する。
 *
 * 使い方:
 *   node scripts/export-ai-rag-data.mjs
 *   corepack pnpm export-ai-rag
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join, resolve, relative, basename } from "path";
import {
  parseFrontmatterData,
  normalizeProductRecord,
  normalizeMatchDecision,
  normalizeCapacityPattern,
  buildCategoryRuleRecords,
  toArticleFilePath,
} from "./lib/rag-export.ts";

// ─── パス設定 ─────────────────────────────────────────────────────────────────

const ROOT = resolve(process.cwd());
const ARTICLES_DIR = join(ROOT, "src", "content", "articles");
const REPORTS_DIR = join(ROOT, "reports");
const RAG_DIR = join(ROOT, "data", "rag");

// ─── ディレクトリ準備 ─────────────────────────────────────────────────────────

if (!existsSync(RAG_DIR)) {
  mkdirSync(RAG_DIR, { recursive: true });
}

// ─── 記事一覧取得（.md / .mdx・サブディレクトリ対応）────────────────────────

function collectArticleFiles(dir, base = dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectArticleFiles(fullPath, base));
    } else if (
      (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) &&
      !entry.name.endsWith(".md.bak")
    ) {
      results.push({ relPath: relative(base, fullPath).replace(/\\/g, "/"), fullPath });
    }
  }
  return results;
}

const articleEntries = existsSync(ARTICLES_DIR) ? collectArticleFiles(ARTICLES_DIR) : [];

console.log(`記事数: ${articleEntries.length}`);

// ─── 記事からproducts・capacity-patternsを収集 ───────────────────────────────

const productRecords = [];
const capacityPatternRecords = [];

for (const { relPath, fullPath } of articleEntries) {
  const content = readFileSync(fullPath, "utf8");
  const data = parseFrontmatterData(content);
  if (!data) {
    console.warn(`  [WARN] フロントマター解析失敗: ${relPath}`);
    continue;
  }

  const articleFile = toArticleFilePath(relPath);
  const articleTitle = typeof data.title === "string" ? data.title : "";
  const category = typeof data.category === "string" ? data.category : basename(relPath).replace(/-comparison\.mdx?$/, "");
  const products = Array.isArray(data.products) ? data.products : [];

  for (const p of products) {
    const record = normalizeProductRecord(p, articleFile, articleTitle, category);
    if (record) {
      productRecords.push(record);
      // capacity-pattern としても登録
      const capRecord = normalizeCapacityPattern(
        { name: record.name, capacity: record.capacity, price: record.price, pricePerUnit: record.pricePerUnit },
        articleFile,
        "article"
      );
      if (capRecord) capacityPatternRecords.push(capRecord);
    }
  }
}

console.log(`商品数: ${productRecords.length}`);

// ─── AI判定履歴 (reports/ai-matches/**/*.jsonl) を収集 ───────────────────────

const matchDecisionRecords = [];

const aiMatchesDir = join(REPORTS_DIR, "ai-matches");
if (existsSync(aiMatchesDir)) {
  const jsonlFiles = collectJsonlFiles(aiMatchesDir);
  console.log(`AI照合JSONL: ${jsonlFiles.length}件`);

  for (const jsonlPath of jsonlFiles) {
    const relPath = relative(ROOT, jsonlPath).replace(/\\/g, "/");
    const lines = readFileSync(jsonlPath, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const record = normalizeMatchDecision(obj, relPath);
        if (record) matchDecisionRecords.push(record);
      } catch {
        // 解析失敗の行はスキップ
      }
    }
  }
} else {
  console.log("reports/ai-matches/ が存在しません（スキップ）");
}

console.log(`AI判定履歴: ${matchDecisionRecords.length}件`);

// ─── capacity入力レポート (reports/ai-capacity-input-*.jsonl) を収集 ──────────

const aiCapacityDir = REPORTS_DIR;
if (existsSync(aiCapacityDir)) {
  const capacityReportFiles = readdirSync(aiCapacityDir)
    .filter((f) => f.startsWith("ai-capacity-input-") && f.endsWith(".jsonl"))
    .map((f) => join(aiCapacityDir, f));

  for (const jsonlPath of capacityReportFiles) {
    const relPath = relative(ROOT, jsonlPath).replace(/\\/g, "/");
    const lines = readFileSync(jsonlPath, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const articleFile = typeof obj.articleFile === "string" ? obj.articleFile : "";
        // フィールドは current.name / current.capacity / current.pricePerUnit に格納されている
        const current = obj.current && typeof obj.current === "object" ? obj.current : null;
        const input = current ?? obj;
        const record = normalizeCapacityPattern(input, articleFile, "report");
        if (record) capacityPatternRecords.push(record);
      } catch {
        // 解析失敗の行はスキップ
      }
    }
  }
}

// ─── category-rules を生成 ───────────────────────────────────────────────────

const categoryRuleRecords = buildCategoryRuleRecords(productRecords);
console.log(`カテゴリルール: ${categoryRuleRecords.length}件`);

// ─── ファイル出力 ─────────────────────────────────────────────────────────────

function writeJsonl(filePath, records) {
  const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  writeFileSync(filePath, content, "utf8");
}

writeJsonl(join(RAG_DIR, "products.jsonl"), productRecords);
writeJsonl(join(RAG_DIR, "capacity-patterns.jsonl"), capacityPatternRecords);
writeJsonl(join(RAG_DIR, "match-decisions.jsonl"), matchDecisionRecords);
writeJsonl(join(RAG_DIR, "category-rules.jsonl"), categoryRuleRecords);

const needsReviewCount = productRecords.filter((r) => r.needsReview).length;

const summary = {
  generatedAt: new Date().toISOString(),
  articleCount: articleEntries.length,
  productCount: productRecords.length,
  needsReviewCount,
  matchDecisionCount: matchDecisionRecords.length,
  capacityPatternCount: capacityPatternRecords.length,
  categoryRuleCount: categoryRuleRecords.length,
};
writeFileSync(join(RAG_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");

// ─── 結果サマリー ─────────────────────────────────────────────────────────────

console.log("\n── 完了 ───────────────────────────────────────");
console.log(`  products.jsonl         : ${productRecords.length}件`);
console.log(`  capacity-patterns.jsonl: ${capacityPatternRecords.length}件`);
console.log(`  match-decisions.jsonl  : ${matchDecisionRecords.length}件`);
console.log(`  category-rules.jsonl   : ${categoryRuleRecords.length}件`);
console.log(`  needsReview            : ${needsReviewCount}件`);

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function collectJsonlFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsonlFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}
