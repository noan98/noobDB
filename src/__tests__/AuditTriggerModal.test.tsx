import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { setLocale, t } from "../i18n";

// 変更履歴 (監査) トリガーの生成ウィザード (#2305)。

const generate = vi.fn();
const statusMock = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeTable: () =>
        Promise.resolve([
          { name: "id", data_type: "int", nullable: false, key: "PRI", default: null, extra: "" },
          { name: "email", data_type: "text", nullable: true, key: "", default: null, extra: "" },
        ]),
      getAuditStatus: (...a: unknown[]) => statusMock(...a),
      generateAuditDdl: (...a: unknown[]) => generate(...a),
    },
  };
});

import { AuditTriggerModal } from "../components/AuditTriggerModal";

const NO_AUDIT = {
  present: false,
  options: null,
  recorded_columns: [],
  added_columns: [],
  removed_columns: [],
  pk_changed: false,
  needs_regeneration: false,
};

function ddl(create: string[]) {
  return {
    audit_table: "users_audit",
    audit_schema: "public",
    create,
    drop_triggers: ["DROP TRIGGER IF EXISTS x"],
    drop_table: "DROP TABLE IF EXISTS users_audit",
    recorded_columns: ["id"],
    trigger_names: ["x"],
    warnings: ["no_primary_key"],
  };
}

function setup(readOnly = false) {
  const onConfirm = vi.fn();
  renderWithProviders(
    <AuditTriggerModal
      sessionId="s1"
      database="public"
      table="users"
      driver="postgres"
      readOnly={readOnly}
      maskPatterns={["email"]}
      initialMode="create"
      onConfirm={onConfirm}
      onClose={() => {}}
    />,
  );
  return { onConfirm };
}

describe("AuditTriggerModal", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
    statusMock.mockResolvedValue(NO_AUDIT);
    generate.mockResolvedValue(ddl(["CREATE TABLE a (x int)", "CREATE TRIGGER t"]));
  });

  it("マスク対象の列は既定で除外して DDL を生成し、確定で文の配列を渡す", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(generate.mock.calls[0][3]).toMatchObject({ exclude_columns: ["email"], insert: true });
    await waitFor(() =>
      expect(screen.getByTestId("sql-preview")).toHaveTextContent(/CREATE TABLE a \(x int\);/),
    );
    expect(screen.getByText(t("auditWarnNoPk"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("auditConfirmCreate") }));
    expect(onConfirm).toHaveBeenCalledWith(["CREATE TABLE a (x int)", "CREATE TRIGGER t"], {
      mode: "create",
      auditTable: "users_audit",
      dropsTable: false,
    });
  });

  it("操作の選択に合わせて流れの図と見本が変わり、除外列は打ち消し線で示す (#2324)", async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(screen.getByTestId("audit-sample")).toBeInTheDocument());
    expect(screen.getByTestId("audit-flow-diagram")).toBeInTheDocument();
    expect(screen.getAllByTestId("audit-op-chip-insert")[0]).toHaveAttribute("data-tone", "success");
    expect(screen.getByTestId("audit-sample-card-update")).toBeInTheDocument();
    expect(screen.getByTestId("audit-sample-skip-badge")).toBeInTheDocument();
    // email はマスク対象で既定除外。
    expect(screen.getAllByTestId("audit-sample-cell-email")[0]).toHaveAttribute("data-excluded", "true");
    expect(screen.getAllByTestId("audit-sample-cell-id")[0]).toHaveAttribute("data-excluded", "false");
    await user.click(screen.getByRole("checkbox", { name: "DELETE" }));
    await waitFor(() => expect(screen.queryByTestId("audit-sample-card-delete")).not.toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", { name: t("auditSkipUnchanged") }));
    expect(screen.queryByTestId("audit-sample-skip-badge")).not.toBeInTheDocument();
  });

  it("read_only では確定できない", async () => {
    setup(true);
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: t("auditConfirmCreate") })).toBeDisabled();
  });

  it("既に監査がある表では再生成として開き、列の変化を警告する", async () => {
    statusMock.mockResolvedValue({
      present: true,
      options: {
        insert: true,
        update: true,
        delete: false,
        exclude_columns: [],
        skip_unchanged_update: true,
        audit_table: "users_audit",
        audit_schema: "public",
      },
      recorded_columns: ["id"],
      added_columns: ["email"],
      removed_columns: [],
      pk_changed: false,
      needs_regeneration: true,
    });
    setup();
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(generate.mock.calls[0][4]).toBe(true);
    // 再生成で増えたマスク対象の列 (email) は既定で除外される。
    expect(generate.mock.calls[0][3]).toMatchObject({ delete: false, exclude_columns: ["email"] });
    expect(await screen.findByRole("button", { name: t("auditConfirmRegenerate") })).toBeEnabled();
  });

  it("作成時のオプションを読み戻せない既存の監査は、自動で再生成にせず表名を編集できる", async () => {
    statusMock.mockResolvedValue({ ...NO_AUDIT, present: true });
    setup();
    expect(await screen.findByText(t("auditLegacy"))).toBeInTheDocument();
    // 初期モードは作成のまま (勝手に再生成・削除しない)。表名は編集できる。
    expect(screen.getByLabelText(t("auditTableName"))).toBeEnabled();
    expect(screen.getByRole("button", { name: t("auditConfirmCreate") })).toBeInTheDocument();
  });

  it("オプションを変えた直後は、前の結果を確定できない (再生成の結果が来るまで無効)", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await waitFor(() => expect(screen.getByRole("button", { name: t("auditConfirmCreate") })).toBeEnabled());
    // 次の生成を保留にして、除外列 (email) を外す。
    generate.mockImplementation(() => new Promise(() => {}));
    await user.click(screen.getByRole("checkbox", { name: "email" }));
    expect(screen.getByRole("button", { name: t("auditConfirmCreate") })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: t("auditConfirmCreate") }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
