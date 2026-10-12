import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import { HostKeyMismatchDialog } from "../components/HostKeyMismatchDialog";

function renderDialog(busy: boolean, onCancel = vi.fn()) {
  renderWithProviders(
    <HostKeyMismatchDialog
      profile={makeProfile()}
      message="host key mismatch"
      busy={busy}
      onReTrust={vi.fn()}
      onCancel={onCancel}
    />,
  );
  return { onCancel };
}

describe("HostKeyMismatchDialog の再信頼中 (#1534)", () => {
  it("実行中は Esc でも × でも閉じない", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog(true);
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    const close = screen.getAllByRole("button", { name: t("hostKeyMismatchCancel") })[0];
    expect(close).toBeDisabled();
  });

  it("実行中でなければ Esc で閉じられる", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog(false);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });
});
