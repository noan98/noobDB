import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, act } from "./testUtils";
import { t } from "../i18n";

const runSqlScript = vi.fn().mockResolvedValue(undefined);
const cancelStream = vi.fn().mockResolvedValue({ deliveredRows: 0 });
let resolveListen: ((unlisten: () => void) => void) | null = null;
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      runSqlScript: (...a: unknown[]) => runSqlScript(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
    listenScriptStream: () =>
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
  };
});

import { ScriptRunModal } from "../components/ScriptRunModal";

describe("ScriptRunModal: 購読の await 中にアンマウントされた場合", () => {
  it("購読を解除し、runSqlScript を呼ばない", async () => {
    const unlisten = vi.fn();
    const { unmount } = renderWithProviders(
      <ScriptRunModal sessionId="s1" database={null} isProduction={false} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByPlaceholderText(t("scriptFilePlaceholder")), {
      target: { value: "/tmp/a.sql" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("scriptExecute") }));
    await act(async () => {});
    expect(resolveListen).not.toBeNull();
    unmount();
    await act(async () => {
      resolveListen?.(unlisten);
    });
    expect(unlisten).toHaveBeenCalled();
    expect(runSqlScript).not.toHaveBeenCalled();
  });
});
