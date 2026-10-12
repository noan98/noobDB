import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import {
  clampDraftInt,
  DraftNumberInput,
  parseDraftInt,
} from "../components/DraftNumberInput";

describe("parseDraftInt / clampDraftInt (#1534)", () => {
  it("整数だけを受け付け、空・不正・安全整数超過は null", () => {
    expect(parseDraftInt("12")).toBe(12);
    expect(parseDraftInt(" 7 ")).toBe(7);
    expect(parseDraftInt("-3")).toBe(-3);
    expect(parseDraftInt("")).toBeNull();
    expect(parseDraftInt("  ")).toBeNull();
    expect(parseDraftInt("abc")).toBeNull();
    expect(parseDraftInt("1.5")).toBeNull();
    expect(parseDraftInt("9007199254740993")).toBeNull();
  });

  it("min / max で丸める (片側だけ指定も可)", () => {
    expect(clampDraftInt(30, 8, 24)).toBe(24);
    expect(clampDraftInt(1, 8, 24)).toBe(8);
    expect(clampDraftInt(5, 8)).toBe(8);
    expect(clampDraftInt(500, undefined, 100)).toBe(100);
    expect(clampDraftInt(10)).toBe(10);
  });
});

function Harness({ onCommit, initial = 5, min = 1, max = 100 }: {
  onCommit: (n: number) => void;
  initial?: number;
  min?: number;
  max?: number;
}) {
  const [value, setValue] = useState(initial);
  return (
    <DraftNumberInput
      aria-label="件数"
      value={value}
      min={min}
      max={max}
      onCommit={(n) => {
        setValue(n);
        onCommit(n);
      }}
    />
  );
}

describe("DraftNumberInput (#1534)", () => {
  it("入力中は確定せず、空欄にしても既定値へ戻らない (打ち直しで連結しない)", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} />);
    const input = screen.getByLabelText("件数") as HTMLInputElement;

    await user.clear(input);
    expect(input.value).toBe("");
    await user.type(input, "27");
    expect(input.value).toBe("27");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("blur で確定し、上限を超えた値は clamp 後の値が欄に戻る", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} initial={100} />);
    const input = screen.getByLabelText("件数") as HTMLInputElement;

    await user.clear(input);
    await user.type(input, "300");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(100);
    expect(input.value).toBe("100");
  });

  it("Enter でも確定する", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} />);
    const input = screen.getByLabelText("件数");
    await user.clear(input);
    await user.type(input, "42{Enter}");
    expect(onCommit).toHaveBeenCalledWith(42);
  });

  it("空のまま blur したら何も書き込まず、確定済みの値の表示へ戻す", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} initial={9} />);
    const input = screen.getByLabelText("件数") as HTMLInputElement;
    await user.clear(input);
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("9");
  });
});
