import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { ComboSelect, type ComboSelectOption } from "../components/ComboSelect";

/**
 * ポップオーバー型コンボボックス `ComboSelect`。開閉・フィルタ・クリック/キーボード
 * 選択・ARIA 結線の一連の挙動を固定する。位置決めの算術 (フリップ/クランプ) は
 * jsdom では矩形が常に 0 になるため `menuPosition.test.ts` と同じくここでは扱わず、
 * ふるまい (何が開き、何が呼ばれるか) だけを検証する。
 */
beforeAll(() => {
  // jsdom は Element.scrollIntoView を実装しないため、ハイライト移動時の可視化
  // effect が落ちないよう no-op を差す (`tabBar.test.tsx` と同じパターン)。
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const OPTIONS: ComboSelectOption[] = [
  { value: "id", detail: "int" },
  { value: "name", detail: "varchar(255)", badges: [{ label: "NOT NULL" }] },
  { value: "email", detail: "varchar(255)" },
  { value: "created_at", detail: "datetime" },
];

function Harness({
  onChangeSpy,
  onEnterSpy,
  initialValue = "",
  options = OPTIONS,
  freeSolo,
}: {
  onChangeSpy: (v: string) => void;
  onEnterSpy?: () => void;
  initialValue?: string;
  options?: ComboSelectOption[];
  freeSolo?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <>
      <ComboSelect
        value={value}
        options={options}
        freeSolo={freeSolo}
        onChange={(v) => {
          setValue(v);
          onChangeSpy(v);
        }}
        onEnter={onEnterSpy}
        placeholder="カラムを選択"
        emptyText="候補がありません"
      />
      <button type="button">外側</button>
    </>
  );
}

function renderCombo(
  opts: {
    onEnterSpy?: () => void;
    initialValue?: string;
    options?: ComboSelectOption[];
    freeSolo?: boolean;
  } = {},
) {
  const onChangeSpy = vi.fn();
  renderWithProviders(<Harness onChangeSpy={onChangeSpy} {...opts} />);
  return { onChangeSpy };
}

describe("ComboSelect の開閉", () => {
  it("フォーカスで開き、全候補がリストボックスに表示される", async () => {
    const user = userEvent.setup();
    renderCombo();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(OPTIONS.length);
  });

  it("Escape で閉じ、入力値は保持される", async () => {
    const user = userEvent.setup();
    renderCombo({ initialValue: "na" });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.click(input);
    expect(screen.getByRole("listbox")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("na");
  });

  it("外側クリックで閉じる", async () => {
    const user = userEvent.setup();
    renderCombo();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "外側" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("freeSolo=false で確定せずに blur すると直前の value へ戻る", async () => {
    const user = userEvent.setup();
    const { onChangeSpy } = renderCombo({ initialValue: "name", freeSolo: false });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.click(input);
    await user.clear(input);
    await user.type(input, "xyz-not-a-column");
    expect(input.value).toBe("xyz-not-a-column");
    // 未確定のまま候補に無い値を入力しても onChange は呼ばれない。
    expect(onChangeSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "外側" }));
    expect(input.value).toBe("name");
  });
});

describe("ComboSelect のフィルタリング", () => {
  it("入力値で大小無視の部分一致に絞られる", async () => {
    const user = userEvent.setup();
    renderCombo();
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.type(input, "NA");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("name");
  });

  it("入力が空なら全候補を表示する", async () => {
    const user = userEvent.setup();
    renderCombo();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getAllByRole("option")).toHaveLength(OPTIONS.length);
  });

  it("候補が 0 件のとき emptyText を表示する", async () => {
    const user = userEvent.setup();
    renderCombo();
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.type(input, "zzz-no-such-column");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("候補がありません")).toBeTruthy();
  });
});

describe("ComboSelect の選択", () => {
  it("候補クリックで onChange が呼ばれ、閉じる", async () => {
    const user = userEvent.setup();
    const { onChangeSpy } = renderCombo();
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /email/ }));

    expect(onChangeSpy).toHaveBeenCalledWith("email");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("↑/↓ でハイライトを移動し Enter で確定する", async () => {
    const user = userEvent.setup();
    const { onChangeSpy } = renderCombo();
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.keyboard("{ArrowDown}"); // -> "id"
    await user.keyboard("{ArrowDown}"); // -> "name"
    await user.keyboard("{Enter}");

    expect(onChangeSpy).toHaveBeenCalledWith("name");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("↑ は末尾から始まり、末尾からさらに ↓ すると先頭へループする", async () => {
    const user = userEvent.setup();
    renderCombo();
    const input = screen.getByRole("combobox");
    await user.click(input);

    await user.keyboard("{ArrowUp}");
    let options = screen.getAllByRole("option");
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      options[OPTIONS.length - 1].id,
    );

    // 末尾からさらに 1 つ進めると先頭へループする。
    await user.keyboard("{ArrowDown}");
    options = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
  });

  it("ハイライトが無いまま Enter を押すと onEnter が呼ばれる (選択は起きない)", async () => {
    const user = userEvent.setup();
    const onEnterSpy = vi.fn();
    const { onChangeSpy } = renderCombo({ onEnterSpy });
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.keyboard("{Enter}");

    expect(onEnterSpy).toHaveBeenCalledTimes(1);
    expect(onChangeSpy).not.toHaveBeenCalled();
  });
});

describe("ComboSelect の ARIA 結線", () => {
  it("role / aria-expanded / aria-controls / aria-activedescendant が正しく結線される", async () => {
    const user = userEvent.setup();
    renderCombo();
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-expanded", "false");

    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    // 開いた直後はまだ何もハイライトされていない。
    expect(input).not.toHaveAttribute("aria-activedescendant");

    await user.keyboard("{ArrowDown}");
    const options = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    expect(options[0]).toHaveAttribute("aria-selected", "false");
  });

  it("選択済みの値と一致する行は aria-selected=true になる", async () => {
    const user = userEvent.setup();
    renderCombo({ initialValue: "email" });
    await user.click(screen.getByRole("combobox"));

    const selected = screen.getByRole("option", { name: /email/ });
    expect(selected).toHaveAttribute("aria-selected", "true");
  });
});
