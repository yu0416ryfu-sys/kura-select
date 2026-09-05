import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { loadHolds } from "../scripts/lib/measurement-holds";

const TODAY = "2026-09-05";
const dirs: string[] = [];

function writeHolds(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "holds-"));
  dirs.push(dir);
  const file = path.join(dir, "measurement-holds.json");
  writeFileSync(file, content, "utf-8");
  return file;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadHolds - 現行挙動の固定", () => {
  // H1
  it("releaseDate が today より後なら凍結中", () => {
    const file = writeHolds(JSON.stringify({ holds: [{ slug: "a", releaseDate: "2026-09-12" }] }));
    const holds = loadHolds(file, TODAY);
    expect(holds.frozenSlugs.has("a")).toBe(true);
    expect(holds.available).toBe(true);
  });

  // H2
  it("releaseDate === today なら凍結されない（その日から編集可）", () => {
    const file = writeHolds(JSON.stringify({ holds: [{ slug: "a", releaseDate: TODAY }] }));
    expect(loadHolds(file, TODAY).frozenSlugs.has("a")).toBe(false);
  });

  // H3
  it("releaseDate 欠落は期限なし凍結として frozenSlugs に入る", () => {
    const file = writeHolds(JSON.stringify({ holds: [{ slug: "a" }] }));
    expect(loadHolds(file, TODAY).frozenSlugs.has("a")).toBe(true);
  });

  // H4
  it("slugs（複数形）の全 slug が入る", () => {
    const file = writeHolds(JSON.stringify({ holds: [{ slugs: ["a", "b"], releaseDate: "2026-09-12" }] }));
    const holds = loadHolds(file, TODAY);
    expect([...holds.frozenSlugs].sort()).toEqual(["a", "b"]);
  });

  // H5
  it("ファイル不在なら available:false で例外を投げない", () => {
    const holds = loadHolds(path.join(tmpdir(), "no-such-holds-file.json"), TODAY);
    expect(holds.available).toBe(false);
    expect(holds.frozenSlugs.size).toBe(0);
    expect(holds.releaseDateBySlug.size).toBe(0);
  });

  // H6
  it("壊れた JSON なら available:false で例外を投げない", () => {
    const file = writeHolds("{ broken");
    const holds = loadHolds(file, TODAY);
    expect(holds.available).toBe(false);
    expect(holds.frozenSlugs.size).toBe(0);
  });

  it("トップレベル配列の台帳も読める", () => {
    const file = writeHolds(JSON.stringify([{ slug: "a", releaseDate: "2026-09-12" }]));
    expect(loadHolds(file, TODAY).frozenSlugs.has("a")).toBe(true);
  });
});

describe("loadHolds - releaseDateBySlug（新規）", () => {
  // H7
  it("単一行の releaseDate をそのまま返す", () => {
    const file = writeHolds(JSON.stringify({ holds: [{ slug: "a", releaseDate: "2026-09-12" }] }));
    expect(loadHolds(file, TODAY).releaseDateBySlug.get("a")).toBe("2026-09-12");
  });

  // H8
  it("同じ slug が複数行なら遅いほうを採る（順序に依らない）", () => {
    const asc = writeHolds(JSON.stringify({ holds: [
      { slug: "a", releaseDate: "2026-09-12" },
      { slug: "a", releaseDate: "2026-09-22" },
    ] }));
    expect(loadHolds(asc, TODAY).releaseDateBySlug.get("a")).toBe("2026-09-22");

    const desc = writeHolds(JSON.stringify({ holds: [
      { slug: "a", releaseDate: "2026-09-22" },
      { slug: "a", releaseDate: "2026-09-12" },
    ] }));
    expect(loadHolds(desc, TODAY).releaseDateBySlug.get("a")).toBe("2026-09-22");
  });

  // H9
  it("releaseDate 欠落の行は releaseDateBySlug に入らない", () => {
    const file = writeHolds(JSON.stringify({ holds: [{ slug: "a" }] }));
    const holds = loadHolds(file, TODAY);
    expect(holds.frozenSlugs.has("a")).toBe(true);
    expect(holds.releaseDateBySlug.has("a")).toBe(false);
  });

  // H10
  it("slugs 複数形の全 slug に同じ日付が入る", () => {
    const file = writeHolds(JSON.stringify({ holds: [{ slugs: ["a", "b"], releaseDate: "2026-09-12" }] }));
    const holds = loadHolds(file, TODAY);
    expect(holds.releaseDateBySlug.get("a")).toBe("2026-09-12");
    expect(holds.releaseDateBySlug.get("b")).toBe("2026-09-12");
  });

  // H11
  it("期限なし行と期限あり行が併存したら期限なしを優先する（順序に依らない）", () => {
    const openFirst = writeHolds(JSON.stringify({ holds: [
      { slug: "a" },
      { slug: "a", releaseDate: "2026-09-12" },
    ] }));
    expect(loadHolds(openFirst, TODAY).releaseDateBySlug.has("a")).toBe(false);

    const openLast = writeHolds(JSON.stringify({ holds: [
      { slug: "a", releaseDate: "2026-09-12" },
      { slug: "a" },
    ] }));
    const holds = loadHolds(openLast, TODAY);
    expect(holds.releaseDateBySlug.has("a")).toBe(false);
    expect(holds.frozenSlugs.has("a")).toBe(true);
  });

  // H12
  it("prohibitions は読まない", () => {
    const file = writeHolds(JSON.stringify({ prohibitions: [{ slug: "a", note: "商品追加禁止" }] }));
    const holds = loadHolds(file, TODAY);
    expect(holds.frozenSlugs.size).toBe(0);
    expect(holds.available).toBe(true);
  });
});
