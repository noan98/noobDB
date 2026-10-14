import { describe, expect, it } from "vitest";
import { renderInBrowser } from "./render";
import { t } from "../../i18n";
import { useConfirm } from "../../components/ConfirmDialog";

// 「タイプして確認」のラベルには入力すべき対象名が入る。FieldLabel の overline
// (大文字化) が効くと `users` が `USERS` と表示され、表示どおりに打っても一致
// しない (大文字小文字を区別する)。jsdom では Chakra の CSS が計算されないので
// 実ブラウザで確かめる (#1619)。
function Harness() {
  const { confirm, dialog } = useConfirm();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void confirm({
            title: "Drop",
            message: "",
            confirmLabel: "Drop",
            tone: "danger",
            typedConfirmation: "users",
          });
        }}
      >
        open
      </button>
      {dialog}
    </>
  );
}

describe("ConfirmDialog の確認入力ラベル (実ブラウザ)", () => {
  it("対象名を大文字化しない", async () => {
    const screen = await renderInBrowser(<Harness />);
    await screen.getByRole("button", { name: "open" }).click();
    const label = screen.getByText(t("typeToConfirmLabel", { target: "users" }));
    await expect.element(label).toBeVisible();
    expect(getComputedStyle(label.element()).textTransform).toBe("none");
  });
});
