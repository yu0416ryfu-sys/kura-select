/**
 * OGP画像（1200×630px）を生成するスクリプト
 * 使い方: node scripts/generate-ogp.mjs
 */
import sharp from 'sharp';
import { resolve } from 'path';

const WIDTH = 1200;
const HEIGHT = 630;

// SVGでデザインを定義し、sharpでPNGに変換
const svg = `
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

  <!-- 背景 -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />

  <!-- 上部のアクセントライン -->
  <rect x="0" y="0" width="${WIDTH}" height="8" fill="url(#accent)" />

  <!-- アイコン -->
  <text x="600" y="200" text-anchor="middle" font-size="80" fill="#0ea5e9">🏠</text>

  <!-- サイト名 -->
  <text x="600" y="300" text-anchor="middle"
        font-family="sans-serif" font-size="72" font-weight="bold" fill="#0f172a">
    暮らセレクト
  </text>

  <!-- サブタイトル -->
  <text x="600" y="380" text-anchor="middle"
        font-family="sans-serif" font-size="32" fill="#475569">
    日用品・消耗品のコスパ比較サイト
  </text>

  <!-- 区切り線 -->
  <rect x="450" y="420" width="300" height="3" rx="2" fill="url(#accent)" />

  <!-- キャッチコピー -->
  <text x="600" y="490" text-anchor="middle"
        font-family="sans-serif" font-size="28" fill="#64748b">
    毎日使うものをお得に選ぼう
  </text>

  <!-- 下部のドメイン表示 -->
  <rect x="0" y="570" width="${WIDTH}" height="60" fill="#0f172a" opacity="0.08" />
  <text x="600" y="610" text-anchor="middle"
        font-family="monospace" font-size="22" fill="#64748b">
    kura-select
  </text>
</svg>`;

const outputPath = resolve(process.cwd(), 'public/og-default.png');

await sharp(Buffer.from(svg))
  .png({ quality: 90 })
  .toFile(outputPath);

console.log(`✅ OGP画像を生成しました: ${outputPath}`);
console.log(`   サイズ: ${WIDTH}×${HEIGHT}px`);
