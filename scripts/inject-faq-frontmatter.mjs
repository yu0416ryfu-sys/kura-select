// 記事本文の「## よくある質問（FAQ）」から Q/A を抽出し、frontmatter の faqs に反映する。
// pnpm build には組み込まず、明示的に `pnpm inject-faqs` で実行する（build はファイルを書き換えない）。
//
// 使い方:
//   pnpm inject-faqs           書き込みあり
//   pnpm inject-faqs --check   書き込まず、未反映の記事があれば exit 1（CI 検証用）
//   pnpm inject-faqs --dry-run 書き込まず、差分件数だけ表示
//
// ⚠ 抽出ロジックは scripts/lib/faq.ts に集約。ここはファイル IO とレポートのみ。

import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractFaqs } from "./lib/faq.ts";
import { setFaqsInFrontmatter } from "./lib/frontmatter.ts";

const ARTICLES_DIR = fileURLToPath(new URL("../src/content/articles", import.meta.url));

const args = process.argv.slice(2);
const isCheck = args.includes("--check");
const isDryRun = args.includes("--dry-run");
const writeEnabled = !isCheck && !isDryRun;

async function listArticleFiles() {
  const entries = await readdir(ARTICLES_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && /\.(md|mdx)$/.test(e.name) && !e.name.endsWith(".bak"))
    .map(e => path.join(ARTICLES_DIR, e.name));
}

async function main() {
  const files = await listArticleFiles();

  let updated = 0;       // faqs を更新（または更新が必要）な記事数
  let extractedOk = 0;   // Q/A を抽出できた記事数
  let headingOnly = 0;   // FAQ 見出しはあるが Q/A 0 件でスキップした記事数
  const headingOnlyFiles = [];
  const pendingFiles = []; // --check で未反映だった記事

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const faqs = extractFaqs(content);

    // 見出しの有無を判定（見出しありで Q/A 0 件なら headingOnly としてレポート）
    const hasHeading = /^##\s*よくある質問\s*[（(]\s*FAQ\s*[）)]/m.test(content);
    if (faqs.length === 0) {
      if (hasHeading) {
        headingOnly++;
        headingOnlyFiles.push(path.basename(file));
      }
      continue;
    }
    extractedOk++;

    const { content: nextContent, changed } = setFaqsInFrontmatter(content, faqs);
    if (!changed) continue;

    updated++;
    if (writeEnabled) {
      await writeFile(file, nextContent, "utf8");
    } else if (isCheck) {
      pendingFiles.push(path.basename(file));
    }
  }

  console.log(`対象記事: ${files.length} 本`);
  console.log(`Q/A 抽出成功: ${extractedOk} 本`);
  console.log(`FAQ 見出しのみ（Q/A 0 件・スキップ）: ${headingOnly} 本`);
  if (headingOnlyFiles.length > 0) {
    console.log(`  ${headingOnlyFiles.join(", ")}`);
  }

  if (isCheck) {
    if (pendingFiles.length > 0) {
      console.error(`\n未反映の faqs があります（${pendingFiles.length} 本）。pnpm inject-faqs を実行してコミットしてください:`);
      console.error(`  ${pendingFiles.join(", ")}`);
      process.exit(1);
    }
    console.log("\nfaqs は最新です。");
    return;
  }

  console.log(`\n${writeEnabled ? "書き込み" : "差分（dry-run）"}: ${updated} 本`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
