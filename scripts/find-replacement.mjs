// 差し替え候補を探す CLI（読み取り専用）
// 使い方: node --experimental-strip-types scripts/find-replacement.mjs --slug=hand-cream --rank=1 --keyword="ニベア ハンドクリーム"
//   --allow-variant  価格帯（選択式）商品も候補に残す
//   --hits=30        取得件数
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractAllProductsData, extractProductSnapshotByRank, extractArticleTitle,
  extractArticleCategory, extractCapacityFromItemName, calcPricePerUnit,
  getArticleTargetUnit, isMultiMeasureVariantItemName, isSalesQuantityVariantItemName,
  hasVariantPriceRange,
} from './lib/frontmatter.ts';
import { toRakutenUrlKey } from './lib/rakuten-url.ts';
import {
  resolveArticleSearchRule, checkAdditionCandidateCategory,
  isAllowedCapacityUnit, scoreAdditionCandidate,
} from './lib/search-rules.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const get = (p) => process.argv.find((a) => a.startsWith(p))?.split('=').slice(1).join('=') ?? null;
const slug = get('--slug=');
const rank = Number(get('--rank=') ?? '1');
const keyword = get('--keyword=');
const hits = get('--hits=') ?? '30';
const allowVariant = process.argv.includes('--allow-variant');
if (!slug || !keyword) {
  console.error('--slug と --keyword は必須です');
  process.exit(1);
}

const env = { ...process.env };
for (const line of readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const file = path.join(ROOT, 'src/content/articles', slug + '-comparison.md');
if (!existsSync(file)) {
  console.error('記事が見つかりません: ' + file);
  process.exit(1);
}
const content = readFileSync(file, 'utf-8');
const products = extractAllProductsData(content);
const current = extractProductSnapshotByRank(content, rank);
const category = extractArticleCategory(content) ?? slug;
const title = extractArticleTitle(content) ?? '';
const { baseKeyword, rule } = resolveArticleSearchRule({
  title, products: products.map((p) => ({ name: p.name })), file: path.basename(file), category,
});
const usedKeys = new Set(products.filter((p) => p.rank !== rank).map((p) => toRakutenUrlKey(p.rakutenUrl)).filter(Boolean));
const targetUnit = getArticleTargetUnit(slug + '-comparison');

const params = new URLSearchParams({
  applicationId: env.RAKUTEN_APPLICATION_ID,
  affiliateId: env.PUBLIC_RAKUTEN_AFFILIATE_ID ?? '',
  keyword, hits, sort: '-reviewCount', imageFlag: '1', formatVersion: '2',
  elements: 'itemName,itemPrice,itemPriceMin1,itemPriceMax1,itemUrl,affiliateUrl,mediumImageUrls,reviewCount,reviewAverage,shopName,shopUrl',
});
const res = await fetch('https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?' + params, {
  headers: { accessKey: env.RAKUTEN_ACCESS_KEY, Origin: 'https://yu0416ryfu-sys.github.io', Referer: 'https://yu0416ryfu-sys.github.io/' },
});
if (!res.ok) {
  console.error('API ' + res.status + ' ' + (await res.text()).slice(0, 200));
  process.exit(1);
}
const data = await res.json();

console.log('記事: ' + slug + ' / category=' + category + ' / baseKeyword=' + baseKeyword + ' / targetUnit=' + (targetUnit ?? '-'));
console.log('現 rank' + rank + ': ' + (current?.name ?? '-') + ' | ' + current?.price + '円 | ' + current?.capacity);
console.log('候補 ' + (data.Items?.length ?? 0) + ' 件を評価\n');

let shown = 0;
for (const item of data.Items ?? []) {
  if (/ふるさと納税|寄付|寄附|返礼品/.test(item.itemName ?? '')) continue;
  const key = toRakutenUrlKey(item.itemUrl) ?? toRakutenUrlKey(item.affiliateUrl);
  if (key && usedKeys.has(key)) continue;
  const variantRange = hasVariantPriceRange(item.itemPriceMin1, item.itemPriceMax1);
  const variantName = isMultiMeasureVariantItemName(item.itemName) || isSalesQuantityVariantItemName(item.itemName);
  if (!allowVariant && (variantRange || variantName)) continue;
  const candidate = { name: item.itemName, price: item.itemPrice, reviewCount: item.reviewCount, rating: item.reviewAverage ? Number(item.reviewAverage) : null };
  const cat = checkAdditionCandidateCategory(candidate, rule);
  const capacity = extractCapacityFromItemName(item.itemName);
  const unitOk = capacity ? isAllowedCapacityUnit(capacity, rule) : null;
  const scored = scoreAdditionCandidate(candidate, rule);
  const verdict = !cat.ok ? 'NG(' + cat.reason + ')' : scored.score < rule.minScore ? 'NG(score ' + scored.score + '<' + rule.minScore + ')' : 'OK';
  if (verdict !== 'OK') continue;
  shown++;
  console.log('--- 候補' + shown + ' [score ' + scored.score + '] ' + (variantRange ? '⚠価格帯 ' : '') + (variantName ? '⚠選択式 ' : ''));
  console.log('name      : ' + item.itemName);
  console.log('price     : ' + item.itemPrice + '（min ' + item.itemPriceMin1 + ' / max ' + item.itemPriceMax1 + '）');
  console.log('capacity  : ' + (capacity ?? '-') + ' / 単位許可: ' + (unitOk === null ? '判定不能' : unitOk));
  console.log('perUnit   : ' + (capacity && item.itemPrice ? calcPricePerUnit(item.itemPrice, capacity, targetUnit) : '-'));
  console.log('review    : ' + item.reviewCount + '件 / ' + item.reviewAverage);
  console.log('shop      : ' + item.shopName);
  console.log('itemUrl   : ' + item.itemUrl);
  console.log('affiliate : ' + item.affiliateUrl);
  console.log('image     : ' + (item.mediumImageUrls?.[0] ?? '-'));
  console.log('');
  if (shown >= 8) break;
}
if (shown === 0) console.log('（ルールを通る候補がありません。--allow-variant や別キーワードを試してください）');
