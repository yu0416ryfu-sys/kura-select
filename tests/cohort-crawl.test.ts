import { describe, it, expect } from 'vitest';
import {
  addDays,
  evaluateCohortCrawl,
  formatCohortCrawlSection,
  isRecrawled,
  selectCohortCrawlTargets,
  toJstDate,
  type CohortCrawlTarget,
  type InspectionResult,
} from '../scripts/lib/cohort-crawl.ts';

const SITE = 'https://www.kura-select.com/';

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    holds: [
      {
        slugs: ['a-comparison', 'b-comparison'],
        cohortId: 'cohort-01-description',
        arm: 'treatment',
        startedAt: '2026-09-09',
        deployedAt: '2026-09-08T22:45:25Z',
        lastCrawlAtApply: {
          'a-comparison': '2026-08-22T12:48:44Z',
          'b-comparison': '2026-09-02T09:12:19Z',
        },
        ...overrides,
      },
      {
        slugs: ['c-comparison'],
        cohortId: 'cohort-01-description',
        arm: 'control',
        startedAt: '2026-09-09',
      },
      { slug: 'unrelated-comparison', releaseDate: '2026-09-22' },
    ],
  };
}

function target(over: Partial<CohortCrawlTarget> = {}): CohortCrawlTarget {
  return {
    cohortId: 'cohort-01-description',
    arm: 'treatment',
    slug: 'a-comparison',
    url: `${SITE}articles/a-comparison/`,
    startedAt: '2026-09-09',
    crawlAtApply: '2026-08-22T12:48:44Z',
    deployedAt: null,
    ...over,
  };
}

describe('toJstDate', () => {
  it('UTC を JST の日付に直す（日付が繰り上がるケース）', () => {
    expect(toJstDate('2026-08-31T21:59:22Z')).toBe('2026-09-01');
  });

  it('日付が繰り上がらないケース', () => {
    expect(toJstDate('2026-09-02T09:12:19Z')).toBe('2026-09-02');
  });

  it('読めない値は例外', () => {
    expect(() => toJstDate('とても昔')).toThrow();
  });
});

describe('addDays', () => {
  it('14日後・28日後を返す', () => {
    expect(addDays('2026-09-12', 14)).toBe('2026-09-26');
    expect(addDays('2026-09-12', 28)).toBe('2026-10-10');
  });

  it('月をまたぐ', () => {
    expect(addDays('2026-09-25', 14)).toBe('2026-10-09');
  });
});

describe('selectCohortCrawlTargets', () => {
  it('deployedAt を対象に引き継ぐ', () => {
    const targets = selectCohortCrawlTargets(ledger(), SITE);
    expect(targets[0].deployedAt).toBe('2026-09-08T22:45:25Z');
  });

  it('deployedAt が無ければ null', () => {
    const targets = selectCohortCrawlTargets(
      { holds: [{ cohortId: 'c', arm: 'treatment', startedAt: '2026-09-09', lastCrawlAtApply: { s: '2026-09-01T00:00:00Z' } }] },
      SITE,
    );
    expect(targets[0].deployedAt).toBeNull();
  });

  it('lastCrawlAtApply を持つ行だけを対象にする', () => {
    const targets = selectCohortCrawlTargets(ledger(), SITE);
    expect(targets.map((t) => t.slug)).toEqual(['a-comparison', 'b-comparison']);
    expect(targets[0].url).toBe('https://www.kura-select.com/articles/a-comparison/');
    expect(targets[0].arm).toBe('treatment');
  });

  it('対照群や通常の凍結行は対象にしない', () => {
    const targets = selectCohortCrawlTargets(ledger(), SITE);
    expect(targets.some((t) => t.slug === 'c-comparison')).toBe(false);
    expect(targets.some((t) => t.slug === 'unrelated-comparison')).toBe(false);
  });

  it('台帳が空・壊れていても例外を投げない', () => {
    expect(selectCohortCrawlTargets({}, SITE)).toEqual([]);
    expect(selectCohortCrawlTargets(null, SITE)).toEqual([]);
    expect(selectCohortCrawlTargets({ holds: 'ではない' }, SITE)).toEqual([]);
  });

  it('文字列でない crawlAtApply は捨てる', () => {
    const broken = { holds: [{ cohortId: 'x', arm: 'treatment', startedAt: '2026-09-09', lastCrawlAtApply: { s: 123 } }] };
    expect(selectCohortCrawlTargets(broken, SITE)).toEqual([]);
  });
});

describe('isRecrawled', () => {
  it('適用日以降の新しいクロールなら true', () => {
    expect(isRecrawled(target(), '2026-09-12T01:00:00Z')).toBe(true);
  });

  it('適用時点と同じクロール時刻なら false', () => {
    expect(isRecrawled(target(), '2026-08-22T12:48:44Z')).toBe(false);
  });

  it('適用時点より古ければ false', () => {
    expect(isRecrawled(target(), '2026-08-01T00:00:00Z')).toBe(false);
  });

  it('適用日より前の新しいクロール（デプロイ前）は false', () => {
    expect(isRecrawled(target(), '2026-09-05T00:00:00Z')).toBe(false);
  });

  it('適用日の未明 UTC でも JST で適用日なら true', () => {
    // 2026-09-08T16:00:00Z = JST 2026-09-09 01:00
    expect(isRecrawled(target(), '2026-09-08T16:00:00Z')).toBe(true);
  });

  it('lastCrawlTime が無ければ false', () => {
    expect(isRecrawled(target(), null)).toBe(false);
  });

  it('startedAt が空なら新しさだけで判定する', () => {
    expect(isRecrawled(target({ startedAt: '' }), '2026-09-05T00:00:00Z')).toBe(true);
  });

  describe('deployedAt があるとき', () => {
    const withDeploy = target({ deployedAt: '2026-09-08T22:45:25Z' });

    it('デプロイ後のクロールなら true', () => {
      expect(isRecrawled(withDeploy, '2026-09-08T23:05:59Z')).toBe(true);
    });

    it('同じ JST 日でもデプロイ前のクロールは false', () => {
      // 2026-09-08T20:00:00Z = JST 2026-09-09 05:00（適用日だがデプロイ前）
      expect(isRecrawled(withDeploy, '2026-09-08T20:00:00Z')).toBe(false);
    });

    it('deployedAt が壊れていたら例外（黙って通さない）', () => {
      expect(() => isRecrawled(target({ deployedAt: 'きのう' }), '2026-09-10T00:00:00Z')).toThrow();
    });
  });
});

describe('evaluateCohortCrawl', () => {
  const targets = selectCohortCrawlTargets(ledger(), SITE);

  it('全本が再クロール済みなら起点と判定日を出す', () => {
    const inspections = new Map<string, InspectionResult>([
      ['a-comparison', { lastCrawlTime: '2026-09-10T00:00:00Z' }],
      ['b-comparison', { lastCrawlTime: '2026-09-12T00:00:00Z' }],
    ]);
    const [status] = evaluateCohortCrawl(targets, inspections);
    expect(status.allRecrawled).toBe(true);
    // 起点は最も遅い再クロール日
    expect(status.originDate).toBe('2026-09-12');
    expect(status.interimJudgementDate).toBe('2026-09-26');
    expect(status.finalJudgementDate).toBe('2026-10-10');
    expect(status.pendingSlugs).toEqual([]);
  });

  it('1本でも未クロールなら起点を出さない', () => {
    const inspections = new Map<string, InspectionResult>([
      ['a-comparison', { lastCrawlTime: '2026-09-10T00:00:00Z' }],
      ['b-comparison', { lastCrawlTime: '2026-09-02T09:12:19Z' }],
    ]);
    const [status] = evaluateCohortCrawl(targets, inspections);
    expect(status.allRecrawled).toBe(false);
    expect(status.originDate).toBeNull();
    expect(status.interimJudgementDate).toBeNull();
    expect(status.pendingSlugs).toEqual(['b-comparison']);
  });

  it('取得エラーは未クロール扱いにする（起点を先走らせない）', () => {
    const inspections = new Map<string, InspectionResult>([
      ['a-comparison', { lastCrawlTime: '2026-09-10T00:00:00Z' }],
      ['b-comparison', { error: 'quota exceeded' }],
    ]);
    const [status] = evaluateCohortCrawl(targets, inspections);
    expect(status.allRecrawled).toBe(false);
    expect(status.rows.find((r) => r.slug === 'b-comparison')?.error).toBe('quota exceeded');
  });

  it('未取得の slug も未クロール扱い', () => {
    const [status] = evaluateCohortCrawl(targets, new Map());
    expect(status.allRecrawled).toBe(false);
    expect(status.pendingSlugs).toEqual(['a-comparison', 'b-comparison']);
  });

  it('cohortId × arm でグループ化する', () => {
    const two = selectCohortCrawlTargets(
      {
        holds: [
          { cohortId: 'c1', arm: 'treatment', startedAt: '2026-09-09', lastCrawlAtApply: { x: '2026-09-01T00:00:00Z' } },
          { cohortId: 'c2', arm: 'treatment', startedAt: '2026-09-09', lastCrawlAtApply: { y: '2026-09-01T00:00:00Z' } },
        ],
      },
      SITE,
    );
    expect(evaluateCohortCrawl(two, new Map())).toHaveLength(2);
  });
});

describe('formatCohortCrawlSection', () => {
  it('対象が無いときはその旨を書く', () => {
    const text = formatCohortCrawlSection([]).join('\n');
    expect(text).toContain('再クロール確認の対象はない');
  });

  it('起点未確定なら判定しないよう警告する', () => {
    const targets = selectCohortCrawlTargets(ledger(), SITE);
    const statuses = evaluateCohortCrawl(targets, new Map());
    const text = formatCohortCrawlSection(statuses).join('\n');
    expect(text).toContain('起点は未確定');
    expect(text).toContain('判定しないこと');
    expect(text).not.toContain('後窓の起点 = 2026');
  });

  it('起点が確定したら日付と次の作業を書く', () => {
    const targets = selectCohortCrawlTargets(ledger(), SITE);
    const statuses = evaluateCohortCrawl(
      targets,
      new Map<string, InspectionResult>([
        ['a-comparison', { lastCrawlTime: '2026-09-10T00:00:00Z' }],
        ['b-comparison', { lastCrawlTime: '2026-09-12T00:00:00Z' }],
      ]),
    );
    const text = formatCohortCrawlSection(statuses).join('\n');
    expect(text).toContain('後窓の起点 = 2026-09-12');
    expect(text).toContain('2026-09-26');
    expect(text).toContain('2026-10-10');
    expect(text).toContain('releaseDate');
  });
});
