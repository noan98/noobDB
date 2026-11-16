import { describe, expect, it } from "vitest";
import ciYml from "../../.github/workflows/ci.yml?raw";

// nightly の実 webview E2E (`e2e/specs/*.e2e.ts`、e2e.yml) が `[data-testid="..."]` で掴む要素の
// testid が `src/` から消える / 改名されると、PR の CI はすべて緑のまま通り、翌朝 (JST 03:00)
// の nightly で初めて落ちる (#2386)。ここでは spec が参照する testid を機械的に抽出し、
// 本体コード (`src/`、テストを除く) に静的な `data-testid="..."` があるか、プレフィックスが
// 一致するテンプレートリテラル (`` data-testid={`connection-form-driver-${driver}`} ``) があることを要求する。
// 落ちたら、spec 側のセレクタを新しい testid に直す (testid を改名するなら spec も同じ PR で直す)。
//
// 読む `e2e/**` は ci.yml の paths-filter `frontend` に含まれている (crosslangGatingParity.test.ts が
// 「テストが読む src/ 外のファイルは frontend フィルタに含まれる」で検査する)。

const specs = import.meta.glob("../../e2e/specs/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const appSources = import.meta.glob(
  ["../**/*.ts", "../**/*.tsx", "!../**/__tests__/**", "!../**/*.test.ts", "!../**/*.test.tsx"],
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

/** spec 内の `[data-testid="..."]` セレクタから testid を集める (testid → 最初の spec)。 */
function specTestids(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [file, src] of Object.entries(specs)) {
    for (const m of src.matchAll(/\[data-testid=(["'])([^"']+)\1\]/g)) {
      if (!found.has(m[2])) found.set(m[2], file.replace("../../", ""));
    }
  }
  return found;
}

/** 本体コードの静的 testid (完全一致) とテンプレートリテラルのプレフィックスを集める。 */
function appTestids(): { exact: Set<string>; prefixes: Set<string> } {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  // EmptyState の `action: { testId: "x" }` (最終的に data-testid になる) も同様に拾う。
  // `data-testid="x"` / `data-testid={"x"}` / `"data-testid": "x"` / `data-testid={`x-${y}`}` を拾う。
  const re = /(?:data-testid|\btestId)"?\s*(?:=|:)\s*\{?\s*(["'`])((?:(?!\1).)*)\1/g;
  for (const src of Object.values(appSources)) {
    for (const m of src.matchAll(re)) {
      const value = m[2];
      const i = value.indexOf("${");
      if (i < 0) exact.add(value);
      else prefixes.add(value.slice(0, i));
    }
  }
  return { exact, prefixes };
}

const wanted = specTestids();
const { exact, prefixes } = appTestids();

describe("E2E spec の PR ゲート配線 (#2386)", () => {
  // glob で読むパスは crosslangGatingParity.test.ts の検査対象外なので、ここで直接固定する。
  it("ci.yml の paths-filter frontend に e2e/** があり、frontend ジョブが E2E spec を型チェックする", () => {
    const frontend = /^ {12}frontend:\s*\n((?: {14}.*\n|\s*\n)+)/m.exec(ciYml)?.[1] ?? "";
    expect(frontend).toContain("- 'e2e/**'");
    expect(ciYml).toContain("pnpm exec tsc -p e2e/tsconfig.e2e.json --noEmit");
  });
});

describe("E2E spec が参照する data-testid は src/ に存在する (#2386)", () => {
  it("検出ロジックが機能している (退行防止)", () => {
    expect(Object.keys(specs).length).toBeGreaterThan(0);
    expect(wanted.size).toBeGreaterThan(0);
    // 静的 testid とテンプレートリテラルの両方を拾えていること。
    expect(exact.has("connection-form-save")).toBe(true);
    expect(prefixes.has("connection-form-driver-")).toBe(true);
  });

  it.each([...wanted.entries()].sort())("%s (参照元: %s) が src/ にある", (testid, spec) => {
    const ok = exact.has(testid) || [...prefixes].some((p) => p !== "" && testid.startsWith(p));
    expect(
      ok,
      `${spec} が [data-testid="${testid}"] を参照しますが、src/ に該当する data-testid がありません。` +
        "testid を改名 / 削除したなら E2E spec のセレクタも同じ PR で直してください (nightly の E2E が落ちます)",
    ).toBe(true);
  });
});
