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
        rows: [
          { status: "source_only", key: [1], source: [1], target: null, changed_columns: [] },
        ],
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
    await waitFor(() =>
      expect(api.generateDataSyncSql).toHaveBeenCalledWith("diff-users", false, []),
    );

    unmount();
    expect(api.releaseDataDiffs).toHaveBeenCalledWith(["diff-users"]);
  });
});
