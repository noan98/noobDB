import { beforeEach, describe, expect, it } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act } from "./testUtils";
import { t } from "../i18n";
import { useConfirm, type ConfirmOptions } from "../components/ConfirmDialog";
import { clearSuppressedConfirms, getSettings, isConfirmSuppressed } from "../settings";

// 「今後は表示しない」(#1626): 非破壊の確認だけが対象で、選ぶと次回から出さずに確認済みとして解決し、
// 設定から戻せる。danger / warning ・タイプ確認・第 3 の選択肢があるときは出さない。

let ask: (o: ConfirmOptions) => Promise<boolean>;

function Host() {
  const { confirm, dialog } = useConfirm();
  ask = confirm;
  return <>{dialog}</>;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  clearSuppressedConfirms();
});

describe("useConfirm rememberKey", () => {
  it("チェックして確認すると記憶され、次回は出さずに true になる", async () => {
    renderWithProviders(<Host />);
    let p!: Promise<boolean>;
    act(() => {
      p = ask({ title: "T", message: "M", rememberKey: "k1" });
    });
    fireEvent.click(await screen.findByLabelText(t("confirmRememberLabel")));
    fireEvent.click(screen.getByText(t("confirmDefaultOk")));
    await expect(p).resolves.toBe(true);
    expect(isConfirmSuppressed("k1")).toBe(true);
    expect(getSettings().suppressedConfirms).toEqual(["k1"]);
    // 2 回目はダイアログなしで即 true。
    await expect(ask({ title: "T", message: "M", rememberKey: "k1" })).resolves.toBe(true);
    // 設定から戻すと再び出る。
    act(() => clearSuppressedConfirms());
    expect(isConfirmSuppressed("k1")).toBe(false);
  });

  it("チェックせずに確認しても記憶しない / キャンセルでも記憶しない", async () => {
    renderWithProviders(<Host />);
    let p!: Promise<boolean>;
    act(() => {
      p = ask({ title: "T", message: "M", rememberKey: "k2" });
    });
    fireEvent.click(await screen.findByLabelText(t("confirmRememberLabel")));
    fireEvent.click(screen.getByText(t("confirmDefaultCancel")));
    await expect(p).resolves.toBe(false);
    expect(isConfirmSuppressed("k2")).toBe(false);
  });

  it("warning / danger の確認にはチェックを出さない", async () => {
    renderWithProviders(<Host />);
    act(() => {
      void ask({ title: "T", message: "M", rememberKey: "k3", tone: "warning" });
    });
    await screen.findByText("T");
    expect(screen.queryByLabelText(t("confirmRememberLabel"))).toBeNull();
    await waitFor(() => expect(screen.getByText("M")).toBeTruthy());
  });
});
