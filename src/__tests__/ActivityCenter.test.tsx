import { beforeEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "./testUtils";
import { ActivityCenter } from "../components/ActivityCenter";
import { useToast } from "../components/Toast";
import { __resetActivityLog, getActivityState, pushActivity } from "../activityLog";
import { setLocale, t } from "../i18n";

// アクティビティセンター (#912) の UI 結線。ストアの純ロジックは
// `activityLog.test.ts` が押さえるので、ここでは「開閉・絞り込み・クリア・未読
// バッジ・トーストからの記録」という UI 側の契約だけを見る。

describe("ActivityCenter (#912)", () => {
  beforeEach(() => {
    setLocale("en");
    __resetActivityLog();
  });

  async function open() {
    const user = userEvent.setup();
    renderWithProviders(<ActivityCenter />);
    await user.click(screen.getByRole("button", { name: /Activity/ }));
    return { user, panel: screen.getByRole("dialog", { name: t("activityCenterTitle") }) };
  }

  it("自動消滅したトーストの内容を後から一覧できる", async () => {
    pushActivity("error", "import failed");
    pushActivity("success", "sync applied");

    const { panel } = await open();
    // 最新が先頭。
    const items = within(panel).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("sync applied");
    expect(items[1]).toHaveTextContent("import failed");
  });

  it("重大度で絞り込める", async () => {
    pushActivity("error", "import failed");
    pushActivity("success", "sync applied");

    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: /Error/ }));

    const items = within(panel).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("import failed");

    // もう一度押すと解除されて全件に戻る。
    await user.click(within(panel).getByRole("button", { name: /Error/ }));
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
  });

  it("クリアすると空状態になる", async () => {
    pushActivity("info", "copied");
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: t("activityClear") }));
    expect(within(panel).getByText(t("activityEmpty"))).toBeInTheDocument();
    expect(getActivityState().entries).toHaveLength(0);
  });

  it("Escape で閉じる", async () => {
    pushActivity("info", "hello");
    const { user } = await open();
    await user.keyboard("{Escape}");
    // 退出は AnimatePresence 経由なので、DOM から消えるまで待つ。
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: t("activityCenterTitle") }),
      ).not.toBeInTheDocument(),
    );
  });

  it("未読件数をボタンのラベルで示し、開くと既読になる", async () => {
    pushActivity("info", "one");
    pushActivity("info", "two");
    const user = userEvent.setup();
    renderWithProviders(<ActivityCenter />);

    const bell = screen.getByRole("button", { name: t("activityOpenUnread", { count: 2 }) });
    await user.click(bell);
    // 開いた時点で既読になり、ラベルから未読表記が消える。
    expect(screen.getByRole("button", { name: t("activityOpen") })).toBeInTheDocument();
  });

  it("トーストを出すとアクティビティにも残る", async () => {
    function Emitter() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => toast.error("export failed")}>
          emit
        </button>
      );
    }
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <Emitter />
        <ActivityCenter />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "emit" }));

    expect(getActivityState().entries[0]).toMatchObject({
      severity: "error",
      message: "export failed",
    });
  });

  it("tone を変えずに重大度だけ警告として記録できる", async () => {
    function Emitter() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() => toast.notify({ message: "plan changed", tone: "info", severity: "warning" })}
        >
          emit
        </button>
      );
    }
    const user = userEvent.setup();
    renderWithProviders(<Emitter />);
    await user.click(screen.getByRole("button", { name: "emit" }));

    expect(getActivityState().entries[0]).toMatchObject({
      severity: "warning",
      message: "plan changed",
    });
  });
});
