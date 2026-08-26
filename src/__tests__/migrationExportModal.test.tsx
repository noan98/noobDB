import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import type { SyncPlan } from "../api/tauri";

/**
 * マイグレーションエクスポートモーダル (#744)。マウント時に down 方向のプラン
 * (`compare_schema` → `generate_sync_sql` をソース/ターゲット入れ替えで再実行)
 * を取得するため `api` をモックする。保存はダイアログ (`@tauri-apps/plugin-dialog`)
 * と `@tauri-apps/api/path` を経由するのでこれらもモックする。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      compareSchema: vi.fn(),
      generateSyncSql: vi.fn(),
      writeBinaryFile: vi.fn(),
    },
  };
});

vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/home/user/Downloads"),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join("/"))),
  dirname: vi.fn((p: string) => Promise.resolve(p.split("/").slice(0, -1).join("/"))),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue("/home/user/Downloads/mig.sql"),
}));

import { api } from "../api/tauri";
import { MigrationExportModal } from "../components/MigrationExportModal";

const compareSchema = api.compareSchema as ReturnType<typeof vi.fn>;
const generateSyncSql = api.generateSyncSql as ReturnType<typeof vi.fn>;
const writeBinaryFile = api.writeBinaryFile as ReturnType<typeof vi.fn>;

const UP_PLAN: SyncPlan = {
  statements: [
    { sql: "CREATE TABLE t (id INT)", table: "t", kind: "create_table", destructive: false },
  ],
  warnings: [],
};

const DOWN_PLAN: SyncPlan = {
  statements: [
    { sql: "DROP TABLE t", table: "t", kind: "drop_table", destructive: true },
  ],
  warnings: ["sqlite cannot alter columns in place: t.c"],
};

function renderModal(onClose = () => {}) {
  return renderWithProviders(
    <MigrationExportModal
      plan={UP_PLAN}
      allowDestructive={true}
      sourceSessionId="s-src"
      sourceDatabase="shop_staging"
      sourceProfile={makeProfile({ id: "p-src", name: "Staging" })}
      targetSessionId="s-tgt"
      targetDatabase="shop_prod"
      targetProfile={makeProfile({ id: "p-tgt", name: "Prod" })}
      onClose={onClose}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  compareSchema.mockResolvedValue({ source_driver: "mysql", target_driver: "mysql", tables: [] });
  generateSyncSql.mockResolvedValue(DOWN_PLAN);
  writeBinaryFile.mockResolvedValue(42);
});

describe("MigrationExportModal render smoke (#744)", () => {
  it("mounts as a dialog and shows the title", async () => {
    renderModal();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("schemaCompareMigrationTitle"))).toBeInTheDocument();
    await waitFor(() => expect(generateSyncSql).toHaveBeenCalled());
  });

  it("invokes onClose from the header close control", () => {
    const onClose = vi.fn();
    renderModal(onClose);
    fireEvent.click(screen.getByRole("button", { name: t("schemaCompareClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("compares schema with source/target swapped to compute the down plan", async () => {
    renderModal();
    await waitFor(() =>
      expect(compareSchema).toHaveBeenCalledWith({
        sourceSessionId: "s-tgt",
        sourceDatabase: "shop_prod",
        targetSessionId: "s-src",
        targetDatabase: "shop_staging",
      }),
    );
    await waitFor(() => expect(generateSyncSql).toHaveBeenCalledWith(expect.anything(), true));
  });

  it("shows the up/down statement + warning summary once the down plan is ready", async () => {
    renderModal();
    await waitFor(() =>
      expect(
        screen.getByText(t("schemaCompareMigrationSummary", { upCount: 1, downCount: 1, warnings: 1 })),
      ).toBeInTheDocument(),
    );
  });

  it("writes both up and down files on save", async () => {
    renderModal();
    // 保存ボタンは down プランが ready になるまで disabled で、handleSave も
    // `downState.kind !== "ready"` なら即 return する。`generateSyncSql` が
    // 「呼ばれた」ことだけを待つと、状態が ready に確定する前にクリックして
    // しまい何も起きない (CI で実際に発生した競合)。実際の前提条件である
    // 「保存ボタンが有効になったこと」を待ってからクリックする。
    const saveButton = await waitFor(() => {
      const btn = screen.getByRole("button", { name: t("schemaCompareMigrationSave") });
      expect(btn).toBeEnabled();
      return btn;
    });
    fireEvent.click(saveButton);
    await waitFor(() => expect(writeBinaryFile).toHaveBeenCalledTimes(2));
    const [upPath, upBytes] = writeBinaryFile.mock.calls[0];
    const [downPath, downBytes] = writeBinaryFile.mock.calls[1];
    expect(upPath).toContain("shop_staging_to_shop_prod");
    expect(downPath).toContain("shop_staging_to_shop_prod");
    expect(new TextDecoder().decode(upBytes)).toContain("CREATE TABLE t (id INT);");
    expect(new TextDecoder().decode(downBytes)).toContain("DROP TABLE t;");
    expect(new TextDecoder().decode(downBytes)).toContain("sqlite cannot alter columns in place");
  });
});
