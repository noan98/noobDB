import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { chooseListboxOption, renderWithProviders, screen, waitFor, within } from "./testUtils";
import { setLocale, t } from "../i18n";

// ENUM 型の値の追加 / 名前の変更ダイアログ (#2127)。

const DDL = `CREATE TYPE "public"."mood" AS ENUM ('sad', 'ok', 'happy');`;

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, getObjectDefinition: () => Promise.resolve(DDL) },
  };
});

import { EnumTypeModal } from "../components/EnumTypeModal";

/** 現在の値のチップ列 (読み込み完了まで待つ)。 */
const chips = () => screen.findByRole("radiogroup", { name: t("enumTypeCurrentValues") });
/** 並び順どおりのチップ。既存は値、ゴーストは `[値]`。 */
function chipOrder(group: HTMLElement): string[] {
  return [...group.querySelectorAll<HTMLElement>("[data-chip-kind]")].map((e) =>
    e.dataset.chipKind === "ghost" ? `[${e.textContent}]` : (e.textContent ?? ""),
  );
}

function setup(over: { mode?: "add" | "rename"; readOnly?: boolean } = {}) {
  const onConfirm = vi.fn();
  renderWithProviders(
    <EnumTypeModal
      sessionId="s1"
      database="public"
      name="mood"
      mode={over.mode ?? "add"}
      readOnly={over.readOnly ?? false}
      onConfirm={onConfirm}
      onClose={() => {}}
    />,
  );
  return { onConfirm };
}

describe("EnumTypeModal", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
  });

  it("値を追加する SQL をプレビューし、確定で渡す", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await chips();
    await user.type(screen.getByLabelText(t("enumTypeNewValue")), "meh");
    expect(screen.getByTestId("sql-preview")).toHaveTextContent(
      `ALTER TYPE "public"."mood" ADD VALUE 'meh';`,
    );

    chooseListboxOption(screen.getByLabelText(t("enumTypePosition")), "after");
    await waitFor(() =>
      expect(screen.getByTestId("sql-preview")).toHaveTextContent(
        `ALTER TYPE "public"."mood" ADD VALUE 'meh' AFTER 'sad';`,
      ),
    );
    await user.click(screen.getByRole("button", { name: t("enumTypeConfirmAdd") }));
    expect(onConfirm).toHaveBeenCalledWith(`ALTER TYPE "public"."mood" ADD VALUE 'meh' AFTER 'sad';`);
  });

  it("実行中は確定ボタンが無効になり、二重に押しても 1 回だけ渡す。完了で解除される", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderWithProviders(
      <EnumTypeModal
        sessionId="s1"
        database="public"
        name="mood"
        mode="add"
        readOnly={false}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await chips();
    await user.type(screen.getByLabelText(t("enumTypeNewValue")), "meh");
    const confirm = screen.getByRole("button", { name: t("enumTypeConfirmAdd") });
    await user.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    finish();
    await waitFor(() => expect(confirm).toBeEnabled());
  });

  it("実行が失敗しても確定ボタンの無効化は解除される", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.reject(new Error("boom")));
    renderWithProviders(
      <EnumTypeModal
        sessionId="s1"
        database="public"
        name="mood"
        mode="add"
        readOnly={false}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await chips();
    await user.type(screen.getByLabelText(t("enumTypeNewValue")), "meh");
    const confirm = screen.getByRole("button", { name: t("enumTypeConfirmAdd") });
    await user.click(confirm);
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("既存の値は重複エラーで確定できない", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await chips();
    await user.type(screen.getByLabelText(t("enumTypeNewValue")), "ok");
    expect(screen.getByText(t("enumTypeErrDuplicate"))).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: t("enumTypeConfirmAdd") });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("値の名前を変える SQL を出す", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ mode: "rename" });
    await chips();
    chooseListboxOption(screen.getByLabelText(t("enumTypeOldValue")), "ok");
    await user.type(screen.getByLabelText(t("enumTypeRenameTo")), "fine");
    await user.click(screen.getByRole("button", { name: t("enumTypeConfirmRename") }));
    expect(onConfirm).toHaveBeenCalledWith(`ALTER TYPE "public"."mood" RENAME VALUE 'ok' TO 'fine';`);
  });

  it("read_only では警告を出して確定できない", async () => {
    setup({ readOnly: true });
    await chips();
    expect(screen.getByText(t("enumTypeReadOnly"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("enumTypeConfirmAdd") })).toBeDisabled();
  });

  it("ゴーストチップは選んだ位置に入り、プレビュー SQL の BEFORE / AFTER と一致する (#2158)", async () => {
    const user = userEvent.setup();
    setup();
    const group = await chips();
    await user.type(screen.getByLabelText(t("enumTypeNewValue")), "meh");
    const preview = screen.getByTestId("sql-preview");
    expect(chipOrder(group)).toEqual(["sad", "ok", "happy", "[meh]"]);

    chooseListboxOption(screen.getByLabelText(t("enumTypePosition")), "before");
    await waitFor(() => expect(chipOrder(group)).toEqual(["[meh]", "sad", "ok", "happy"]));
    expect(preview).toHaveTextContent(`ADD VALUE 'meh' BEFORE 'sad';`);

    chooseListboxOption(screen.getByLabelText(t("enumTypeRefValue")), "ok");
    await waitFor(() => expect(chipOrder(group)).toEqual(["sad", "[meh]", "ok", "happy"]));
    expect(preview).toHaveTextContent(`ADD VALUE 'meh' BEFORE 'ok';`);

    chooseListboxOption(screen.getByLabelText(t("enumTypePosition")), "after");
    await waitFor(() => expect(chipOrder(group)).toEqual(["sad", "ok", "[meh]", "happy"]));
    expect(preview).toHaveTextContent(`ADD VALUE 'meh' AFTER 'ok';`);
  });

  it("値を入力する前は、ゴーストチップに仮の文言を出す (#2158)", async () => {
    setup();
    const group = await chips();
    expect(chipOrder(group)).toEqual(["sad", "ok", "happy", `[${t("enumTypeGhostPlaceholder")}]`]);
  });

  it("チップのクリックで基準値を選ぶと、Select と SQL に反映される (#2158)", async () => {
    const user = userEvent.setup();
    setup();
    const group = await chips();
    await user.type(screen.getByLabelText(t("enumTypeNewValue")), "meh");
    // 「末尾」のときにクリックすると、その値の後ろに置く指定へ切り替わる。
    await user.click(within(group).getByRole("radio", { name: "ok" }));
    expect(screen.getByLabelText(t("enumTypePosition"))).toHaveTextContent(t("enumTypePosAfter"));
    expect(screen.getByLabelText(t("enumTypeRefValue"))).toHaveTextContent("ok");
    expect(chipOrder(group)).toEqual(["sad", "ok", "[meh]", "happy"]);
    expect(screen.getByTestId("sql-preview")).toHaveTextContent(`AFTER 'ok';`);
    expect(within(group).getByRole("radio", { name: "ok" })).toBeChecked();
    // Select で変えるとチップの選択も追従する。
    chooseListboxOption(screen.getByLabelText(t("enumTypeRefValue")), "happy");
    await waitFor(() => expect(within(group).getByRole("radio", { name: "happy" })).toBeChecked());
  });

  it("キーボードだけで基準値を選べる (#2158)", async () => {
    const user = userEvent.setup();
    setup();
    const group = await chips();
    await user.type(screen.getByLabelText(t("enumTypeNewValue")), "meh");
    chooseListboxOption(screen.getByLabelText(t("enumTypePosition")), "before");
    const sad = within(group).getByRole("radio", { name: "sad" });
    sad.focus();
    await user.keyboard("{ArrowRight}");
    expect(within(group).getByRole("radio", { name: "ok" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "ok" })).toHaveFocus();
    expect(screen.getByTestId("sql-preview")).toHaveTextContent(`BEFORE 'ok';`);
    await user.keyboard("{End}");
    expect(within(group).getByRole("radio", { name: "happy" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(within(group).getByRole("radio", { name: "sad" })).toHaveFocus();
    expect(screen.getByTestId("sql-preview")).toHaveTextContent(`BEFORE 'sad';`);
  });

  it("名前変更ではチップで対象を選べ、入力すると対象のチップが新名に切り替わる (#2158)", async () => {
    const user = userEvent.setup();
    setup({ mode: "rename" });
    const group = await chips();
    expect(within(group).queryAllByRole("radio")).toHaveLength(3);
    await user.click(within(group).getByRole("radio", { name: "happy" }));
    expect(screen.getByLabelText(t("enumTypeOldValue"))).toHaveTextContent("happy");
    await user.type(screen.getByLabelText(t("enumTypeRenameTo")), "glad");
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: "happy" })).toHaveTextContent("glad"),
    );
    expect(screen.getByTestId("sql-preview")).toHaveTextContent(`RENAME VALUE 'happy' TO 'glad';`);
    // 名前変更ではゴーストを出さない。
    expect(group.querySelector('[data-chip-kind="ghost"]')).toBeNull();
  });
});
