import { describe, expect, it } from "vitest";
import ciYml from "../../.github/workflows/ci.yml?raw";

// `crosslang parity` ジョブの実走対象を「命名規約」任せにせず、実際に src-tauri を
// 読むテストの集合と突き合わせて固定するメタテスト (#1760)。
//
// ci.yml の `crosslang parity` ジョブは Rust のみ変更の PR (frontend==false) で
// `pnpm vitest run <部分一致フィルタ...>` を走らせる。フィルタが `*Parity.test.ts` /
// `*Golden.test.ts` の命名規約 + 個別指定だけだと、規約外の名前で `?raw` / glob import
// により Rust ソースを読むテスト (awsIam → apiModuleLayout と続いた漏れ) が、Rust 単独 PR
// で一度も走らないまま green になる。ここでは「src-tauri を import するテスト」を機械的に
// 列挙し、すべてが crosslang ジョブのフィルタに一致することを要求する。
// 新しい横断テストを足して落ちたら、命名規約 (`*Parity.test.ts`) に合わせるか、ci.yml の
// `Cross-language parity/golden tests (Vitest)` ステップへフィルタを足すこと。

const sources = import.meta.glob(
  ["./**/*.test.ts", "./**/*.test.tsx", "../**/*.test.ts", "../**/*.test.tsx"],
  {
    eager: true,
    query: "?raw",
    import: "default",
  },
) as Record<string, string>;

// ファイルのパス (src/ 起点) → ソース。同一ファイルが ./ と ../ の両方から来るので正規化する。
const testSources = new Map<string, string>();
for (const [p, src] of Object.entries(sources)) {
  const rel = p.startsWith("./") ? `src/__tests__/${p.slice(2)}` : `src/${p.slice(3)}`;
  testSources.set(rel, src);
}

const SELF = "src/__tests__/crosslangGatingParity.test.ts";

// `from "…src-tauri/…"` か `import.meta.glob("…src-tauri/…"` / `glob([ "…src-tauri/…"` の形だけを
// 「Rust ソースを読む」とみなす (コメント中の言及は対象外)。
const READS_RUST = /(?:\bfrom\s+|import\.meta\.glob\(\s*\[?\s*)["'`][^"'`]*src-tauri\//;

function crosslangFilters(): string[] {
  const lines = ciYml.split("\n");
  const start = lines.findIndex((l) => l.includes("name: Cross-language parity/golden tests (Vitest)"));
  expect(start, "ci.yml に crosslang のテスト実行ステップが見つかりません").toBeGreaterThanOrEqual(0);
  const filters: string[] = [];
  let inRun = false;
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (!inRun) {
      if (t.startsWith("run:")) inRun = true;
      continue;
    }
    // 次のステップ / ジョブ (インデントが浅いキー) に達したら終了。
    if (t === "" || t.startsWith("#") || t.startsWith("- ") || /^[\w-]+:/.test(t)) break;
    filters.push(t);
  }
  // 最初の行は `pnpm vitest run` (`>-` の折り畳み後の先頭)。
  return filters.filter((f) => !f.startsWith("pnpm"));
}

const rustReaders = [...testSources.entries()]
  .filter(([p, src]) => p !== SELF && READS_RUST.test(src))
  .map(([p]) => p)
  .sort();
const filters = crosslangFilters();

describe("crosslang parity ジョブの実走対象 (#1760)", () => {
  it("フィルタと Rust を読むテストを検出できている", () => {
    expect(filters.length).toBeGreaterThan(0);
    expect(rustReaders.length).toBeGreaterThan(0);
    // 検出ロジックの退行 (正規表現が何にも一致しなくなる) を防ぐ既知の読み手。
    expect(rustReaders).toContain("src/__tests__/apiModuleLayout.test.ts");
    expect(rustReaders).toContain("src/__tests__/ipcCommandParity.test.ts");
  });

  it.each(rustReaders)("%s は crosslang parity のフィルタに一致する", (file) => {
    expect(
      filters.some((f) => file.includes(f)),
      `${file} は src-tauri を読む横断テストですが、ci.yml の crosslang parity ジョブのフィルタ` +
        `(${filters.join(" / ")}) に一致せず、Rust のみの PR で実行されません。` +
        "*Parity.test.ts に改名するか、ci.yml の該当ステップにフィルタを足してください",
    ).toBe(true);
  });

  it.each(filters.filter((f) => f.includes("/")))("個別指定 %s は実在するテストファイルを指す", (f) => {
    expect(testSources.has(f), `${f} が存在しません (リネーム・削除の取り残し)`).toBe(true);
  });
});
