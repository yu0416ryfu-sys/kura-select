import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let [inputPath, outputPath] = args;

function findDefaultInputPath() {
  const inputDir = 'reports/toAI/kura-product-match-ai';
  if (!fs.existsSync(inputDir)) return null;
  const files = fs.readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^product-match-input-.*\.jsonl$/.test(entry.name))
    .map((entry) => path.join(inputDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
  return files[0] ?? null;
}

if (args.length === 1) {
  outputPath = args[0];
  inputPath = findDefaultInputPath();
}

if (!inputPath || !outputPath) {
  console.error('Usage: node .agents/skills/kura-product-match-ai/scripts/validate-output.mjs [input.jsonl] <output.jsonl>');
  console.error('Default input: reports/toAI/kura-product-match-ai/product-match-input-*.jsonl');
  process.exit(1);
}

function readJsonl(path) {
  const text = fs.readFileSync(path, 'utf8').trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSON: ${error.message}`);
    }
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getArticleProductBlock(articleFile, rank) {
  const md = fs.readFileSync(articleFile, 'utf8');
  const rankPattern = new RegExp(`\\n\\s*-\\s+rank:\\s*${escapeRegExp(rank)}\\s*\\n`, 'm');
  const match = rankPattern.exec(md);
  if (!match) return null;
  const start = match.index;
  const rest = md.slice(start + 1);
  const next = /\n\s*-\s+rank:\s*\d+\s*\n/m.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

function getNameFromProductBlock(block) {
  if (!block) return null;
  const match = /^\s*name:\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/m.exec(block);
  return match ? (match[1] ?? match[2] ?? match[3]?.trim() ?? null) : null;
}

const inputLines = readJsonl(inputPath);
const outputLines = readJsonl(outputPath);

if (inputLines.length !== outputLines.length) {
  throw new Error(`count mismatch: input ${inputLines.length}, output ${outputLines.length}`);
}

let replaceCount = 0;
let reviewCount = 0;

for (let i = 0; i < outputLines.length; i += 1) {
  const lineNo = i + 1;
  const input = inputLines[i];
  const output = outputLines[i];

  if (output.action === 'replace') replaceCount += 1;
  else if (output.action === 'review') reviewCount += 1;
  else throw new Error(`line ${lineNo}: unsupported action ${output.action ?? '-'}`);

  const textFields = [output.reason, output.newName, output.newCapacity, output.newPricePerUnit].filter(Boolean);
  if (textFields.some((value) => /[?]{3,}/.test(value))) {
    throw new Error(`line ${lineNo}: possible mojibake`);
  }

  if (output.action !== 'replace') continue;

  const candidates = input.candidates ?? [];
  const urlChecks = [
    ['selectedItemUrl', 'itemUrl'],
    ['selectedAffiliateUrl', 'affiliateUrl'],
    ['selectedImageUrl', 'imageUrl'],
  ];
  for (const [outputKey, candidateKey] of urlChecks) {
    if (!candidates.some((candidate) => candidate[candidateKey] === output[outputKey])) {
      throw new Error(`line ${lineNo}: ${outputKey} is not from candidates`);
    }
  }

  const articleFile = output.articleFile ?? input.articleFile;
  const block = getArticleProductBlock(articleFile, output.rank);
  const currentName = output.current?.name ?? output.currentName ?? null;
  const articleName = getNameFromProductBlock(block);
  if (!articleName || articleName !== currentName) {
    throw new Error(
      `line ${lineNo}: rank/current.name mismatch: article has "${articleName ?? '-'}", output has "${currentName ?? '-'}"`,
    );
  }
}

console.log(`valid jsonl ${outputLines.length} replace ${replaceCount} review ${reviewCount}`);
