import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { t } from "../i18n";

/** CreateIndexModal の UNIQUE 重複データ事前検査 (#1757)。 */
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
      runLookupQuery: vi.fn(),
    },
  };
});

import { CreateIndexModal } from "../components/CreateIndexModal";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.mocked(api.checkDuplicateIndex).mockReset().mockResolvedValue([]);
  vi.mocked(api.runLookupQuery).mockReset();
});

function renderModal(onSendToEditor: (sql: string) => void = () => {}) {
  return renderWithProviders(
    <CreateIndexModal
      sessionId="s1"
      driver="sqlite"
      database="main"
      table="t"
      readOnly={true}
      onRun={() => {}}
      onSendToEditor={onSendToEditor}
      onClose={() => {}}
    />,
  );
}

describe("CreateIndexModal UNIQUE 事前検査 (#1757)", () => {
  it("UNIQUE で重複データがあれば件数と該当行ボタンを出す (read_only でも COUNT は回る)", async () => {
    vi.mocked(api.runLookupQuery).mockResolvedValue({ rows: [[3]] } as never);
    const onSend = vi.fn();
    renderModal(onSend);
    fireEvent.click(await screen.findByLabelText("a"));
    expect(api.runLookupQuery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(t("createTableColUnique")));
    const warning = await screen.findByTestId("alter-precheck-warning");
    expect(warning).toHaveTextContent(t("alterPrecheckDuplicateUnique", { count: 3 }));
    expect(vi.mocked(api.runLookupQuery).mock.calls[0][0].sql).toContain("HAVING COUNT(*) > 1");
    fireEvent.click(screen.getByRole("button", { name: t("alterPrecheckOpenRows") }));
    expect(onSend.mock.calls[0][0]).toMatch(/^SELECT \* FROM "main"."t" WHERE/);
  });

  it("違反 0 件なら警告を出さない", async () => {
    vi.mocked(api.runLookupQuery).mockResolvedValue({ rows: [[0]] } as never);
    renderModal();
    fireEvent.click(await screen.findByLabelText("a"));
    fireEvent.click(screen.getByLabelText(t("createTableColUnique")));
    await screen.findByTestId("alter-precheck-ok");
    expect(screen.queryByTestId("alter-precheck-warning")).toBeNull();
  });
});
