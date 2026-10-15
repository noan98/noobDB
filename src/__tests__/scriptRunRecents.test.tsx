import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { loadRecentScripts, saveRecentScripts } from "../inputMemory";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { ScriptRunModal } from "../components/ScriptRunModal";

beforeEach(() => {
  localStorage.clear();
});

describe("ScriptRunModal 最近実行したファイル (#1631)", () => {
  it("履歴から選ぶと、パスと文字コードが入力欄に入る", () => {
    saveRecentScripts([
      { path: "/work/migrate_001.sql", encoding: "shift_jis" },
      { path: "/work/seed.sql", encoding: null },
    ]);
    renderWithProviders(
      <ScriptRunModal sessionId="s1" database={null} isProduction={false} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: t("scriptRecentLabel") }), {
      target: { value: "0" },
    });
    expect((screen.getByPlaceholderText(t("scriptFilePlaceholder")) as HTMLInputElement).value).toBe(
      "/work/migrate_001.sql",
    );
    expect((screen.getByLabelText(t("scriptEncodingLabel")) as HTMLSelectElement).value).toBe("shift_jis");
  });

  it("履歴が無ければ選択欄を出さない", () => {
    renderWithProviders(
      <ScriptRunModal sessionId="s1" database={null} isProduction={false} onClose={() => {}} />,
    );
    expect(screen.queryByRole("combobox", { name: t("scriptRecentLabel") })).not.toBeInTheDocument();
    expect(loadRecentScripts()).toEqual([]);
  });
});
