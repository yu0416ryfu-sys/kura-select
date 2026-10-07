import { describe, it, expect } from 'vitest';
import {
  classifyThinCrawl,
  summarizeThinCrawl,
  formatThinCrawlReport,
  type ThinCrawlRow,
} from '../scripts/lib/thin-category-crawl.ts';
import { NOINDEX_DEPLOYED_AT } from '../scripts/lib/thin-categories.mjs';

const B = NOINDEX_DEPLOYED_AT; // 2026-08-14T06:00:00Z

describe('classifyThinCrawl', () => {
  it('noindex で除外されていれば excluded-noindex', () => {
    expect(
      classifyThinCrawl(
        { verdict: 'NEUTRAL', indexingState: 'BLOCKED_BY_META_TAG', lastCrawlTime: '2026-10-03T23:28:13Z' },
        B,
      ),
    ).toBe('excluded-noindex');
  });

  it('古いクロールのまま登録済みなら stale-indexed', () => {
    expect(classifyThinCrawl({ verdict: 'PASS', lastCrawlTime: '2026-08-12T03:22:01Z' }, B)).toBe('stale-indexed');
  });

  it('境界ちょうどは「以前」側', () => {
    expect(classifyThinCrawl({ verdict: 'PASS', lastCrawlTime: '2026-08-14T06:00:00Z' }, B)).toBe('stale-indexed');
  });

  it('境界より後にクロールされても登録済みなら indexed-after（異常）', () => {
    expect(classifyThinCrawl({ verdict: 'PASS', lastCrawlTime: '2026-10-01T00:00:00Z' }, B)).toBe('indexed-after');
  });

  it('未登録で境界より後のクロールなら dropped-after', () => {
    expect(classifyThinCrawl({ verdict: 'NEUTRAL', lastCrawlTime: '2026-10-01T00:00:00Z' }, B)).toBe('dropped-after');
  });

  it('未登録・未クロールなら not-indexed（完了扱い）', () => {
    expect(classifyThinCrawl({ verdict: 'NEUTRAL', lastCrawlTime: null }, B)).toBe('not-indexed');
  });

  it('日付が読めないとき、登録済みなら stale-indexed', () => {
    expect(classifyThinCrawl({ verdict: 'PASS', lastCrawlTime: 'abc' }, B)).toBe('stale-indexed');
  });

  it('日付が読めないとき、未登録なら not-indexed', () => {
    expect(classifyThinCrawl({ verdict: 'NEUTRAL', lastCrawlTime: 'abc' }, B)).toBe('not-indexed');
  });

  it('verdict FAIL で境界より後のクロールなら dropped-after', () => {
    expect(classifyThinCrawl({ verdict: 'FAIL', lastCrawlTime: '2026-10-01T00:00:00Z' }, B)).toBe('dropped-after');
  });

  it('フィールドが全部欠けていれば not-indexed', () => {
    expect(classifyThinCrawl({}, B)).toBe('not-indexed');
  });

  it('API エラーは error', () => {
    expect(classifyThinCrawl({ error: 'invalid_grant' }, B)).toBe('error');
  });
});

describe('summarizeThinCrawl', () => {
  it('インデックスに無いものだけなら done', () => {
    const s = summarizeThinCrawl([
      { slug: 'a', state: 'excluded-noindex' },
      { slug: 'b', state: 'dropped-after' },
      { slug: 'c', state: 'not-indexed' },
    ]);
    expect(s.done).toBe(true);
    expect(s.counts['excluded-noindex']).toBe(1);
    expect(s.counts['stale-indexed']).toBe(0);
  });

  it('1件でも stale-indexed があれば未完了', () => {
    const s = summarizeThinCrawl([
      { slug: 'a', state: 'excluded-noindex' },
      { slug: 'b', state: 'stale-indexed' },
    ]);
    expect(s.done).toBe(false);
  });

  it('indexed-after は未完了かつ anomalies に入る', () => {
    const s = summarizeThinCrawl([{ slug: 'x', state: 'indexed-after' }]);
    expect(s.done).toBe(false);
    expect(s.anomalies).toEqual(['x']);
  });

  it('error は未完了かつ errors に入る', () => {
    const s = summarizeThinCrawl([{ slug: 'e', state: 'error' }]);
    expect(s.done).toBe(false);
    expect(s.errors).toEqual(['e']);
  });
});

describe('formatThinCrawlReport', () => {
  const row = (slug: string, state: ThinCrawlRow['state'], verdict: string | null = 'NEUTRAL'): ThinCrawlRow => ({
    slug,
    state,
    verdict,
    lastCrawlTime: '2026-08-12T03:22:01Z',
    coverageState: 'Submitted and indexed',
  });

  it('未完了のカテゴリと異常を列挙する', () => {
    const rows = [row('stale', 'stale-indexed', 'PASS'), row('bad', 'indexed-after', 'PASS'), row('ok', 'not-indexed')];
    const text = formatThinCrawlReport(rows, summarizeThinCrawl(rows)).join('\n');
    expect(text).toContain('**未完了**');
    expect(text).toContain('| stale |');
    expect(text).toContain('- bad');
    expect(text).not.toContain('| ok |');
  });

  it('完了時は撤去手順を案内する', () => {
    const rows = [row('ok', 'excluded-noindex')];
    expect(formatThinCrawlReport(rows, summarizeThinCrawl(rows)).join('\n')).toContain('**完了**');
  });

  it('verdict FAIL は完了扱いでも参考に出す', () => {
    const rows = [row('broken', 'dropped-after', 'FAIL')];
    expect(formatThinCrawlReport(rows, summarizeThinCrawl(rows)).join('\n')).toContain('- broken:');
  });
});
