// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderCompletionKindIcon } from "../components/completionIcon";

describe("renderCompletionKindIcon", () => {
  it("種別ごとにアイコン付きの span を返し、描画のたびに別ノードになる", () => {
    const expected: Record<string, string> = {
      table: "table",
      property: "column",
      keyword: "keyword",
      type: "keyword",
      function: "function",
    };
    for (const [type, kind] of Object.entries(expected)) {
      const el = renderCompletionKindIcon({ type }) as HTMLElement;
      expect(el.className).toContain(`cm-completionKindIcon-${kind}`);
      expect(el.querySelector("svg")).not.toBeNull();
    }
    const a = renderCompletionKindIcon({ type: "table" });
    const b = renderCompletionKindIcon({ type: "table" });
    expect(a).not.toBe(b);
  });
  it("未知の種別は同幅の空 span", () => {
    const el = renderCompletionKindIcon({ type: "constant" }) as HTMLElement;
    expect(el.className).toBe("cm-completionKindIcon");
    expect(el.childNodes).toHaveLength(0);
  });
});
