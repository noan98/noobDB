import { describe, expect, it } from "vitest";
import {
  reachableModules,
  resolveSpecifier,
  runtimeImports,
  toSrcRelative,
} from "./moduleGraph";

// `moduleGraph.ts` (#1421) のリグレッションテスト。実ソースではなく合成したソース集合で、
// 「UI の入口を外した機能一式」が推移的デッドコードとして検出されることを固定する。

/** UI の入口 (App からの import) が残っている状態のアプリ。 */
const withEntry = {
  "main.tsx": `import App from "./App";\nimport "./App.css";\nrender(<App />);`,
  "App.tsx": `import { FeatureView } from "./components/FeatureView";
export default function App() { return <FeatureView />; }`,
  "components/FeatureView.tsx": `import { api } from "../api/tauri";
import { formatFeature } from "./featureHelpers";
export function FeatureView() { void api.runFeature(); return formatFeature(); }`,
  "components/featureHelpers.ts": `import { FeatureView } from "./FeatureView";
import { api } from "../api/tauri";
export const formatFeature = () => { void api.featureStatus(); return String(FeatureView); };`,
  "api/tauri.ts": "export const api = {};",
  // 機能のテストは入口が外れても残りがち。knip はこれを「使われている」根拠に数える。
  "__tests__/featureView.test.tsx": `import { FeatureView } from "../components/FeatureView";
it("renders", () => FeatureView());`,
};

/** App から FeatureView の import と描画だけを外した状態 (機能一式は残っている)。 */
const entryRemoved = {
  ...withEntry,
  "App.tsx": "export default function App() { return null; }",
};

const isConsumer = (p: string) => !p.startsWith("api/") && !p.startsWith("__tests__/");
const apiRefRe = (name: string) => new RegExp(`\\bapi\\s*\\.\\s*${name}\\b`);

/** 旧判定 (#907): `src/` のどこかに `api.<name>` の文字列があれば到達可能。 */
function textuallyReferenced(sources: Record<string, string>, name: string) {
  return Object.entries(sources).some(
    ([p, src]) => isConsumer(p) && apiRefRe(name).test(src),
  );
}

/** 新判定 (#1421): main.tsx から到達するモジュール内の参照だけを数える。 */
function graphReferenced(sources: Record<string, string>, name: string) {
  const reachable = reachableModules(["main.tsx"], sources);
  return Object.entries(sources).some(
    ([p, src]) => isConsumer(p) && reachable.has(p) && apiRefRe(name).test(src),
  );
}

describe("moduleGraph: 推移的デッドコードの検出 (#1421)", () => {
  it("入口が残っていれば機能のモジュールと api 参照は到達可能", () => {
    const reachable = reachableModules(["main.tsx"], withEntry);
    expect(reachable.has("components/FeatureView.tsx")).toBe(true);
    expect(reachable.has("components/featureHelpers.ts")).toBe(true);
    expect(graphReferenced(withEntry, "runFeature")).toBe(true);
    expect(graphReferenced(withEntry, "featureStatus")).toBe(true);
  });

  it("入口を外すと、相互参照とテストが残っていても機能一式が到達不能になる", () => {
    const reachable = reachableModules(["main.tsx"], entryRemoved);
    expect(reachable.has("components/FeatureView.tsx")).toBe(false);
    expect(reachable.has("components/featureHelpers.ts")).toBe(false);
    // 旧判定は文字列が残っているので「到達可能」と誤判定していた。
    expect(textuallyReferenced(entryRemoved, "runFeature")).toBe(true);
    expect(textuallyReferenced(entryRemoved, "featureStatus")).toBe(true);
    // 新判定は到達不能として検出する。
    expect(graphReferenced(entryRemoved, "runFeature")).toBe(false);
    expect(graphReferenced(entryRemoved, "featureStatus")).toBe(false);
  });

  it("型だけの import はたどらず、値の import・re-export・動的 import・Worker URL はたどる", () => {
    const sources = {
      "main.tsx": `import type { A } from "./typeOnly";
import { type B } from "./inlineTypeOnly";
import { type C, d } from "./mixed";
export * from "./reexported";
export type { E } from "./typeReexport";
const Lazy = lazy(() => import("./lazyView"));
const w = new Worker(new URL("./x.worker.ts", import.meta.url), { type: "module" });
// import { z } from "./commentedOut";
const s = "import y from './inString'";`,
      "typeOnly.ts": "",
      "inlineTypeOnly.ts": "",
      "mixed.ts": "",
      "reexported.ts": "",
      "typeReexport.ts": "",
      "lazyView.tsx": "",
      "x.worker.ts": "",
      "commentedOut.ts": "",
      "inString.ts": "",
    };
    const reachable = reachableModules(["main.tsx"], sources);
    expect([...reachable].sort()).toEqual(
      ["lazyView.tsx", "main.tsx", "mixed.ts", "reexported.ts", "x.worker.ts"].sort(),
    );
  });

  it("相対指定を拡張子と index で解決し、パッケージや CSS は無視する", () => {
    const sources = {
      "components/a.ts": "",
      "components/grid/index.tsx": "",
      "util.tsx": "",
    };
    expect(resolveSpecifier("App.tsx", "./components/a", sources)).toBe("components/a.ts");
    expect(resolveSpecifier("components/b.ts", "./grid", sources)).toBe(
      "components/grid/index.tsx",
    );
    expect(resolveSpecifier("components/b.ts", "../util", sources)).toBe("util.tsx");
    expect(resolveSpecifier("components/b.ts", "./a.ts?raw", sources)).toBe(
      "components/a.ts",
    );
    expect(resolveSpecifier("App.tsx", "react", sources)).toBeNull();
    expect(resolveSpecifier("App.tsx", "./App.css", sources)).toBeNull();
  });

  it("import.meta.glob のキーを src/ からの相対へそろえる", () => {
    expect(toSrcRelative("../components/App.tsx")).toBe("components/App.tsx");
    expect(toSrcRelative("./moduleGraph.ts")).toBe("__tests__/moduleGraph.ts");
    expect(runtimeImports("x.ts", `import "./side";`)).toEqual(["./side"]);
  });
});
