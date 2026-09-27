#!/usr/bin/env node
// 測定凍結ガード（Claude Code の PreToolUse hook）。
//
// 入力: { tool_name, tool_input: { file_path | command, ... }, cwd, ... }（stdin の JSON）
// 出力（ask/deny のときだけ）:
// { "hookSpecificOutput": { "hookEventName": "PreToolUse",
//   "permissionDecision": "ask" | "deny", "permissionDecisionReason": "..." } }
//
// 判定ロジックは scripts/lib/freeze-guard.ts、台帳の読み取りは scripts/lib/measurement-holds.ts。
// 詳細: docs/IMPLEMENTATION_PLAN_FREEZE_GUARD_HOOK_2026-09-27.md
import path from 'path';
import { articleSlugCandidates, decideFreezeGuard, decideFreezeGuardCommand } from '../lib/freeze-guard.ts';
import { loadHolds } from '../lib/measurement-holds.ts';

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function emit(decision) {
  if (!decision) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.decision,
      permissionDecisionReason: `[freeze-guard] ${decision.reason}`,
    },
  }));
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch {
  // 記事パスか判定できないので、全編集を止めないよう何も出さない
  process.exit(0);
}

const toolName = input?.tool_name;
const toolInput = input?.tool_input ?? {};
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? process.cwd();

try {
  const holds = loadHolds(path.join(projectDir, 'data/measurement-holds.json'));
  if (COMMAND_TOOLS.has(toolName)) {
    emit(decideFreezeGuardCommand(toolInput.command, holds));
  } else {
    emit(decideFreezeGuard(toolInput.file_path, holds, projectDir));
  }
} catch (error) {
  // Bash / PowerShell は全コマンドを止めない（B3 と同じ）。記事パスへの編集だけ fail-closed で ask
  const filePath = toolInput.file_path;
  let isArticle = false;
  try {
    isArticle = !COMMAND_TOOLS.has(toolName)
      && typeof filePath === 'string' && filePath !== ''
      && articleSlugCandidates(filePath, projectDir) !== null;
  } catch {
    isArticle = false;
  }
  if (isArticle) {
    emit({
      decision: 'ask',
      reason: `凍結判定中に例外が出た（${error instanceof Error ? error.message : error}）。メモリ project_measurement_holds を確認してから承認すること`,
    });
  }
}
// process.exit() だとパイプへの stdout 書き込みが途中で切れることがあるので、自然終了させる
process.exitCode = 0;
