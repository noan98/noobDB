import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";
import { useState } from "react";
import { Modal, ModalBody } from "../components/Modal";
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
    expect(
      screen.getByRole("button", { name: /Seq Scan: 自己 70 ms \(70%\)|Seq Scan: self 70 ms \(70%\)/ }),
    ).toBeTruthy();
  });

  it("色リテラルを書かず colorScale を使う", () => {
    expect(source).toContain("SEQUENTIAL_RAMPS");
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  const ids = () =>
    [...document.querySelectorAll("[data-icicle-id]")].map((e) => e.getAttribute("data-icicle-id"));
  const rectEl = (id: string) =>
    document.querySelector(`[data-icicle-id="${CSS.escape(id)}"]`) as SVGGElement;

  it("キーボード: 矢印で移動し、Enter でズーム、Esc で戻る (伝播しない)", () => {
    function Harness() {
      const [sel, setSel] = useState(root.id);
      return <ExplainIcicleView root={root} selectedId={sel} onSelect={setSel} />;
    }
    const outer = vi.fn();
    renderWithProviders(
      <div onKeyDown={outer}>
        <Harness />
      </div>,
    );
    const [scan, index] = root.children;
    rectEl(root.id).focus();
    fireEvent.keyDown(rectEl(root.id), { key: "ArrowDown" });
    expect(document.activeElement).toBe(rectEl(scan.id));
    fireEvent.keyDown(rectEl(scan.id), { key: "ArrowRight" });
    expect(document.activeElement).toBe(rectEl(index.id));
    fireEvent.keyDown(rectEl(index.id), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(rectEl(scan.id));
    fireEvent.keyDown(rectEl(scan.id), { key: "ArrowUp" });
    expect(document.activeElement).toBe(rectEl(root.id));
    fireEvent.keyDown(rectEl(scan.id), { key: "Enter" });
    expect(ids()).toEqual([scan.id]);
    expect(rectEl(scan.id).getAttribute("aria-selected")).toBe("true");
    outer.mockClear();
    fireEvent.keyDown(rectEl(scan.id), { key: "Escape" });
    expect(ids()).toHaveLength(3);
    expect(outer).not.toHaveBeenCalled();
  });

  it("描ける値が無い計画は空表示", () => {
    const empty = parsePostgresPlan(JSON.stringify([{ Plan: { "Node Type": "Result" } }])).root as PlanNode;
    renderWithProviders(<ExplainIcicleView root={empty} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText(/描画できる|no time or cost/i)).toBeTruthy();
  });

  it("選択ノードが見えないとき、Tab 停止位置は見えている祖先になる", () => {
    const tiny = parsePostgresPlan(
      JSON.stringify([
        {
          Plan: {
            "Node Type": "Sort",
            "Actual Rows": 1,
            "Actual Loops": 1,
            "Actual Total Time": 100000,
            Plans: [
              { "Node Type": "Seq Scan", "Actual Rows": 1, "Actual Loops": 1, "Actual Total Time": 99999 },
              { "Node Type": "Index Scan", "Actual Rows": 1, "Actual Loops": 1, "Actual Total Time": 0.001 },
            ],
          },
        },
      ]),
    ).root as PlanNode;
    renderWithProviders(
      <ExplainIcicleView root={tiny} selectedId={tiny.children[1].id} onSelect={() => {}} />,
    );
    expect(rectEl(tiny.children[1].id)).toBeNull();
    expect(rectEl(tiny.id).getAttribute("tabindex")).toBe("0");
  });

  it("ホットスポットのバッジは選択だけでズームしない", () => {
    const onSelect = vi.fn();
    renderWithProviders(<ExplainIcicleView root={root} selectedId={root.id} onSelect={onSelect} />);
    const badge = screen
      .getAllByRole("button")
      .find((b) => /Seq Scan/.test(b.textContent ?? "")) as HTMLElement;
    fireEvent.click(badge);
    expect(onSelect).toHaveBeenCalledWith(root.children[0].id);
    expect(ids()).toHaveLength(3);
  });

  it("Modal 内: ズーム中の Esc はズームだけ戻し、全景の Esc でモーダルが閉じる", async () => {
    const onClose = vi.fn();
    function Harness() {
      const [sel, setSel] = useState(root.id);
      return (
        <Modal onClose={onClose}>
          <ModalBody>
            <ExplainIcicleView root={root} selectedId={sel} onSelect={setSel} />
          </ModalBody>
        </Modal>
      );
    }
    renderWithProviders(<Harness />);
    const scanId = root.children[0].id;
    const el = await vi.waitFor(() => {
      const e = document.querySelector(`[data-icicle-id="${CSS.escape(scanId)}"]`) as SVGGElement | null;
      if (!e) throw new Error("not rendered");
      return e;
    });
    // Modal (zag) の Esc は HTML 要素から来たキーを対象にするので、フォーカスは HTML のバッジに置く。
    const badge = screen
      .getAllByRole("button")
      .find((b) => /Seq Scan/.test(b.textContent ?? "")) as HTMLElement;
    // 全景では Esc を奪わない (Modal の dismiss を止める印が無い)。
    expect(document.querySelector("[data-modal-esc-guard]")).toBeNull();
    fireEvent.click(el);
    expect(ids()).toEqual([scanId]);
    // ズーム中はズームアウトできるので、Modal の Esc dismiss を止める印が付く。
    expect(document.querySelector("[data-modal-esc-guard]")).not.toBeNull();
    badge.focus();
    fireEvent.keyDown(badge, { key: "Escape" });
    expect(ids()).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 600));
    expect(onClose).not.toHaveBeenCalled();
    // 全景に戻ったので、次の Esc はモーダルを閉じる。
    fireEvent.keyDown(badge, { key: "Escape" });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
