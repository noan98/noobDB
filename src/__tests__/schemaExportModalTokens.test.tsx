import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderWithProviders, screen, waitFor } from "./testUtils";

const describeDatabase = vi.fn();
const foreignKeys = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/dl"),
  join: vi.fn(async (...p: string[]) => p.join("/")),
}));
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeDatabase: (...a: unknown[]) => describeDatabase(...a),
      foreignKeys: (...a: unknown[]) => foreignKeys(...a),
      listTableComments: vi.fn().mockResolvedValue([]),
    },
  };
});

import { SchemaExportModal } from "../components/SchemaExportModal";

function col(name: string) {
  return {
    name,
    data_type: "int",
    nullable: false,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  };
}

describe("SchemaExportModal 概算トークン (#1620)", () => {
  beforeEach(() => {
    cleanup();
    describeDatabase.mockReset();
    foreignKeys.mockReset();
  });

  it("コピー前に概算トークン数を表示する", async () => {
    describeDatabase.mockResolvedValue([{ name: "users", columns: [col("id")] }]);
    foreignKeys.mockResolvedValue([]);
    renderWithProviders(<SchemaExportModal sessionId="s" database="db" driver="mysql" onClose={vi.fn()} />);
    const el = await screen.findByTestId("schema-export-tokens");
    expect(el.textContent).toMatch(/\d/);
    expect(el.getAttribute("data-level")).toBe("ok");
    expect(screen.queryByTestId("schema-export-token-callout")).toBeNull();
  });

  it("巨大なスキーマでは上限の警告 Callout を出す", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `t${i}`,
      columns: Array.from({ length: 400 }, (_, j) => col(`column_name_${j}`)),
    }));
    describeDatabase.mockResolvedValue(many);
    foreignKeys.mockResolvedValue([]);
    renderWithProviders(<SchemaExportModal sessionId="s" database="db" driver="mysql" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("schema-export-tokens").getAttribute("data-level")).not.toBe("ok"),
    );
    expect(screen.getByTestId("schema-export-token-callout")).toBeTruthy();
  });
});
