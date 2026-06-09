import {
  calcPricePerUnit,
  extractCapacityTotal,
  extractProductSnapshotByRank,
  normalizeCapacityTotal,
  updateProductInFrontmatterByRank,
  type ProductSnapshot,
  type ProductUpdates,
} from './frontmatter.ts';

export type AiCapacityDecision = 'apply' | 'keep' | 'review' | 'clear';
export type AiCapacityOutcome = 'processed' | 'review' | 'failed' | 'pending' | 'noop';

export interface ParsedJsonlLine {
  lineNo: number;
  raw: string;
  empty: boolean;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface AiCapacityFrozenProduct {
  articleFile: string;
  rank: number;
  name: string;
  rakutenUrl: string | null;
}

export interface AiCapacityApplyResult {
  ok: boolean;
  outcome: AiCapacityOutcome;
  changed: boolean;
  content: string;
  message: string;
  decision?: AiCapacityDecision;
  frozenProduct?: AiCapacityFrozenProduct;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeRank(value: unknown): number | null {
  const rank = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(rank) && rank > 0 ? rank : null;
}

function parseRakutenItemUrl(url: unknown): { shopCode: string; itemCode: string } | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'hb.afl.rakuten.co.jp') {
      const pc = parsed.searchParams.get('pc');
      if (!pc) return null;
      const inner = new URL(decodeURIComponent(pc));
      if (inner.hostname !== 'item.rakuten.co.jp') return null;
      const match = inner.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
      return match ? { shopCode: match[1].toLowerCase(), itemCode: match[2].toLowerCase() } : null;
    }
    if (parsed.hostname === 'item.rakuten.co.jp') {
      const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
      return match ? { shopCode: match[1].toLowerCase(), itemCode: match[2].toLowerCase() } : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function isSameRakutenItemUrl(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const parsedA = parseRakutenItemUrl(a);
  const parsedB = parseRakutenItemUrl(b);
  if (parsedA && parsedB) {
    return parsedA.shopCode === parsedB.shopCode && parsedA.itemCode === parsedB.itemCode;
  }
  return a.trim() === b.trim();
}

function isSameCapacityValue(expected: unknown, actual: string | null): boolean {
  const normalizedExpected = expected === undefined ? null : expected;
  if (normalizedExpected === null || normalizedExpected === '-') {
    return (actual ?? null) === normalizedExpected;
  }
  if (typeof normalizedExpected !== 'string' || typeof actual !== 'string') return false;
  if (normalizedExpected === actual) return true;

  const expectedTotal = normalizeCapacityTotal(extractCapacityTotal(normalizedExpected));
  const actualTotal = normalizeCapacityTotal(extractCapacityTotal(actual));
  return Boolean(
    expectedTotal &&
    actualTotal &&
    expectedTotal.total === actualTotal.total &&
    expectedTotal.unit.toLowerCase() === actualTotal.unit.toLowerCase()
  );
}

function getDecision(match: unknown): AiCapacityDecision | null {
  const decision = (match as { decision?: unknown })?.decision;
  return decision === 'apply' || decision === 'keep' || decision === 'review' || decision === 'clear'
    ? decision
    : null;
}

function requiresStaleGuard(decision: AiCapacityDecision): boolean {
  return decision === 'apply' || decision === 'clear' || decision === 'keep';
}

export function buildAiCapacityProductUpdates(
  match: Record<string, unknown>,
  currentProduct: ProductSnapshot,
  preferUnit?: string
): { ok: boolean; updates?: ProductUpdates; message?: string } {
  const decision = getDecision(match);
  if (decision === 'clear') {
    return {
      ok: true,
      updates: {
        price: null,
        rating: null,
        reviewCount: null,
        affiliateUrl: null,
        imageUrl: null,
        newCapacity: '-',
        pricePerUnit: '-',
      },
    };
  }

  if (decision !== 'apply') return { ok: true, updates: undefined };
  const newCapacity = match.newCapacity;
  if (typeof newCapacity !== 'string' || newCapacity.trim() === '' || newCapacity === '-') {
    return { ok: false, message: 'decision apply requires non-empty newCapacity' };
  }
  if (!extractCapacityTotal(newCapacity)) {
    return { ok: false, message: `newCapacity is not parseable: ${newCapacity}` };
  }
  if (typeof currentProduct.price !== 'number' || currentProduct.price <= 0) {
    return { ok: false, message: 'current MD price must be a positive number' };
  }
  const pricePerUnit = calcPricePerUnit(currentProduct.price, newCapacity, preferUnit);
  if (!pricePerUnit) {
    return { ok: false, message: `pricePerUnit cannot be calculated from ${newCapacity}` };
  }
  return {
    ok: true,
    updates: {
      price: null,
      rating: null,
      reviewCount: null,
      affiliateUrl: null,
      imageUrl: null,
      newCapacity,
      pricePerUnit,
    },
  };
}

export function validateAiCapacityMatch(
  match: unknown,
  currentProduct: ProductSnapshot | null
): { ok: boolean; outcome: AiCapacityOutcome; decision?: AiCapacityDecision; message: string } {
  if (!match || typeof match !== 'object') {
    return { ok: false, outcome: 'failed', message: 'line is not an object' };
  }
  const data = match as Record<string, unknown>;
  const decision = getDecision(data);
  if (!decision) return { ok: false, outcome: 'failed', message: `unsupported decision: ${String(data.decision ?? '-')}` };
  if (decision === 'review') return { ok: true, outcome: 'review', decision, message: String(data.reason ?? 'review') };

  const rank = normalizeRank(data.rank);
  if (rank === null) return { ok: false, outcome: 'failed', decision, message: 'rank is required' };
  const current = data.current;
  if (!current || typeof current !== 'object') {
    return { ok: false, outcome: 'failed', decision, message: 'current object is required' };
  }
  const currentData = current as Record<string, unknown>;
  if (typeof currentData.name !== 'string' || !hasOwn(currentData, 'capacity')) {
    return { ok: false, outcome: 'failed', decision, message: 'current.name and current.capacity are required' };
  }
  if (!currentProduct) return { ok: true, outcome: 'review', decision, message: `rank ${rank} not found in current MD` };
  if (currentProduct.rank !== rank) {
    return { ok: true, outcome: 'review', decision, message: `rank mismatch: JSONL ${rank}, current ${currentProduct.rank}` };
  }
  if (currentProduct.name !== currentData.name) {
    return {
      ok: true,
      outcome: 'review',
      decision,
      message: `rank/current.name mismatch: rank ${rank} is "${currentProduct.name}", JSONL current is "${currentData.name}"`,
    };
  }
  if (!isSameCapacityValue(currentData.capacity, currentProduct.capacity)) {
    return {
      ok: true,
      outcome: 'review',
      decision,
      message: `current.capacity mismatch: MD "${currentProduct.capacity ?? '-'}", JSONL "${String(currentData.capacity ?? '-')}"`,
    };
  }

  if (requiresStaleGuard(decision)) {
    if (typeof currentData.price !== 'number' || typeof currentData.rakutenUrl !== 'string') {
      return { ok: true, outcome: 'review', decision, message: 'current.price and current.rakutenUrl are required for auto apply' };
    }
    if (currentProduct.price !== currentData.price) {
      return { ok: true, outcome: 'review', decision, message: `current.price mismatch: MD ${currentProduct.price ?? '-'}, JSONL ${currentData.price}` };
    }
    if (!isSameRakutenItemUrl(currentData.rakutenUrl, currentProduct.rakutenUrl)) {
      return { ok: true, outcome: 'review', decision, message: 'current.rakutenUrl points to a different item' };
    }

    const basis = data.basis;
    if (!basis || typeof basis !== 'object') {
      return { ok: true, outcome: 'review', decision, message: 'basis is required for auto apply' };
    }
    const basisData = basis as Record<string, unknown>;
    if (typeof basisData.apiPrice !== 'number' || typeof basisData.itemUrl !== 'string' || typeof basisData.affiliateUrl !== 'string') {
      return { ok: true, outcome: 'review', decision, message: 'basis.apiPrice, basis.itemUrl and basis.affiliateUrl are required' };
    }
    if (basisData.apiPrice !== currentProduct.price) {
      return { ok: true, outcome: 'review', decision, message: `basis.apiPrice mismatch: MD ${currentProduct.price ?? '-'}, basis ${basisData.apiPrice}` };
    }
    if (
      !isSameRakutenItemUrl(basisData.affiliateUrl, currentProduct.rakutenUrl) ||
      !isSameRakutenItemUrl(basisData.itemUrl, currentProduct.rakutenUrl)
    ) {
      return { ok: true, outcome: 'review', decision, message: 'basis URL points to a different item' };
    }
  }

  return { ok: true, outcome: 'processed', decision, message: 'ok' };
}

export function applyAiCapacityToContent(
  content: string,
  match: Record<string, unknown>,
  preferUnit?: string
): AiCapacityApplyResult {
  const rank = normalizeRank(match.rank);
  const currentProduct = rank === null ? null : extractProductSnapshotByRank(content, rank);
  const validation = validateAiCapacityMatch(match, currentProduct);
  if (!validation.ok || validation.outcome !== 'processed') {
    return {
      ok: validation.ok,
      outcome: validation.outcome,
      changed: false,
      content,
      decision: validation.decision,
      message: validation.message,
    };
  }

  const decision = validation.decision;
  if (!decision) {
    return { ok: false, outcome: 'failed', changed: false, content, message: 'decision is missing after validation' };
  }
  const frozenProduct = buildAiCapacityFrozenProduct(match, currentProduct!);
  if (decision === 'keep') {
    return {
      ok: true,
      outcome: 'processed',
      changed: false,
      content,
      decision,
      message: 'keep',
      frozenProduct,
    };
  }

  const updateResult = buildAiCapacityProductUpdates(match, currentProduct!, preferUnit);
  if (!updateResult.ok) {
    return {
      ok: true,
      outcome: 'review',
      changed: false,
      content,
      decision,
      message: updateResult.message ?? 'invalid capacity update',
    };
  }
  if (!updateResult.updates) {
    return { ok: true, outcome: 'processed', changed: false, content, decision, message: 'no update' };
  }

  const current = (match.current ?? {}) as Record<string, unknown>;
  const result = updateProductInFrontmatterByRank(content, currentProduct!.rank, updateResult.updates, {
    name: currentProduct!.name,
    capacity: currentProduct!.capacity,
    price: currentProduct!.price,
    rakutenUrl: currentProduct!.rakutenUrl,
  });
  if (!result.changed && result.reason) {
    return { ok: true, outcome: 'review', changed: false, content, decision, message: result.reason };
  }

  return {
    ok: true,
    outcome: 'processed',
    changed: result.changed,
    content: result.content,
    decision,
    message: decision,
    frozenProduct,
  };
}

export function buildAiCapacityFrozenProduct(
  match: Record<string, unknown>,
  currentProduct: ProductSnapshot
): AiCapacityFrozenProduct {
  return {
    articleFile: String(match.articleFile ?? ''),
    rank: currentProduct.rank,
    name: currentProduct.name,
    rakutenUrl: currentProduct.rakutenUrl,
  };
}

export function buildProcessedAiCapacityFrozenProduct(
  match: unknown,
  currentProduct: ProductSnapshot | null
): AiCapacityFrozenProduct | null {
  if (!match || typeof match !== 'object' || !currentProduct) return null;
  const data = match as Record<string, unknown>;
  const decision = getDecision(data);
  if (decision !== 'apply' && decision !== 'keep' && decision !== 'clear') return null;

  const rank = normalizeRank(data.rank);
  if (rank === null || currentProduct.rank !== rank) return null;
  const current = data.current;
  if (!current || typeof current !== 'object') return null;
  const currentData = current as Record<string, unknown>;
  if (currentData.name !== currentProduct.name) return null;
  if (typeof currentData.rakutenUrl !== 'string') return null;
  if (!isSameRakutenItemUrl(currentData.rakutenUrl, currentProduct.rakutenUrl)) return null;

  if (decision === 'apply') {
    if (!isSameCapacityValue(data.newCapacity, currentProduct.capacity)) return null;
  } else if (decision === 'clear') {
    if (!isSameCapacityValue('-', currentProduct.capacity)) return null;
  } else if (!isSameCapacityValue(currentData.capacity, currentProduct.capacity)) {
    return null;
  }

  return buildAiCapacityFrozenProduct(data, currentProduct);
}

export function buildCapacityReviewInputItem(args: {
  file: string;
  category?: string | null;
  method: string;
  currentSnapshot: ProductSnapshot | null;
  data: Record<string, unknown>;
  capacityAnalysis: Record<string, unknown>;
  extractedCap: string | null;
  reviewReasons: string[];
  action: string;
}) {
  const articleFile = args.file.startsWith('src/content/articles/')
    ? args.file
    : `src/content/articles/${args.file}`;
  const current = args.currentSnapshot;
  const apiPrice = typeof args.data.price === 'number' ? args.data.price : null;
  const itemUrl = typeof args.data.itemUrl === 'string' ? args.data.itemUrl : null;
  const affiliateUrl = typeof args.data.affiliateUrl === 'string' ? args.data.affiliateUrl : null;

  return {
    articleFile,
    rank: current?.rank ?? null,
    category: args.category ?? null,
    method: args.method,
    current: {
      name: current?.name ?? '',
      capacity: current?.capacity ?? null,
      price: current?.price ?? null,
      rakutenUrl: current?.rakutenUrl ?? null,
      pricePerUnit: current?.pricePerUnit ?? null,
    },
    basis: {
      apiPrice,
      itemUrl,
      affiliateUrl,
    },
    api: {
      itemName: typeof args.data.name === 'string' ? args.data.name : '',
      price: apiPrice,
      rating: typeof args.data.rating === 'number' ? args.data.rating : null,
      reviewCount: typeof args.data.reviewCount === 'number' ? args.data.reviewCount : null,
      itemUrl,
      affiliateUrl,
      imageUrl: typeof args.data.imageUrl === 'string' ? args.data.imageUrl : null,
    },
    ruleAnalysis: {
      extractedCapacity: args.extractedCap,
      confidence: args.capacityAnalysis.confidence ?? null,
      reasons: args.reviewReasons,
    },
    action: args.action,
  };
}

export function parseJsonlPreservingRaw(text: string): ParsedJsonlLine[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((raw, index) => {
    const lineNo = index + 1;
    if (raw.trim() === '') return { lineNo, raw, empty: true, ok: true };
    try {
      return { lineNo, raw, empty: false, ok: true, data: JSON.parse(raw) };
    } catch (error) {
      return {
        lineNo,
        raw,
        empty: false,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function classifyAiCapacityLine(
  parsed: ParsedJsonlLine,
  currentSnapshot: ProductSnapshot | null,
  fileMatches = true
): { outcome: AiCapacityOutcome; lineNo: number; raw: string; data?: unknown; message?: string } {
  if (parsed.empty) return { outcome: 'noop', lineNo: parsed.lineNo, raw: parsed.raw };
  if (!parsed.ok) return { outcome: 'failed', lineNo: parsed.lineNo, raw: parsed.raw, message: parsed.error };
  if (!fileMatches) return { outcome: 'pending', lineNo: parsed.lineNo, raw: parsed.raw, data: parsed.data };
  const validation = validateAiCapacityMatch(parsed.data, currentSnapshot);
  return {
    outcome: validation.outcome,
    lineNo: parsed.lineNo,
    raw: parsed.raw,
    data: parsed.data,
    message: validation.message,
  };
}

export function computePendingFinalization(
  outcomes: Array<{ outcome: AiCapacityOutcome; raw?: string }>
): { hasPending: boolean; pendingText: string; shouldArchiveSource: boolean } {
  const pendingLines = outcomes
    .filter(outcome => outcome.outcome === 'pending')
    .map(outcome => outcome.raw ?? '')
    .filter(raw => raw.trim() !== '');
  return {
    hasPending: pendingLines.length > 0,
    pendingText: pendingLines.length > 0 ? `${pendingLines.join('\n')}\n` : '',
    shouldArchiveSource: pendingLines.length === 0,
  };
}
