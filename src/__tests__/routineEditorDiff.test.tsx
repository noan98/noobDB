import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

// ルーチン編集の「元の定義との差分」(#1626)。

const ORIGINAL = "CREATE FUNCTION f() RETURNS int\nBEGIN\n  RETURN 1;\nEND";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getObjectDefinition: () => Promise.resolve(ORIGINAL),
    },
  };
});

import { RoutineEditorModal } from "../components/RoutineEditorModal";

function setup() {
  renderWithProviders(
    <RoutineEditorModal
      sessionId="s1"
      driver="postgres"
      database="app"
      kind="function"
      name="f"
      id={null}
      readOnly={false}
      onApplied={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("RoutineEditorModal: 差分表示 (#1626)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("読み込み直後は変更なし、編集すると追加 / 削除行を差分に出す", async () => {
    setup();
    expect(await screen.findByTestId("routine-diff-none")).toBeTruthy();
    expect(screen.getByText(t("routineEditDiffNone"))).toBeTruthy();
    const area = screen.getByLabelText(t("routineEditSqlLabel")) as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe(ORIGINAL));
    fireEvent.change(area, { target: { value: ORIGINAL.replace("RETURN 1;", "RETURN 2;") } });
    const diff = await screen.findByTestId("ai-sql-diff");
    const kinds = Array.from(diff.querySelectorAll("[data-diff]")).map((e) => e.getAttribute("data-diff"));
    expect(kinds).toContain("add");
    expect(kinds).toContain("del");
    expect(screen.queryByTestId("routine-diff-none")).toBeNull();
  });
});
