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

// ---- 逆方向: Rust のテストが src-tauri 外のファイルを読む場合 (#2362) ----
//
// `include_str!` / `include_bytes!` / `concat!(env!("CARGO_MANIFEST_DIR"), "/../...")` が指す
// src-tauri 外のパスは、ci.yml の paths-filter `crosslang` に一致していなければならない。
// 外れていると、そのファイルだけを変えるフロント単独の PR (rust==false) で Rust のテストが
// 走らず、壊れた状態が main に入って無関係な次の Rust PR を赤くする。

const rustSources = import.meta.glob(["../../src-tauri/src/**/*.rs", "../../src-tauri/tests/**/*.rs"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function stripRustComments(src: string): string {
  return src.replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Rust ソースが読む、リポジトリ直下起点の src-tauri 外のパスを列挙する。 */
function externalRustReads(file: string, src: string): string[] {
  const code = stripRustComments(src);
  const dir = file.slice(0, file.lastIndexOf("/"));
  const found: string[] = [];
  for (const m of code.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"/g)) {
    found.push(normalizePath(`${dir}/${m[1]}`));
  }
  for (const m of code.matchAll(/CARGO_MANIFEST_DIR"\)\s*,\s*"([^"]+)"/g)) {
    found.push(normalizePath(`src-tauri/${m[1]}`));
  }
  return found.filter((p) => !p.startsWith("src-tauri/"));
}

function crosslangPatterns(): string[] {
  const lines = ciYml.split("\n");
  const start = lines.findIndex((l) => /^\s{12}crosslang:\s*$/.test(l));
  expect(start, "ci.yml の paths-filter に crosslang フィルタが見つかりません").toBeGreaterThanOrEqual(0);
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = /^- '([^']+)'$/.exec(t);
    if (!m) break;
    patterns.push(m[1]);
  }
  return patterns;
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`);
}

describe("Rust が読む src-tauri 外のファイルは crosslang フィルタに含まれる (#2362)", () => {
  const reads = new Map<string, string>(); // 読まれるパス → 最初の読み手
  for (const [p, src] of Object.entries(rustSources)) {
    const file = normalizePath(p.replace(/^\.\.\/\.\.\//, ""));
    for (const target of externalRustReads(file, src)) if (!reads.has(target)) reads.set(target, file);
  }
  const regexps = crosslangPatterns().map(globToRegExp);

  it("読み込みを検出できている (検出ロジックの退行防止)", () => {
    expect(regexps.length).toBeGreaterThan(0);
    expect(reads.has("src/components/CrossDriverVerify.tsx")).toBe(true);
    expect(reads.has("src/__tests__/fixtures/maskVectors.json")).toBe(true);
  });

  it.each([...reads.entries()].sort())("%s (読み手: %s) は crosslang に一致する", (target, reader) => {
    expect(
      regexps.some((r) => r.test(target)),
      `${reader} が src-tauri 外の ${target} を読みますが、ci.yml の paths-filter \`crosslang\` に一致せず、` +
        "そのファイルだけを変えるフロント単独の PR で Rust のテストが実行されません。crosslang にパスを足してください",
    ).toBe(true);
  });
});

// ---- フロントのテストが src/ 外のファイルを読む場合 / CI が実行するスクリプト (#2385) ----
//
// #2362 と同じ種類の配線漏れ。ci.yml の paths-filter は「どのファイルが変わったら
// どのジョブを動かすか」を列挙しているので、(1) フロントのテストが `?raw` / import で読む
// src/ 外のファイルは frontend (または workflow / docs) フィルタに、(2) `run:` が
// `bash scripts/...` で呼ぶスクリプトはいずれかのフィルタに含まれていなければならない。
// 外れていると、そのファイルだけを変える PR ですべてのフィルタが false になり、
// 関係するジョブが skip されたまま (必須チェックは skip でも満たされる) マージされる。

/** ci.yml の paths-filter (`filters: |` 配下の 12 スペースインデントのキー) を全部読む。 */
function allFilterPatterns(): Map<string, string[]> {
  const lines = ciYml.split("\n");
  const start = lines.findIndex((l) => /^\s+filters:\s*\|\s*$/.test(l));
  expect(start, "ci.yml に paths-filter の `filters: |` が見つかりません").toBeGreaterThanOrEqual(0);
  const result = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const key = /^\s{12}([\w-]+):\s*$/.exec(line);
    if (key) {
      current = [];
      result.set(key[1], current);
      continue;
    }
    const m = /^- '([^']+)'$/.exec(t);
    if (!m || current === null) break;
    current.push(m[1]);
  }
  return result;
}

const filterGroups = allFilterPatterns();

function filterNamesMatching(path: string, names?: string[]): string[] {
  return [...filterGroups.entries()]
    .filter(([name]) => !names || names.includes(name))
    .filter(([, patterns]) => patterns.some((pat) => globToRegExp(pat).test(path)))
    .map(([name]) => name);
}

/** フロントのテスト / ソースが `?raw` や import で読む、src/ 外 (リポジトリ直下起点) のパス。 */
function externalFrontendReads(file: string, src: string): string[] {
  const dir = file.slice(0, file.lastIndexOf("/"));
  const found: string[] = [];
  for (const m of stripComments(src).matchAll(/["'`](\.{1,2}\/[^"'`\n]+)["'`]/g)) {
    const spec = m[1].replace(/\?.*$/, "");
    // glob (`*`) は対象を列挙できないので対象外。リテラルのパスだけ検査する。
    if (spec.includes("*")) continue;
    const resolved = normalizePath(`${dir}/${spec}`);
    if (!resolved.startsWith("src/") && !resolved.startsWith("src-tauri/")) found.push(resolved);
  }
  return found;
}

describe("フロントのテストが読む src/ 外のファイルは frontend フィルタに含まれる (#2385)", () => {
  const reads = new Map<string, string>(); // 読まれるパス → 最初の読み手
  for (const [file, src] of testSources) {
    for (const target of externalFrontendReads(file, src)) {
      // 実在しない相対パス (ただの文字列リテラル) は除外する。拡張子付きのファイルだけを見る。
      if (/\.[A-Za-z0-9]+$/.test(target) && !reads.has(target)) reads.set(target, file);
    }
  }

  it("読み込みを検出できている (検出ロジックの退行防止)", () => {
    expect(reads.has("public/brand-icon.svg")).toBe(true);
    expect(reads.has(".claude/skills/noobdb-ipc/references/command-list.md")).toBe(true);
  });

  // frontend ジョブを起こすのは frontend / workflow。docs は crosslang parity ジョブ (パリティ系の
  // テストだけを回す) を起こすので、パリティテストが読むドキュメントはそれでよい。
  it.each([...reads.entries()].sort())(
    "%s (読み手: %s) はフロントのテストを動かすフィルタに一致する",
    (target, reader) => {
      expect(
        filterNamesMatching(target, ["frontend", "workflow", "docs"]).length > 0,
        `${reader} が src/ 外の ${target} を読みますが、ci.yml の paths-filter \`frontend\` (または workflow / docs) に` +
          "一致せず、そのファイルだけを変える PR でフロントのテストが実行されません。frontend にパスを足してください",
      ).toBe(true);
    },
  );
});

describe("ci.yml の run: が呼ぶスクリプトはいずれかの paths-filter に含まれる (#2385)", () => {
  const scripts = [...new Set([...ciYml.matchAll(/\bbash\s+(scripts\/[\w./-]+)/g)].map((m) => m[1]))].sort();

  it("スクリプト呼び出しを検出できている (検出ロジックの退行防止)", () => {
    expect(scripts).toContain("scripts/ci-apt-refresh.sh");
    expect(scripts).toContain("scripts/ci-apt-ensure.sh");
  });

  it.each(scripts)("%s はいずれかのフィルタに一致する", (script) => {
    expect(
      filterNamesMatching(script).length > 0,
      `ci.yml が ${script} を実行しますが、どの paths-filter にも一致せず、そのスクリプトだけを変える PR ` +
        "ではすべてのフィルタが false になって一度も実行されません。ci-scripts などにパスを足してください",
    ).toBe(true);
  });

  // apt セットアップは frontend と全 Rust ジョブで走る。ci-scripts フィルタで起こすジョブ側にも
  // `ci-scripts` の OR が入っていること (フィルタだけ足して if: を忘れると実走しない)。
  it.each(["scripts/ci-apt-refresh.sh", "scripts/ci-apt-ensure.sh"])(
    "%s を実行するジョブの if: に ci-scripts が含まれる",
    (script) => {
      const jobs = ciYml.split(/^ {2}(?=[\w-]+:\s*$)/m).filter((b) => b.includes(`bash ${script}`));
      expect(jobs.length).toBeGreaterThan(0);
      for (const job of jobs) {
        const name = job.split("\n", 1)[0];
        const cond = /^ {4}if:.*$/m.exec(job)?.[0] ?? "";
        expect(cond, `${name} ジョブの if: に ci-scripts の OR がありません`).toContain(
          "needs.changes.outputs.ci-scripts",
        );
      }
    },
  );
});
