import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { Modal, ModalBody } from "../components/Modal";
import {
  clampDraftInt,
  parseDraftNumber,
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

function Harness({
  onCommit,
  initial = 5,
  min = 1,
  max = 100,
}: {
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
    expect(onCommit).not.toHaveBeenCalled();
    await user.type(input, "27");
    expect(input.value).toBe("27");
    // 範囲内の値はその場で確定される (途中の "2" も含む)。
    expect(onCommit).toHaveBeenLastCalledWith(27);
  });

  it("上限を超えた途中入力は、その場で上限として確定する", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} initial={5} min={1} max={100} />);
    const input = screen.getByLabelText("件数");
    await user.clear(input);
    await user.type(input, "300");
    expect(onCommit).toHaveBeenLastCalledWith(100);
  });

  it("範囲外の途中入力は確定せず、範囲に入った時点で確定する", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} initial={5} min={4} max={64} />);
    const input = screen.getByLabelText("件数");
    await user.clear(input);
    await user.type(input, "1");
    expect(onCommit).not.toHaveBeenCalled();
    await user.type(input, "2");
    expect(onCommit).toHaveBeenCalledWith(12);
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

describe("DraftNumberInput と Modal の Cmd/Ctrl+Enter (#1534)", () => {
  it("欄にフォーカスしたまま送信しても、入力した新しい値で onSubmit が走る", async () => {
    const user = userEvent.setup();
    const submitted = vi.fn();
    function Form() {
      const [n, setN] = useState(5);
      return (
        <Modal onClose={() => {}} onSubmit={() => submitted(n)}>
          <ModalBody>
            <DraftNumberInput aria-label="件数" value={n} min={1} max={100} onCommit={setN} />
          </ModalBody>
        </Modal>
      );
    }
    renderWithProviders(<Form />);
    const input = screen.getByLabelText("件数");
    await user.clear(input);
    await user.type(input, "42");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(submitted).toHaveBeenCalledWith(42);
  });
});

describe("DraftNumberInput の小数入力 (allowDecimal)", () => {
  it("parseDraftNumber は小数と入力途中の 1. を読み、- や . だけは null", () => {
    expect(parseDraftNumber("1.5")).toBe(1.5);
    expect(parseDraftNumber("-0.25")).toBe(-0.25);
    expect(parseDraftNumber("1.")).toBe(1);
    expect(parseDraftNumber(".5")).toBe(0.5);
    expect(parseDraftNumber("-")).toBeNull();
    expect(parseDraftNumber(".")).toBeNull();
    expect(parseDraftNumber("1e5")).toBeNull();
    expect(parseDraftNumber("")).toBeNull();
  });

  it("-1.5 のように途中で - や 1. を挟んでも欄に残り、小数で確定される", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    function H() {
      const [v, setV] = useState(0);
      return (
        <DraftNumberInput
          aria-label="最小"
          allowDecimal
          value={v}
          onCommit={(n) => {
            setV(n);
            onCommit(n);
          }}
        />
      );
    }
    renderWithProviders(<H />);
    const input = screen.getByLabelText("最小") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "-1.");
    expect(input.value).toBe("-1.");
    await user.type(input, "5");
    expect(input.value).toBe("-1.5");
    expect(onCommit).toHaveBeenLastCalledWith(-1.5);
    await user.tab();
    expect(input.value).toBe("-1.5");
  });
});
