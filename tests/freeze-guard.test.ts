import { describe, it, expect } from "vitest";
import path from "path";
import {
  articleSlugCandidates,
  decideFreezeGuard,
  decideFreezeGuardCommand,
} from "../scripts/lib/freeze-guard";
import type { HoldsLookup } from "../scripts/lib/measurement-holds";

// 実在しないプロジェクトルート（パスの正規化だけを見る）
const PROJECT = path.resolve("/tmp/kura-project");
const article = (rel: string) => path.join(PROJECT, "src/content/articles", rel);

function makeHolds(opts: {
  frozen?: Record<string, string | null>;
  control?: string[];
  available?: boolean;
} = {}): HoldsLookup {
  const frozen = opts.frozen ?? {};
  const releaseDateBySlug = new Map<string, string>();
  for (const [slug, date] of Object.entries(frozen)) if (date) releaseDateBySlug.set(slug, date);
  return {
    frozenSlugs: new Set([...Object.keys(frozen), ...(opts.control ?? [])]),
    releaseDateBySlug,
    controlSlugs: new Set(opts.control ?? []),
    available: opts.available ?? true,
  };
}

const HOLDS = makeHolds({
  frozen: {
    "hand-soap-comparison": "2026-10-09",
    "open-ended-comparison": null,
    "kitchen-paper-comparison": "2026-10-09",
    "dish-detergent-comparison": "2026-10-22",
    foo: "2026-10-01",
  },
  control: ["kitchen-paper-comparison"],
});

describe("decideFreezeGuard（Edit / Write）", () => {
  it("F1: 記事でないファイルは素通り", () => {
    expect(decideFreezeGuard(path.join(PROJECT, "src/components/Foo.astro"), HOLDS, PROJECT)).toBeNull();
  });

  it("F2: 凍結外の記事は素通り", () => {
    expect(decideFreezeGuard(article("acne-patch-comparison.md"), HOLDS, PROJECT)).toBeNull();
  });

  it("F3: 凍結中（施策群）は ask、理由に slug と releaseDate", () => {
    const d = decideFreezeGuard(article("hand-soap-comparison.md"), HOLDS, PROJECT);
    expect(d?.decision).toBe("ask");
    expect(d?.reason).toContain("hand-soap-comparison");
    expect(d?.reason).toContain("2026-10-09");
  });

  it("F4: 期限なし凍結は ask、理由に「期限なし」", () => {
    const d = decideFreezeGuard(article("open-ended-comparison.md"), HOLDS, PROJECT);
    expect(d?.decision).toBe("ask");
    expect(d?.reason).toContain("期限なし");
  });

  it("F5: 対照群は deny", () => {
    const d = decideFreezeGuard(article("kitchen-paper-comparison.md"), HOLDS, PROJECT);
    expect(d?.decision).toBe("deny");
    expect(d?.reason).toContain("kitchen-paper-comparison");
    expect(d?.reason).toContain("2026-10-09");
  });

  it("F6: 施策群と対照群の両方に入る slug は deny", () => {
    const holds = makeHolds({ frozen: { both: "2026-10-09" }, control: ["both"] });
    expect(decideFreezeGuard(article("both.md"), holds, PROJECT)?.decision).toBe("deny");
  });

  it("F7: 台帳を読めない＋記事パスは ask", () => {
    const d = decideFreezeGuard(article("hand-soap-comparison.md"), makeHolds({ available: false }), PROJECT);
    expect(d?.decision).toBe("ask");
    expect(d?.reason).toContain("project_measurement_holds");
  });

  it("F8: 台帳を読めない＋記事でないパスは素通り", () => {
    expect(decideFreezeGuard(path.join(PROJECT, "src/lib/site.ts"), makeHolds({ available: false }), PROJECT)).toBeNull();
  });

  it("F9: .md.bak は対象外", () => {
    expect(decideFreezeGuard(article("hand-soap-comparison.md.bak"), HOLDS, PROJECT)).toBeNull();
  });

  it("F10: reviews/foo.md は basename の foo で照合する", () => {
    expect(articleSlugCandidates(article("reviews/foo.md"), PROJECT)).toEqual(["reviews/foo", "foo"]);
    expect(decideFreezeGuard(article("reviews/foo.md"), HOLDS, PROJECT)?.decision).toBe("ask");
  });

  it("F11: 相対パスでも絶対パスと同じ結果", () => {
    const rel = decideFreezeGuard("src/content/articles/hand-soap-comparison.md", HOLDS, PROJECT);
    const abs = decideFreezeGuard(article("hand-soap-comparison.md"), HOLDS, PROJECT);
    expect(rel).toEqual(abs);
    expect(rel?.decision).toBe("ask");
  });

  it.runIf(process.platform === "win32")("F12: バックスラッシュ・大文字小文字違いでも候補は小文字で照合する", () => {
    const upper = PROJECT.replace(/\//g, "\\").toUpperCase() + "\\src\\content\\articles\\Hand-Soap-Comparison.md";
    expect(articleSlugCandidates(upper, PROJECT)).toEqual(["hand-soap-comparison"]);
    expect(decideFreezeGuard(upper, HOLDS, PROJECT)?.decision).toBe("ask");
  });

  it("F13: filePath が undefined / 空文字なら素通り", () => {
    expect(decideFreezeGuard(undefined, HOLDS, PROJECT)).toBeNull();
    expect(decideFreezeGuard("", HOLDS, PROJECT)).toBeNull();
  });

  it("F14: 接頭辞だけ一致するディレクトリは対象外", () => {
    expect(decideFreezeGuard(path.join(PROJECT, "src/content/articles-old/foo.md"), HOLDS, PROJECT)).toBeNull();
  });
});

describe("decideFreezeGuardCommand（Bash / PowerShell）", () => {
  it("FB1: 施策群の記事への sed -i は ask、理由に slug と releaseDate", () => {
    const d = decideFreezeGuardCommand("sed -i 's/a/b/' src/content/articles/hand-soap-comparison.md", HOLDS);
    expect(d?.decision).toBe("ask");
    expect(d?.reason).toContain("hand-soap-comparison");
    expect(d?.reason).toContain("2026-10-09");
  });

  it("FB2: 対照群でも deny ではなく ask、理由に「対照群」", () => {
    const d = decideFreezeGuardCommand("sed -i 's/a/b/' src/content/articles/kitchen-paper-comparison.md", HOLDS);
    expect(d?.decision).toBe("ask");
    expect(d?.reason).toContain("対照群");
  });

  it("FB3: update-products を含むコマンドは素通り", () => {
    expect(decideFreezeGuardCommand("pnpm update-products -- --file=hand-soap-comparison.md", HOLDS)).toBeNull();
  });

  it("FB4: 凍結外の記事だけなら素通り", () => {
    expect(decideFreezeGuardCommand("cat src/content/articles/acne-patch-comparison.md", HOLDS)).toBeNull();
  });

  it("FB5: 前方の境界（dishwasher- は dish- に誤一致しない）", () => {
    expect(decideFreezeGuardCommand("sed -i x src/content/articles/dishwasher-detergent-comparison.md", HOLDS)).toBeNull();
  });

  it("FB6: 凍結中の2本を含めば理由に2本とも", () => {
    const d = decideFreezeGuardCommand("sed -i x hand-soap-comparison.md dish-detergent-comparison.md", HOLDS);
    expect(d?.decision).toBe("ask");
    expect(d?.reason).toContain("hand-soap-comparison");
    expect(d?.reason).toContain("dish-detergent-comparison");
  });

  it("FB7: 台帳を読めなければ素通り", () => {
    expect(decideFreezeGuardCommand("sed -i x hand-soap-comparison.md", makeHolds({ available: false }))).toBeNull();
  });

  it("FB8: command が undefined / 空文字なら素通り", () => {
    expect(decideFreezeGuardCommand(undefined, HOLDS)).toBeNull();
    expect(decideFreezeGuardCommand("", HOLDS)).toBeNull();
  });

  it("FB9: 拡張子なしの slug だけなら素通り", () => {
    expect(decideFreezeGuardCommand("git log -- hand-soap-comparison", HOLDS)).toBeNull();
  });

  it("FB10: PowerShell のバックスラッシュ区切りでも ask", () => {
    const d = decideFreezeGuardCommand(
      'Set-Content -Path "src\\content\\articles\\hand-soap-comparison.md" -Value x',
      HOLDS,
    );
    expect(d?.decision).toBe("ask");
  });
});
