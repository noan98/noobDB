import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor, fireEvent } from "./testUtils";
import { t } from "../i18n";
import type { SandboxRecord, SandboxSchemaDiffResult, SandboxTableDiffResult } from "../api/tauri";

/**
 * サンドボックス書き戻しレビュー (#747) のスキーマ変更一覧 (#1008)。
 * `DiffStatus` の表示が `SchemaCompareView` と同じ `statusColors`
 * (`diffStatusColors.ts`) を共有していることを、状態ラベルが可視であること
 * を通じて固定する。色そのものの検証は `diffStatusColors.test.ts` が
 * 純ロジックとして担う。
 */

// `vi.mock` のファクトリはファイル先頭へ巻き上げられるため、参照するデータは
// `vi.hoisted` で一緒に巻き上げて宣言する (通常の `const` だと初期化前アクセスに
// なる)。
const { SCHEMA_DIFF, TABLE_DIFF } = vi.hoisted(() => ({
  SCHEMA_DIFF: {
    desired: {
      source_driver: "sqlite",
      target_driver: "sqlite",
      warnings: [],
      tables: [
        { name: "users", status: "different", columns: [] },
        { name: "orders", status: "same", columns: [] },
      ],
    },
    external_changed_tables: [],
    source_checked: true,
  } satisfies SandboxSchemaDiffResult,
  TABLE_DIFF: {
    desired: {
      target_driver: "sqlite",
      table: "users",
      columns: ["id"],
      column_types: ["INTEGER"],
      primary_key: ["id"],
      rows: [],
      truncated: false,
      source_count: 0,
      target_count: 0,
    },
    desired_diff_id: "diff-users",
    conflicts: [],
    source_checked: true,
    source_error: null,
  } satisfies SandboxTableDiffResult,
}));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      sandboxSchemaDiff: vi.fn().mockResolvedValue(SCHEMA_DIFF),
      sandboxTableDiff: vi.fn().mockResolvedValue(TABLE_DIFF),
      generateSyncSql: vi.fn().mockResolvedValue({ statements: [], warnings: [] }),
      generateDataSyncSql: vi.fn().mockResolvedValue({ statements: [], warnings: [] }),
      releaseDataDiffs: vi.fn().mockResolvedValue(undefined),
      sandboxResetTable: vi.fn().mockResolvedValue({ restored_rows: 3 }),
      applySyncSql: vi.fn().mockResolvedValue(1),
      sandboxAdvanceBase: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { SandboxReviewModal } from "../components/SandboxReviewModal";
import { api, type ConnectionProfile } from "../api/tauri";

const SANDBOX: SandboxRecord = {
  id: "sb1",
  name: "Sandbox 1",
  source_profile_id: "p1",
  source_driver: "sqlite",
  source_database: null,
  tables: ["users"],
  row_limit: 5000,
  file_path: "/tmp/sb1.sqlite",
  created_at: "2026-01-01T00:00:00Z",
  truncated_tables: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SandboxReviewModal のスキーマ変更表示 (#1008)", () => {
  it("DiffStatus のラベルを SchemaCompareView と同じ文言で表示する", async () => {
    renderWithProviders(
      <SandboxReviewModal sandbox={SANDBOX} sandboxSessionId="s1" openConnections={[]} onClose={() => {}} />,
    );

    // "same" のテーブルは一覧から除外され、"different" のテーブルだけが
    // 状態ラベル付きで表示される (SchemaCompareView の statusLabel と同じ i18n キー)。
    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());
    expect(screen.getByText(t("schemaCompareStatusDifferent"))).toBeInTheDocument();
    expect(screen.queryByText("orders")).not.toBeInTheDocument();
  });
});

/**
 * 差分のバックエンド保持 (#1259)。SQL 生成には差分そのものではなく `desired_diff_id` と
 * 競合「スキップ」の除外キーだけを送り、画面を閉じたら保持を解放する。
 */
describe("SandboxReviewModal のデータ差分 ID (#1259)", () => {
  const profile = { id: "p1", name: "src", driver: "sqlite" } as unknown as ConnectionProfile;

  it("生成時は差分 ID だけを送り、閉じると保持を解放する", async () => {
    vi.mocked(api.sandboxTableDiff).mockResolvedValue({
      ...TABLE_DIFF,
      desired: {
        ...TABLE_DIFF.desired,
        rows: [{ status: "source_only", key: [1], source: [1], target: null, changed_columns: [] }],
      },
    });
    const { unmount } = renderWithProviders(
      <SandboxReviewModal
        sandbox={SANDBOX}
        sandboxSessionId="s1"
        openConnections={[{ sessionId: "live", profile }]}
        onClose={() => {}}
      />,
    );
    const generate = await screen.findByText(t("sandboxReviewGenerate"));
    await waitFor(() => expect(generate.closest("button")).not.toBeDisabled());
    fireEvent.click(generate);
    await waitFor(() => expect(api.generateDataSyncSql).toHaveBeenCalledWith("diff-users", false, []));

    unmount();
    expect(api.releaseDataDiffs).toHaveBeenCalledWith(["diff-users"]);
  });

  it("削除許可を切り替えると生成済みの SQL が破棄される", async () => {
    vi.mocked(api.sandboxTableDiff).mockResolvedValue({
      ...TABLE_DIFF,
      desired: {
        ...TABLE_DIFF.desired,
        rows: [{ status: "source_only", key: [1], source: [1], target: null, changed_columns: [] }],
      },
    });
    renderWithProviders(
      <SandboxReviewModal
        sandbox={SANDBOX}
        sandboxSessionId="s1"
        openConnections={[{ sessionId: "live", profile }]}
        onClose={() => {}}
      />,
    );
    const generate = await screen.findByText(t("sandboxReviewGenerate"));
    await waitFor(() => expect(generate.closest("button")).not.toBeDisabled());
    fireEvent.click(generate);
    await screen.findByText(t("schemaCompareNoStatements"));
    fireEvent.click(screen.getByLabelText(t("schemaCompareAllowDelete")));
    await waitFor(() => expect(screen.queryByText(t("schemaCompareNoStatements"))).not.toBeInTheDocument());
  });

  it("実 DB 側の取得失敗を警告として表示する", async () => {
    vi.mocked(api.sandboxTableDiff).mockResolvedValue({
      ...TABLE_DIFF,
      desired: {
        ...TABLE_DIFF.desired,
        rows: [{ status: "source_only", key: [1], source: [1], target: null, changed_columns: [] }],
      },
      source_checked: false,
      source_error: "boom",
    });
    renderWithProviders(
      <SandboxReviewModal
        sandbox={SANDBOX}
        sandboxSessionId="s1"
        openConnections={[{ sessionId: "live", profile }]}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(t("sandboxReviewSourceError", { error: "boom" }))).toBeInTheDocument();
  });
});

/** 表単位のリセット (#1539)。確認のうえ API を呼び、完了後に差分を読み直す。 */
describe("SandboxReviewModal の表リセット (#1539)", () => {
  const changed = {
    ...TABLE_DIFF,
    desired: {
      ...TABLE_DIFF.desired,
      rows: [{ status: "source_only" as const, key: [1], source: [1], target: null, changed_columns: [] }],
    },
  };

  it("確認後に sandboxResetTable を呼んで差分を再読込する", async () => {
    vi.mocked(api.sandboxTableDiff).mockResolvedValue(changed);
    renderWithProviders(
      <SandboxReviewModal sandbox={SANDBOX} sandboxSessionId="s1" openConnections={[]} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByText(t("sandboxResetTable")));
    fireEvent.click(await screen.findByText(t("confirmDefaultOk")));
    await waitFor(() =>
      expect(api.sandboxResetTable).toHaveBeenCalledWith({
        sandboxId: "sb1",
        sandboxSessionId: "s1",
        table: "users",
      }),
    );
    await waitFor(() => expect(vi.mocked(api.sandboxTableDiff).mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByText(t("sandboxResetDone", { table: "users", rows: 3 }))).toBeInTheDocument();
  });

  it("確認をキャンセルしたら何も呼ばない", async () => {
    vi.mocked(api.sandboxTableDiff).mockResolvedValue(changed);
    renderWithProviders(
      <SandboxReviewModal sandbox={SANDBOX} sandboxSessionId="s1" openConnections={[]} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByText(t("sandboxResetTable")));
    fireEvent.click(await screen.findByText(t("confirmDefaultCancel")));
    await new Promise((r) => setTimeout(r, 50));
    expect(api.sandboxResetTable).not.toHaveBeenCalled();
  });
});

/** 適用後の結果表示と base 更新の部分失敗 (#1599)。 */
describe("SandboxReviewModal の適用結果 (#1599)", () => {
  const profile = { id: "p1", name: "src", driver: "sqlite" } as unknown as ConnectionProfile;
  const changed = {
    ...TABLE_DIFF,
    desired: {
      ...TABLE_DIFF.desired,
      rows: [{ status: "source_only" as const, key: [1], source: [1], target: null, changed_columns: [] }],
    },
  };

  async function generateAndApply() {
    vi.mocked(api.sandboxTableDiff).mockResolvedValue(changed);
    vi.mocked(api.generateDataSyncSql).mockResolvedValue({
      statements: [
        { sql: "INSERT INTO users VALUES (1)", table: "users", kind: "insert", destructive: false },
      ],
      warnings: [],
    } as never);
    renderWithProviders(
      <SandboxReviewModal
        sandbox={SANDBOX}
        sandboxSessionId="s1"
        openConnections={[{ sessionId: "live", profile }]}
        onClose={() => {}}
      />,
    );
    const generate = await screen.findByText(t("sandboxReviewGenerate"));
    await waitFor(() => expect(generate.closest("button")).not.toBeDisabled());
    fireEvent.click(generate);
    fireEvent.click(await screen.findByText(t("sandboxApplyTitle", { count: 1 })));
    fireEvent.click(await screen.findByText(t("confirmDefaultOk")));
  }

  it("適用成功の文言が再読込で消えずに表示される", async () => {
    await generateAndApply();
    expect(await screen.findByText(t("sandboxApplyDone", { count: 1 }))).toBeInTheDocument();
    expect(api.sandboxAdvanceBase).toHaveBeenCalled();
  });

  it("base 更新が失敗しても適用ボタンを残さず、再適用させない", async () => {
    vi.mocked(api.sandboxAdvanceBase).mockRejectedValueOnce(new Error("disk full"));
    await generateAndApply();
    expect(
      await screen.findByText(
        t("sandboxApplyBaseAdvanceFailed", { count: 1, tables: "users", error: "Error: disk full" }),
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(t("sandboxApplyTitle", { count: 1 }))).not.toBeInTheDocument(),
    );
  });
});

/** 適用ボタンの並び (#1615): 破壊的な文を含むときは「適用 → spacer → 閉じる」の破壊的パターン。 */
describe("SandboxReviewModal の適用ボタンの並び (#1615)", () => {
  const profile = { id: "p1", name: "src", driver: "sqlite" } as unknown as ConnectionProfile;
  const changed = {
    ...TABLE_DIFF,
    desired: {
      ...TABLE_DIFF.desired,
      rows: [{ status: "source_only" as const, key: [1], source: [1], target: null, changed_columns: [] }],
    },
  };

  async function generateWith(destructive: boolean) {
    vi.mocked(api.sandboxTableDiff).mockResolvedValue(changed);
    vi.mocked(api.generateDataSyncSql).mockResolvedValue({
      statements: [{ sql: "DELETE FROM users WHERE id = 1", table: "users", kind: "delete", destructive }],
      warnings: [],
    } as never);
    renderWithProviders(
      <SandboxReviewModal
        sandbox={SANDBOX}
        sandboxSessionId="s1"
        openConnections={[{ sessionId: "live", profile }]}
        onClose={() => {}}
      />,
    );
    const generate = await screen.findByText(t("sandboxReviewGenerate"));
    await waitFor(() => expect(generate.closest("button")).not.toBeDisabled());
    fireEvent.click(generate);
    const apply = (await screen.findByText(t("sandboxApplyTitle", { count: 1 }))).closest(
      "button",
    ) as HTMLElement;
    const close = screen.getByText(t("sandboxReviewClose"), { selector: "button" });
    return { apply, close };
  }

  it("破壊的な文を含むと適用が閉じるより左に来る", async () => {
    const { apply, close } = await generateWith(true);
    expect(apply.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("破壊的でなければ従来どおり閉じるが左、適用が右", async () => {
    const { apply, close } = await generateWith(false);
    expect(close.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
