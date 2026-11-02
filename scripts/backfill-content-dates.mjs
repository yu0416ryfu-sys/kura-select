// 一度きり: git の履歴から記事ごとの「内容の更新日」を求めて data/content-dates.json を作る。計画書5 §3.3-4。
//
// 使い方（最新の main・作業ツリーがクリーンな状態で実行する）:
//   node --experimental-strip-types scripts/backfill-content-dates.mjs --dry   reports/index-triage/backfill-dryrun.md に全件の日付と根拠コミットを出す
//   node --experimental-strip-types scripts/backfill-content-dates.mjs         台帳を書く
//
// 求め方: 記事ごとに git log（author date を JST にする・--follow は使わない＝改名前の履歴は数えない）を
// 新しい順に遡り、各コミット時点のファイルに computeContentHash を当てる。HEAD と同じハッシュが
// 途切れずに続く最も古いコミットの日付を「内容の更新日」とする（＝ハッシュが最後に変わったコミット）。
// 作業ツリーの未コミット分は無視する。日付が publishedAt より前なら publishedAt にする（下書き期間の日付を出さない）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ARTICLES_DIR, listContentFiles } from "./lib/thin-categories.mjs";
import { parseFrontmatter } from "./lib/frontmatter.ts";
import { computeContentHash, slugFromArticlePath, toJstDate, writeContentDates } from "./lib/content-stamp.ts";

const isDry = process.argv.includes("--dry");
const REPORT_PATH = path.resolve("./reports/index-triage/backfill-dryrun.md");

function git(args, input) {
  return execFileSync("git", args, { input, maxBuffer: 1024 * 1024 * 1024 });
}

/** git cat-file --batch で複数の `<commit>:<path>` を1プロセスで読む（存在しなければ null） */
function readBlobs(specs) {
  const out = git(["cat-file", "--batch"], specs.join("\n") + "\n");
  const blobs = [];
  let pos = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    if (header.endsWith(" missing")) {
      blobs.push(null);
      continue;
    }
    const size = Number(header.split(" ")[2]);
    blobs.push(out.subarray(pos, pos + size).toString("utf8"));
    pos += size + 1; // 内容の後ろの改行
  }
  return blobs;
}

const rows = [];
const ledger = {};
for (const file of listContentFiles(ARTICLES_DIR)) {
  const relPath = path.relative(process.cwd(), file).replace(/\\/g, "/");
  const head = parseFrontmatter(fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n"));
  if (!head || head.data.draft === true) continue;
  const slug = slugFromArticlePath(file, ARTICLES_DIR);
  const publishedAt = String(head.data.publishedAt ?? "");

  // 新しい順: <hash>\t<author date ISO>\t<件名>
  const commits = git(["log", "--format=%H%x09%aI%x09%s", "--", relPath])
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...subject] = line.split("\t");
      return { sha, date, subject: subject.join("\t") };
    });
  if (commits.length === 0) {
    console.warn(`履歴なし（未コミット）のため飛ばします: ${slug}`);
    continue;
  }
  const blobs = readBlobs(commits.map((c) => `${c.sha}:${relPath}`));
  const headHash = blobs[0] === null ? null : computeContentHash(blobs[0]);

  let origin = commits[0];
  for (let i = 1; i < commits.length; i++) {
    const hash = blobs[i] === null ? null : computeContentHash(blobs[i]);
    if (hash !== headHash) break;
    origin = commits[i];
  }
  const gitDate = toJstDate(new Date(origin.date));
  const contentUpdatedAt = publishedAt && gitDate < publishedAt ? publishedAt : gitDate;
  ledger[slug] = { hash: headHash, contentUpdatedAt };
  rows.push({ slug, contentUpdatedAt, gitDate, publishedAt, origin, commitCount: commits.length });
}

const sorted = Object.fromEntries(Object.keys(ledger).sort().map((slug) => [slug, ledger[slug]]));

if (isDry) {
  const lines = [
    `# content-dates backfill dry-run（${toJstDate(new Date())}・HEAD ${git(["rev-parse", "--short", "HEAD"]).toString().trim()}）`,
    "",
    `記事 ${rows.length} 本。根拠コミット＝HEAD と同じ内容ハッシュが途切れずに続く最も古いコミット。`,
    "",
    "| slug | contentUpdatedAt | git の日付 | publishedAt | 根拠コミット | 件名 | 履歴数 |",
    "|---|---|---|---|---|---|---:|",
    ...rows
      .sort((a, b) => b.contentUpdatedAt.localeCompare(a.contentUpdatedAt) || a.slug.localeCompare(b.slug))
      .map(
        (r) =>
          `| ${r.slug} | ${r.contentUpdatedAt} | ${r.gitDate} | ${r.publishedAt} | ${r.origin.sha.slice(0, 8)} | ${r.origin.subject.replace(/\|/g, "／")} | ${r.commitCount} |`
      ),
    "",
  ];
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join("\n"), "utf8");
  console.log(`dry-run: ${rows.length} 本 → ${path.relative(process.cwd(), REPORT_PATH)}`);
} else {
  writeContentDates(sorted);
  console.log(`data/content-dates.json を書きました（${rows.length} 本）`);
}
