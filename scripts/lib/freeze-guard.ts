// 測定凍結ガード hook（scripts/hooks/freeze-guard.mjs）の判定ロジック。
//
// 凍結中の記事への編集を、CLAUDE.md §5.0.2 の文章ルールではなくハーネスで止めるための純関数。
// I/O は持たない（台帳の読み取りは loadHolds、stdin/stdout は hooks/freeze-guard.mjs が担う）。
// 詳細: docs/IMPLEMENTATION_PLAN_FREEZE_GUARD_HOOK_2026-09-27.md §3
import path from 'path';
import type { HoldsLookup } from './measurement-holds.ts';

export type FreezeGuardDecision = { decision: 'ask' | 'deny'; reason: string } | null;

const ARTICLE_EXTENSIONS = new Set(['.md', '.mdx']);

/** 記事ファイルのパスから slug の候補（glob id と basename）を返す。記事でなければ null */
export function articleSlugCandidates(filePath: string, projectDir: string): string[] | null {
  const resolved = path.resolve(projectDir, filePath);
  const articlesDir = path.resolve(projectDir, 'src/content/articles');
  // win32 の path.relative は大文字・小文字を区別せずに比較するので、パス側は小文字化しない
  const rel = path.relative(articlesDir, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const relPosix = rel.split(path.sep).join('/');
  // extname なので .md.bak は .bak になり除外される
  const ext = path.extname(relPosix);
  if (!ARTICLE_EXTENSIONS.has(ext.toLowerCase())) return null;

  const id = relPosix.slice(0, -ext.length);
  const basename = id.split('/').pop() ?? id;
  let candidates = [id, basename];
  // Windows では Foo.md と foo.md が同じファイル。台帳の slug は小文字の kebab-case
  if (process.platform === 'win32') candidates = candidates.map((c) => c.toLowerCase());
  return [...new Set(candidates)];
}

function releaseLabel(slug: string, holds: HoldsLookup): string {
  const releaseDate = holds.releaseDateBySlug.get(slug);
  return releaseDate ? `releaseDate ${releaseDate}（この日から編集可）` : '期限なし';
}

/** §3.1 の判定表（Edit / Write / MultiEdit） */
export function decideFreezeGuard(filePath: unknown, holds: HoldsLookup, projectDir: string): FreezeGuardDecision {
  if (typeof filePath !== 'string' || filePath === '') return null;           // #1
  const candidates = articleSlugCandidates(filePath, projectDir);
  if (!candidates) return null;                                                // #2・#3

  if (!holds.available) {                                                      // #4
    return {
      decision: 'ask',
      reason: '凍結台帳（data/measurement-holds.json）を読めない。メモリ project_measurement_holds を確認してから承認すること',
    };
  }

  const control = candidates.find((c) => holds.controlSlugs.has(c));
  if (control) {                                                               // #5（#6 より先）
    return {
      decision: 'deny',
      reason: `${control} はコホート対照群として凍結中（${releaseLabel(control, holds)}）。コホート対照群は区分 B も触らない（CLAUDE.md §5.0.3）`,
    };
  }

  const frozen = candidates.find((c) => holds.frozenSlugs.has(c));
  if (frozen) {                                                                // #6
    return {
      decision: 'ask',
      reason:
        `${frozen} は測定凍結中（${releaseLabel(frozen, holds)}）。` +
        '区分 A〜D のどれか判断し、B/C なら両台帳へ注記、D なら『2施策同時』の明示判断が要る（CLAUDE.md §5.0.3）',
    };
  }

  return null;                                                                 // #7
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** §3.2 の判定表（Bash / PowerShell）。読み取りと書き換えを区別できないので deny は返さない */
export function decideFreezeGuardCommand(command: unknown, holds: HoldsLookup): FreezeGuardDecision {
  if (typeof command !== 'string' || command === '') return null;             // B1
  if (command.includes('update-products')) return null;                        // B2（区分 A の自動更新）
  if (!holds.available) return null;                                           // B3

  const matched: string[] = [];
  for (const slug of holds.frozenSlugs) {
    // 直前が英数字・- でないこと（dish-detergent が dishwasher-detergent に誤一致しないように）
    const pattern = new RegExp(`(?<![a-z0-9-])${escapeRegExp(slug)}\\.mdx?`, 'i');
    if (pattern.test(command)) matched.push(slug);
  }
  if (matched.length === 0) return null;                                       // B5

  const details = matched.map((slug) => {
    const control = holds.controlSlugs.has(slug) ? '・対照群。区分 B も不可' : '';
    return `${slug}（${releaseLabel(slug, holds)}${control}）`;
  });
  return {                                                                     // B4
    decision: 'ask',
    reason:
      `測定凍結中の記事を含むコマンド: ${details.join(' / ')}。` +
      '読むだけのコマンドなら承認してよい。書き換えなら §5.0.3 の区分を判断してから進めること',
  };
}
