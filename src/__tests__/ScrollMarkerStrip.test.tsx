// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScrollMarkerStrip, scrollTickLabel } from "../components/ScrollMarkerStrip";
import type { ScrollMarkSnapshot } from "../components/scrollMarkers";
import { t } from "../i18n";

const snapshot: ScrollMarkSnapshot = {
  sources: [
    { pos: 100, line: 5, kind: "error", label: "near FROM" },
    { pos: 900, line: 90, kind: "search", label: "" },
  ],
  totalLines: 100,
  activeLines: { from: 40, to: 45 },
};

describe("ScrollMarkerStrip (#2382)", () => {
  it("ティックを種別のクラスで描き、クリックでその位置へ移動する", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const onJump = vi.fn();
    render(<ScrollMarkerStrip host={host} snapshot={snapshot} onJump={onJump} />);
    const ticks = host.querySelectorAll("button.cm-scroll-marker");
    expect(ticks).toHaveLength(2);
    expect(ticks[0]?.classList.contains("cm-scroll-marker-error")).toBe(true);
    expect(ticks[1]?.classList.contains("cm-scroll-marker-search")).toBe(true);
    expect(host.querySelector(".cm-scroll-marker-active")).not.toBeNull();
    fireEvent.click(ticks[0] as Element);
    expect(onJump).toHaveBeenCalledWith(100);
  });

  it("印が無い・スナップショットが無いときは何も描かない", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { rerender } = render(
      <ScrollMarkerStrip host={host} snapshot={{ ...snapshot, sources: [] }} onJump={() => {}} />,
    );
    expect(host.children).toHaveLength(0);
    rerender(<ScrollMarkerStrip host={host} snapshot={null} onJump={() => {}} />);
    expect(host.children).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ツールチップの本文は種別・本文の 1 行目・行番号・まとまった件数", () => {
    const label = scrollTickLabel({ kind: "error", label: "boom", line: 7, count: 3 }, t);
    expect(label).toContain(t("editorScrollMarkerError"));
    expect(label).toContain("boom");
    expect(label).toContain(t("editorScrollMarkerLine", { line: 7 }));
    expect(label).toContain(t("editorScrollMarkerMore", { n: 2 }));
    expect(scrollTickLabel({ kind: "search", label: "", line: 2, count: 1 }, t)).not.toContain(":");
  });
});
