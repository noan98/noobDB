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

// ファイルのパス (src/ 起点) → ソース。glob は `../**` でも同ディレクトリ分は `./` 始まりで返るため正規化する。
const testSources = new Map<string, string>();
for (const [p, src] of Object.entries(sources)) {
  testSources.set(p.startsWith("./") ? `src/__tests__/${p.slice(2)}` : `src/${p.slice(3)}`, src);
}

const SELF = "src/__tests__/crosslangGatingParity.test.ts";

// コメントを除いた文字列リテラルに `src-tauri/` を含むテストを「Rust を読む」とみなす
// (`?raw` import / `import.meta.glob`(型引数付き・配列の 2 番目以降も) / 動的 import /
// readFileSync など読み方を問わない)。`./` `../` `/` 始まりのパスのみ対象で、コメントや it 名の言及は対象外。
const READS_RUST = /["'`][./][^"'`\n]*src-tauri\/[^"'`\n]*["'`]/;

function stripComments(src: string): string {
  // glob 文字列 (`**/*.rs`) 中の `/*` を誤って拾わないよう、コメント開始は行頭の空白の直後か
  // 空白の後ろに限る。
  return src.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|\s)\/\/.*$/gm, "$1");
}

// 前提: ステップが `run: >-` の折り畳み複数行で、`pnpm vitest run` の次行以降に
// フィルタを 1 行 1 個で並べている。単一行 `run: pnpm vitest run a b` には対応しない。
function crosslangFilters(): string[] {
  const lines = ciYml.split("\n");
  const start = lines.findIndex((l) => l.includes("name: Cross-language parity/golden tests (Vitest)"));
  expect(
    start,
    "ci.yml に crosslang のテスト実行ステップが見つかりません (`run: >-` の複数行形式でフィルタを 1 行ずつ並べる前提。形式を変えたらこのパーサも直すこと)",
  ).toBeGreaterThanOrEqual(0);
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
  .filter(([p, src]) => p !== SELF && READS_RUST.test(stripComments(src)))
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
