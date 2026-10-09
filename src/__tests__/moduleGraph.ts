// エントリからの実モジュールグラフ (#1421)。
//
// `apiReachabilityParity.test.ts` は以前、`src/` 配下のどこかに `api.<name>` の文字列が
// 1 つでもあれば「UI から到達可能」と数えていた。これだと、UI の入口 (App からの import)
// を外した機能でも、そのコンポーネント同士やテストが互いに import し合っている限り
// `api.<name>` の参照が残り、Rust コマンド + ラッパー + UI 一式が推移的に死蔵されたまま
// 全パリティ + knip を通過してしまう (knip はテストファイルもエントリに数えるため、
// テストからだけ import されるモジュールを「使われている」とみなす)。
//
// ここでは `src/main.tsx` から実際の import (静的 import・`export ... from`・`import()`) を
// たどり (`new URL("./x", import.meta.url)` の Worker も含む)、到達したモジュールの集合を返す。型だけの import (`import type` /
// `import { type X }` だけの文) は実行時に読み込まれないので辿らない。構文解析には
// Vite が公開している oxc パーサ (`parseSync`) を使う (TypeScript 7 はネイティブ版で
// JS API が無いため、`typescript` パッケージには依存しない)。

import { parseSync } from "vite";

/** モジュールのパス (`src/` からの相対、例: `components/App.tsx`) → ソース。 */
export type SourceMap = Record<string, string>;

const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** `a/b/../c` のような相対パスを正規化する (`src/` の外へは出ない前提)。 */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * import 指定子を `sources` のキーへ解決する。相対指定 (`./` / `../`) 以外
 * (npm パッケージ) と、`.css` などソース集合に無いものは `null`。
 */
export function resolveSpecifier(
  importer: string,
  specifier: string,
  sources: SourceMap,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const bare = specifier.replace(/[?#].*$/, "");
  const base = normalize(`${dirname(importer)}/${bare}`);
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (candidate in sources) return candidate;
  }
  return null;
}

/**
 * 1 モジュールが実行時に読み込む import 指定子を列挙する。
 * 型だけの import / re-export は含めない。
 */
export function runtimeImports(path: string, source: string): string[] {
  const { module } = parseSync(path, source);
  const out: string[] = [];
  for (const imp of module.staticImports) {
    // `import "./x"` (副作用 import) は entries が空。1 つでも値の import があれば実行時に読む。
    if (imp.entries.length === 0 || imp.entries.some((e) => !e.isType)) {
      out.push(imp.moduleRequest.value);
    }
  }
  for (const exp of module.staticExports) {
    for (const entry of exp.entries) {
      if (entry.moduleRequest && !entry.isType) out.push(entry.moduleRequest.value);
    }
  }
  for (const dyn of module.dynamicImports) {
    // `import("./x")` の引数。文字列リテラル以外 (変数) は辿れないので無視する。
    const arg = source.slice(dyn.moduleRequest.start, dyn.moduleRequest.end).trim();
    const m = /^(["'`])([^"'`]+)\1$/.exec(arg);
    if (m) out.push(m[2]);
  }
  // Web Worker などを `new URL("./x.worker.ts", import.meta.url)` で読み込む形。
  // Vite がこの形をアセットとしてバンドルするので、実行時に読み込まれるモジュールに数える。
  for (const m of source.matchAll(NEW_URL_RE)) out.push(m[2]);
  return out;
}

const NEW_URL_RE = /new\s+URL\(\s*(["'])(\.[^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;

/** `entries` から実行時 import をたどって到達できるモジュールの集合。 */
export function reachableModules(
  entries: readonly string[],
  sources: SourceMap,
): Set<string> {
  const seen = new Set<string>();
  const stack = entries.filter((e) => e in sources);
  while (stack.length > 0) {
    const path = stack.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const spec of runtimeImports(path, sources[path])) {
      const resolved = resolveSpecifier(path, spec, sources);
      if (resolved !== null && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

/**
 * `import.meta.glob("../**")` (`__tests__/` から見た相対) のキーを `src/` からの相対へ
 * そろえる。例: `../components/App.tsx` → `components/App.tsx`、
 * `./moduleGraph.ts` → `__tests__/moduleGraph.ts`。
 */
export function toSrcRelative(globKey: string): string {
  if (globKey.startsWith("../")) return normalize(globKey.slice(3));
  return normalize(`__tests__/${globKey}`);
}
