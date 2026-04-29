/**
 * 記事ごとのOGP画像（1200×630px）を自動生成するスクリプト
 *
 * 使い方:
 *   node scripts/generate-ogp.mjs           # デフォルト画像 + 全記事OGP生成
 *   node scripts/generate-ogp.mjs --only-default  # デフォルト画像のみ
 *
 * 出力先:
 *   public/og-default.png           — サイト共通OGP
 *   public/og/articles/<slug>.png   — 記事別OGP
 */
import sharp from 'sharp';
import { resolve, join } from 'path';
import { readdirSync, readFileSync, mkdirSync, existsSync } from 'fs';

const WIDTH = 1200;
const HEIGHT = 630;
const ONLY_DEFAULT = process.argv.includes('--only-default');

// ─── SVGテンプレート：サイト共通 ─────────────────────────────────────────
function buildDefaultSvg() {
  return `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#e0f2fe;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#d1fae5;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#0ea5e9;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#10b981;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />
  <rect x="0" y="0" width="${WIDTH}" height="8" fill="url(#accent)" />
  <text x="600" y="200" text-anchor="middle" font-size="80" fill="#0ea5e9">🏠</text>
  <text x="600" y="300" text-anchor="middle"
        font-family="sans-serif" font-size="72" font-weight="bold" fill="#0f172a">
    暮らセレクト
  </text>
  <text x="600" y="380" text-anchor="middle"
        font-family="sans-serif" font-size="32" fill="#475569">
    日用品・消耗品のコスパ比較サイト
  </text>
  <rect x="450" y="420" width="300" height="3" rx="2" fill="url(#accent)" />
  <text x="600" y="490" text-anchor="middle"
        font-family="sans-serif" font-size="28" fill="#64748b">
    毎日使うものをお得に選ぼう
  </text>
  <rect x="0" y="570" width="${WIDTH}" height="60" fill="#0f172a" opacity="0.08" />
  <text x="600" y="610" text-anchor="middle"
        font-family="monospace" font-size="22" fill="#64748b">
    kura-select
  </text>
</svg>`;
}

// ─── SVGテンプレート：記事別 ─────────────────────────────────────────────
function buildArticleSvg(title, category) {
  // タイトルが長い場合は改行（1行あたり最大18文字）
  const lines = splitTitle(title, 18);
  const lineHeight = 64;
  const startY = 280 - ((lines.length - 1) * lineHeight) / 2;

  const titleElements = lines
    .map((line, i) => {
      const escaped = escapeXml(line);
      return `<text x="600" y="${startY + i * lineHeight}" text-anchor="middle"
        font-family="sans-serif" font-size="52" font-weight="bold" fill="#0f172a">
    ${escaped}
  </text>`;
    })
    .join("\n  ");

  const escapedCategory = escapeXml(category);

  return `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#e0f2fe;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#d1fae5;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#0ea5e9;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#10b981;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />
  <rect x="0" y="0" width="${WIDTH}" height="8" fill="url(#accent)" />

  <!-- カテゴリラベル -->
  <rect x="440" y="120" width="320" height="40" rx="20" fill="#0ea5e9" opacity="0.15" />
  <text x="600" y="148" text-anchor="middle"
        font-family="sans-serif" font-size="22" font-weight="bold" fill="#0ea5e9">
    ${escapedCategory}
  </text>

  <!-- 記事タイトル -->
  ${titleElements}

  <!-- 区切り線 -->
  <rect x="400" y="420" width="400" height="3" rx="2" fill="url(#accent)" />

  <!-- サイト名 -->
  <text x="600" y="490" text-anchor="middle"
        font-family="sans-serif" font-size="28" fill="#64748b">
    暮らセレクト
  </text>

  <!-- 下部 -->
  <rect x="0" y="570" width="${WIDTH}" height="60" fill="#0f172a" opacity="0.08" />
  <text x="600" y="610" text-anchor="middle"
        font-family="monospace" font-size="22" fill="#64748b">
    kura-select
  </text>
</svg>`;
}

// ─── ユーティリティ ──────────────────────────────────────────────────────
function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function splitTitle(title, maxCharsPerLine) {
  const lines = [];
  let remaining = title;
  while (remaining.length > maxCharsPerLine) {
    let splitIdx = maxCharsPerLine;
    const breakChars = ["】", "」", "）", " ", "・", "、", "。"];
    for (let i = maxCharsPerLine; i >= maxCharsPerLine - 5 && i > 0; i--) {
      if (breakChars.some((c) => remaining[i - 1] === c)) {
        splitIdx = i;
        break;
      }
    }
    lines.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function extractFrontmatterField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*"?(.+?)"?\\s*$`, "m"));
  return match ? match[1] : null;
}

// ─── メイン処理 ──────────────────────────────────────────────────────────
async function main() {
  const publicDir = resolve(process.cwd(), "public");

  // 1. デフォルトOGP生成
  const defaultPath = join(publicDir, "og-default.png");
  await sharp(Buffer.from(buildDefaultSvg())).png({ quality: 90 }).toFile(defaultPath);
  console.log(`✅ デフォルトOGP: ${defaultPath}`);

  if (ONLY_DEFAULT) return;

  // 2. 記事別OGP生成
  const ogDir = join(publicDir, "og", "articles");
  if (!existsSync(ogDir)) {
    mkdirSync(ogDir, { recursive: true });
  }

  const articlesDir = resolve(process.cwd(), "src/content/articles");
  const files = readdirSync(articlesDir).filter(
    (f) => f.endsWith(".md") && !f.endsWith(".bak")
  );

  console.log(`\n📄 記事別OGP生成: ${files.length}件`);

  for (const file of files) {
    const content = readFileSync(join(articlesDir, file), "utf-8");
    const title = extractFrontmatterField(content, "title");
    const category = extractFrontmatterField(content, "category") ?? "";

    if (!title) {
      console.log(`   ⚠ タイトルなし: ${file}`);
      continue;
    }

    const slug = file.replace(/\.md$/, "");
    const outputPath = join(ogDir, `${slug}.png`);
    const svg = buildArticleSvg(title, category);

    await sharp(Buffer.from(svg)).png({ quality: 90 }).toFile(outputPath);
    console.log(`   ✅ ${slug}.png — "${title.slice(0, 30)}..."`);
  }

  console.log(`\n🎉 完了`);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
