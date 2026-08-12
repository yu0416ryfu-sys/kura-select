import { defineConfig, defaultExclude } from "vitest/config";

// `.claude/worktrees/` には過去セッションの git worktree（リポジトリの複製）が残ることがあり、
// 既定の exclude では拾われるため、同じテストが二重に走って古いコピー側で失敗する。
// テスト対象は作業ツリー直下だけに限定する。
export default defineConfig({
  test: {
    exclude: [...defaultExclude, ".claude/**"],
  },
});
