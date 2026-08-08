import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import { makeProfile } from "./fixtures/componentFixtures";
import type { SchemaDriftState, SchemaGeneration } from "../schemaDrift";

/**
 * スキーマドリフト・タイムライン (#736) の失敗表示統一 (#848)。2 世代間の
 * 差分計算 (`api.diffSchemaSnapshots`) が失敗した場合、裸の赤テキストではなく
 * compact な共有 `EmptyState` (タイトル + 再試行ボタン) で表示され、ボタンで
 * 再度呼ばれることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      diffSchemaSnapshots: vi.fn(),
    },
  };
});

import { SchemaDriftPanel } from "../components/SchemaDriftPanel";
import { api } from "../api/tauri";

function makeGeneration(id: string, capturedAt: string): SchemaGeneration {
  return {
    id,
    capturedAt,
    driver: "mysql",
    database: "appdb",
    fingerprint: `fp-${id}`,
    tableCount: 1,
    payload: {
      driver: "mysql",
      database: "appdb",
      tables: [
        {
          name: "users",
          columns: [
            {
              name: "id",
              data_type: "int",
              nullable: false,
              key: "PRI",
              default: null,
              extra: "",
              referenced_table: null,
              referenced_column: null,
            },
          ],
          indexes: [],
        },
      ],
    },
    omitted: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SchemaDriftPanel error state (#848)", () => {
  it("shows the shared EmptyState title on compare failure, and retries on click", async () => {
    vi.mocked(api.diffSchemaSnapshots).mockRejectedValueOnce(new Error("request failed"));

    const state: SchemaDriftState = {
      generations: [
        makeGeneration("g2", "2026-01-02T00:00:00Z"),
        makeGeneration("g1", "2026-01-01T00:00:00Z"),
      ],
    };

    renderWithProviders(
      <SchemaDriftPanel
        profile={makeProfile()}
        state={state}
        canCapture={false}
        capturing={false}
        onCapture={() => {}}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Error: request failed")).toBeInTheDocument();
    });
    expect(api.diffSchemaSnapshots).toHaveBeenCalledTimes(1);

    vi.mocked(api.diffSchemaSnapshots).mockResolvedValueOnce({
      source_driver: "mysql",
      target_driver: "mysql",
      tables: [],
    });
    fireEvent.click(screen.getByRole("button", { name: t("schemaDriftRetry") }));

    await waitFor(() => {
      expect(api.diffSchemaSnapshots).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(t("schemaDriftNoChanges"))).toBeInTheDocument();
    });
  });
});
