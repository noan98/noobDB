import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { ListboxSelect, type ListboxSelectOption } from "../components/ListboxSelect";

/**
 * `ListboxSelect` (#1143): ネイティブ select 相当の自由入力なし単純選択。
 * `ComboSelect` と同じ portal + listbox 基盤の上で、トリガーは `<button
 * role="combobox">` (APG の select-only combobox パターン)。開閉・キーボード
 * 操作・型入力ジャンプ・ARIA 結線を固定する。位置決めの算術は jsdom では
 * 検証しない (`comboSelect.test.tsx` と同じ方針)。
 */
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const OPTIONS: ListboxSelectOption[] = [
  { value: "bar", label: "棒グラフ" },
  { value: "line", label: "折れ線" },
  { value: "area", label: "面" },
  { value: "pie", label: "円" },
];

function Harness({
  onChangeSpy,
  initialValue = "bar",
  options = OPTIONS,
  disabled,
}: {
  onChangeSpy: (v: string) => void;
  initialValue?: string;
  options?: ListboxSelectOption[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <>
      <ListboxSelect
        value={value}
        options={options}
        disabled={disabled}
        ariaLabel="チャート種別"
        onChange={(v) => {
          setValue(v);
          onChangeSpy(v);
        }}
      />
      <button type="button">外側</button>
    </>
  );
}

function renderSelect(
  opts: { initialValue?: string; options?: ListboxSelectOption[]; disabled?: boolean } = {},
) {
  const onChangeSpy = vi.fn();
  renderWithProviders(<Harness onChangeSpy={onChangeSpy} {...opts} />);
  return { onChangeSpy };
}

describe("ListboxSelect の開閉", () => {
  it("クリックで開き、全候補がリストボックスに表示される", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(OPTIONS.length);
  });

  it("再クリックで閉じる", async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape で選択せずに閉じる", async () => {
    const user = userEvent.setup();
    const { onChangeSpy } = renderSelect();
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it("外側クリックで閉じる", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "外側" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("disabled のときは開かない", async () => {
    const user = userEvent.setup();
    renderSelect({ disabled: true });
    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("ListboxSelect の選択", () => {
  it("候補クリックで onChange が呼ばれ、閉じる", async () => {
    const user = userEvent.setup();
    const { onChangeSpy } = renderSelect();
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "円" }));
    expect(onChangeSpy).toHaveBeenCalledWith("pie");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("開くと現在選択中の候補がハイライトされる", async () => {
    const user = userEvent.setup();
    renderSelect({ initialValue: "area" });
    await user.click(screen.getByRole("combobox"));
    const options = screen.getAllByRole("option");
    const trigger = screen.getByRole("combobox");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(options[2].id);
  });

  it("↓/↑ でハイライトを移動し Enter で確定する", async () => {
    const user = userEvent.setup();
    const { onChangeSpy } = renderSelect({ initialValue: "bar" });
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.keyboard("{ArrowDown}"); // bar(0) -> line(1)
    await user.keyboard("{ArrowDown}"); // -> area(2)
    await user.keyboard("{Enter}");
    expect(onChangeSpy).toHaveBeenCalledWith("area");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Home/End で先頭/末尾へ移動する", async () => {
    const user = userEvent.setup();
    renderSelect({ initialValue: "line" });
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.keyboard("{End}");
    let options = screen.getAllByRole("option");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(options[OPTIONS.length - 1].id);

    await user.keyboard("{Home}");
    options = screen.getAllByRole("option");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(options[0].id);
  });

  it("閉じているときに ↓ を押すと開いて選択中の候補がハイライトされる", async () => {
    const user = userEvent.setup();
    renderSelect({ initialValue: "line" });
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(options[1].id);
  });

  it("型入力ジャンプ: 閉じているときは即座に選択する", async () => {
    // 型入力ジャンプは表示ラベル (見えている文字) に前方一致させる。
    const user = userEvent.setup();
    const { onChangeSpy } = renderSelect({ initialValue: "bar" });
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    await user.keyboard("円"); // ラベル "円" (value="pie") にヒット
    expect(onChangeSpy).toHaveBeenCalledWith("pie");
  });

  it("型入力ジャンプ: 開いているときはハイライトのみ動かし確定しない", async () => {
    const user = userEvent.setup();
    const { onChangeSpy } = renderSelect({ initialValue: "bar" });
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.keyboard("折"); // ラベル "折れ線" (value="line")
    expect(onChangeSpy).not.toHaveBeenCalled();
    const options = screen.getAllByRole("option");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(options[1].id);
  });
});

describe("ListboxSelect の ARIA 結線", () => {
  it("role / aria-expanded / aria-controls / aria-haspopup が正しく結線される", async () => {
    const user = userEvent.setup();
    renderSelect();
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(trigger.getAttribute("aria-controls")).toBe(listbox.id);
  });

  it("選択済みの値と一致する候補は aria-selected=true になる", async () => {
    const user = userEvent.setup();
    renderSelect({ initialValue: "pie" });
    await user.click(screen.getByRole("combobox"));
    const selected = screen.getByRole("option", { name: "円" });
    expect(selected).toHaveAttribute("aria-selected", "true");
  });

  it("トリガーには選択中のラベルが表示される", () => {
    renderSelect({ initialValue: "line" });
    expect(screen.getByRole("combobox")).toHaveTextContent("折れ線");
  });
});

// value に検索用文字列が含まれない ReactNode ラベルを使うケース (searchText の
// フォールバック) を軽く確認する。ListboxSelectOption.value 自体は英数字。
describe("ListboxSelect の型入力 (value ベースのフォールバック)", () => {
  it("label 未指定なら value をラベル表示・検索の両方に使う", async () => {
    const user = userEvent.setup();
    const options: ListboxSelectOption[] = [
      { value: "id" },
      { value: "name" },
      { value: "email" },
    ];
    const { onChangeSpy } = renderSelect({ initialValue: "id", options });
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("id");
    trigger.focus();
    await user.keyboard("e");
    expect(onChangeSpy).toHaveBeenCalledWith("email");
  });
});
