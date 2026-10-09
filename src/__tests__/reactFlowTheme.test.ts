import xyStyle from "@xyflow/react/dist/style.css?raw";
import { describe, expect, it } from "vitest";

import css from "../App.css?raw";
import erDiagramView from "../components/ERDiagramView.tsx?raw";
import explainGraphView from "../components/ExplainGraphView.tsx?raw";

// React Flow 既定クロムのテーマ統合 (#1361): style.css の `--xy-*` を App.css が
// 既存トークンへ向けていることと、2 つの node-link 図が colorMode を渡していることを固定する。
const SOURCES: Record<string, string> = {
  "components/ERDiagramView.tsx": erDiagramView,
  "components/ExplainGraphView.tsx": explainGraphView,
};

describe("React Flow クロムのテーマ統合", () => {
  const block = css.slice(css.indexOf(".react-flow {"));

  it("上書きする --xy-* 変数は @xyflow/react の style.css に実在する", () => {
    const names = [...block.matchAll(/^\s+(--xy-[a-z-]+):/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(8);
    for (const n of names) expect(xyStyle, n).toContain(`${n},`);
  });

  it("色リテラルを書かずトークンへ橋渡しする", () => {
    const decls = [...block.matchAll(/^\s+--xy-[a-z-]+:\s*(.+);/gm)].map((m) => m[1]);
    for (const d of decls) expect(d).toMatch(/var\(--/);
  });

  it.each(["components/ERDiagramView.tsx", "components/ExplainGraphView.tsx"])("%s は colorMode を渡す", (f) => {
    expect(SOURCES[f]).toMatch(/colorMode=\{isDark \? "dark" : "light"\}/);
  });
});
