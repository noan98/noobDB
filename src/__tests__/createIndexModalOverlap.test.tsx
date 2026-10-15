import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/** CreateIndexModal の重複インデックス警告 (#1625)。判定はバックエンドなので呼び出しと表示を確認する。 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const col = (name: string) => ({
    name,
    data_type: "int",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  });
  return {
    ...actual,
    api: {
      ...actual.api,
      describeTable: vi.fn().mockResolvedValue([col("a"), col("b")]),
      checkDuplicateIndex: vi.fn(),
    },
  };
});

import { CreateIndexModal } from "../components/CreateIndexModal";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.mocked(api.checkDuplicateIndex).mockReset();
});

describe("CreateIndexModal 重複警告 (#1625)", () => {
  it("列を選ぶと順序つきで確認し、重なる既存インデックスを警告する", async () => {
    vi.mocked(api.checkDuplicateIndex).mockResolvedValue([{ name: "idx_a", kind: "duplicate" }]);
    renderWithProviders(
      <CreateIndexModal
        sessionId="s1"
        driver="mysql"
        database="db"
        table="t"
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
    const colA = await screen.findByLabelText("a");
    expect(api.checkDuplicateIndex).not.toHaveBeenCalled();
    fireEvent.click(colA);
    await waitFor(() => expect(screen.getByTestId("create-index-overlap")).toBeInTheDocument());
    expect(api.checkDuplicateIndex).toHaveBeenLastCalledWith("s1", "db", "t", ["a"], false);
    expect(screen.getByTestId("create-index-overlap")).toHaveTextContent(
      t("createIndexOverlapDuplicate", { name: "idx_a" }),
    );
  });

  it("重なりが無ければ警告を出さない", async () => {
    vi.mocked(api.checkDuplicateIndex).mockResolvedValue([]);
    renderWithProviders(
      <CreateIndexModal
        sessionId="s1"
        driver="postgres"
        database="db"
        table="t"
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByLabelText("a"));
    await waitFor(() => expect(api.checkDuplicateIndex).toHaveBeenCalled());
    expect(screen.queryByTestId("create-index-overlap")).toBeNull();
  });
});
