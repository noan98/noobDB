import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { chooseListboxOption, renderWithProviders, screen, waitFor } from "./testUtils";
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
    await screen.findByText("sad, ok, happy");
    await user.type(screen.getByLabelText(t("enumTypeNewValue")), "meh");
    expect(screen.getByText(`ALTER TYPE "public"."mood" ADD VALUE 'meh';`)).toBeInTheDocument();

    chooseListboxOption(screen.getByLabelText(t("enumTypePosition")), "after");
    await waitFor(() =>
      expect(screen.getByText(`ALTER TYPE "public"."mood" ADD VALUE 'meh' AFTER 'sad';`)).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: t("enumTypeConfirmAdd") }));
    expect(onConfirm).toHaveBeenCalledWith(`ALTER TYPE "public"."mood" ADD VALUE 'meh' AFTER 'sad';`);
  });

  it("既存の値は重複エラーで確定できない", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await screen.findByText("sad, ok, happy");
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
    await screen.findByText("sad, ok, happy");
    chooseListboxOption(screen.getByLabelText(t("enumTypeOldValue")), "ok");
    await user.type(screen.getByLabelText(t("enumTypeRenameTo")), "fine");
    await user.click(screen.getByRole("button", { name: t("enumTypeConfirmRename") }));
    expect(onConfirm).toHaveBeenCalledWith(`ALTER TYPE "public"."mood" RENAME VALUE 'ok' TO 'fine';`);
  });

  it("read_only では警告を出して確定できない", async () => {
    setup({ readOnly: true });
    await screen.findByText("sad, ok, happy");
    expect(screen.getByText(t("enumTypeReadOnly"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("enumTypeConfirmAdd") })).toBeDisabled();
  });
});
