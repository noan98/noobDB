// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderCompletionKindIcon } from "../components/completionIcon";

describe("renderCompletionKindIcon", () => {
  it("種別ごとにアイコン付きの span を返し、描画のたびに別ノードになる", () => {
    for (const type of ["type", "property", "keyword", "function"]) {
      const el = renderCompletionKindIcon({ type: type === "type" ? "table" : type }) as HTMLElement;
      expect(el.className).toContain("cm-completionKindIcon-");
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
