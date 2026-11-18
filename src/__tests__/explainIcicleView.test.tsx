import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExplainIcicleView } from "../components/ExplainIcicleView";
import { parsePostgresPlan, type PlanNode } from "../components/explainPlan";
import source from "../components/ExplainIcicleView.tsx?raw";

vi.mock("../components/ImageExportButton", () => ({
  ImageExportButton: () => <button type="button">export</button>,
}));

const root = parsePostgresPlan(
  JSON.stringify([
    {
      Plan: {
        "Node Type": "Hash Join",
        "Actual Rows": 1,
        "Actual Loops": 1,
        "Actual Total Time": 100,
        Plans: [
          { "Node Type": "Seq Scan", "Actual Rows": 1, "Actual Loops": 1, "Actual Total Time": 70 },
          { "Node Type": "Index Scan", "Actual Rows": 1, "Actual Loops": 1, "Actual Total Time": 5 },
        ],
      },
    },
  ]),
).root as PlanNode;

describe("ExplainIcicleView", () => {
  it("クリックで選択を通知し、ズームしてパンくずで戻れる", () => {
    const onSelect = vi.fn();
    const id = root.children[0].id;
    function Harness() {
      const [sel, setSel] = useState(root.id);
      return (
        <ExplainIcicleView
          root={root}
          selectedId={sel}
          onSelect={(x) => {
            onSelect(x);
            setSel(x);
          }}
        />
      );
    }
    renderWithProviders(<Harness />);
    fireEvent.click(document.querySelector(`[data-icicle-id="${CSS.escape(id)}"]`) as Element);
    expect(onSelect).toHaveBeenCalledWith(id);
    // ズーム後は部分木だけが描かれる
    expect(document.querySelectorAll("[data-icicle-id]")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: root.label })[0]);
    expect(document.querySelectorAll("[data-icicle-id]")).toHaveLength(3);
  });

  it("ホットスポットのバッジが自己時間で出る", () => {
    renderWithProviders(<ExplainIcicleView root={root} selectedId={root.id} onSelect={() => {}} />);
    expect(screen.getAllByRole("button").some((b) => /70/.test(b.textContent ?? ""))).toBe(true);
  });

  it("色リテラルを書かず colorScale を使う", () => {
    expect(source).toContain("SEQUENTIAL_RAMPS");
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});
