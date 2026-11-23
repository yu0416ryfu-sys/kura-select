import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  capacityInputPath,
  additionReportScope,
  additionReportPaths,
} from '../scripts/lib/report-paths';

describe('capacityInputPath', () => {
  it('直下の ai-capacity-input-<日付>.jsonl だけを返す', () => {
    const p = capacityInputPath('/r', '2026-11-24');
    expect(p).toBe(join('/r', 'ai-capacity-input-2026-11-24.jsonl'));
    expect(p).not.toContain('toAI');
  });

  it('today が YYYY-MM-DD でなければ例外', () => {
    expect(() => capacityInputPath('/r', '2026/11/24')).toThrow();
    expect(() => capacityInputPath('/r', '')).toThrow();
  });
});

describe('additionReportScope', () => {
  it('指定なしは all（順1）', () => {
    expect(additionReportScope(null)).toBe('all');
    expect(additionReportScope(undefined)).toBe('all');
    expect(additionReportScope('')).toBe('all');
    expect(additionReportScope('  ')).toBe('all');
  });

  it('記事ファイル1本は .md を除いた名前（順4）', () => {
    expect(additionReportScope('baby-food-comparison.md')).toBe('baby-food-comparison');
  });

  it('同じ記事は書き方が違っても同じ名前（順4）', () => {
    for (const v of [
      'baby-food-comparison',
      'src/content/articles/baby-food-comparison.md',
      'src\\content\\articles\\baby-food-comparison.md',
      'Baby-Food-Comparison.md',
    ]) {
      expect(additionReportScope(v)).toBe('baby-food-comparison');
    }
  });

  it('reviews/ 付きは basename を取る', () => {
    expect(additionReportScope('reviews/foo-review.md')).toBe('foo-review');
  });

  it('ワイルドカードは filter-（順3）', () => {
    expect(additionReportScope('diaper*')).toBe('filter-diaper');
    expect(additionReportScope('diaper-?ape.md')).toBe('filter-diaper-_ape_md');
  });

  it('正規表現は / を含んでも filter-（順2）', () => {
    const scope = additionReportScope('/^diaper-(newborn|tape)/');
    expect(scope).toBe('filter-diaper-_newborn_tape');
    expect(scope).not.toMatch(/[/\\:*?"<>|]/);
    expect(additionReportScope('/^baby-food/i')).toBe('filter-baby-food_i');
  });

  it('置き換えて空になれば filter-x', () => {
    expect(additionReportScope('***')).toBe('filter-x');
  });

  it('長い正規表現は filter- の後ろを40字以内に切る', () => {
    const scope = additionReportScope(`/^(${'abcdefghij|'.repeat(10)}xyz)-comparison/`);
    expect(scope.startsWith('filter-')).toBe(true);
    expect(scope.slice('filter-'.length).length).toBeLessThanOrEqual(40);
    expect(scope).not.toMatch(/_$/);
  });
});

describe('additionReportPaths', () => {
  const d = join('/r', 'toAI', 'kura-article-add');

  it('同じ日・同じ記事なら同じパス（上書き）', () => {
    const a = additionReportPaths(d, '2026-11-24', 'a-comparison.md');
    const b = additionReportPaths(d, '2026-11-24', 'a-comparison.md');
    expect(a).toEqual(b);
    expect(a.candidatesPath).toBe(join(d, 'addition-candidates-2026-11-24-a-comparison.md'));
    expect(a.urlsPath).toBe(join(d, 'addition-urls-2026-11-24-a-comparison.md'));
  });

  it('別の記事ならパスが違う', () => {
    const a = additionReportPaths(d, '2026-11-24', 'a-comparison.md');
    const b = additionReportPaths(d, '2026-11-24', 'b-comparison.md');
    expect(a.candidatesPath).not.toBe(b.candidatesPath);
    expect(a.urlsPath).not.toBe(b.urlsPath);
  });

  it('today が YYYY-MM-DD でなければ例外', () => {
    expect(() => additionReportPaths(d, '2026/11/24', null)).toThrow();
    expect(() => additionReportPaths(d, '', null)).toThrow();
  });
});
