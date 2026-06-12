import { describe, it, expect, vi, beforeEach } from "vitest";

// IPC レスポンスのランタイム型検証。`@tauri-apps/api/core` の `invoke` を
// モックして、Rust から返ってきたと想定する生の値を `api.*` ラッパーに流し込み、
// (1) 正常な形なら解決する、(2) Rust 側の型がズレた壊れた形なら reject する、
// ことを確認する。スキーマ単体の正常/異常判定も併せて検証する。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { api } from "../api/tauri";
import {
  queryResult,
  connectionProfile,
  historyEntry,
  parseResponse,
} from "../api/schemas";

const mockInvoke = vi.mocked(invoke);

const VALID_QUERY_RESULT = {
  columns: [{ name: "id", type_name: "INT" }],
  rows: [[1, "alice"]],
  rows_affected: 0,
  elapsed_ms: 3,
};

describe("IPC ランタイム型検証 (#391)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("正常な QueryResult はそのまま解決する", async () => {
    mockInvoke.mockResolvedValueOnce(VALID_QUERY_RESULT);
    await expect(api.runQuery("s", "select 1")).resolves.toEqual(VALID_QUERY_RESULT);
  });

  it("Rust 側の型がズレた壊れたレスポンスは reject する (rows_affected が文字列)", async () => {
    mockInvoke.mockResolvedValueOnce({
      columns: [],
      rows: [],
      rows_affected: "0", // Rust 側で型が変わったことを模した不整合
      elapsed_ms: 3,
    });
    await expect(api.runQuery("s", "select 1")).rejects.toThrow(/run_query/);
  });

  it("必須フィールドが欠落していると reject する", async () => {
    mockInvoke.mockResolvedValueOnce({ columns: [], rows: [] });
    await expect(api.runQueryTransaction("s", ["select 1"])).rejects.toThrow(
      /run_query_transaction/,
    );
  });

  it("配列レスポンスの要素が壊れていると reject する", async () => {
    mockInvoke.mockResolvedValueOnce([{ name: "t", columns: "not-an-array" }]);
    await expect(api.schemaOverview("s", "db")).rejects.toThrow(/schema_overview/);
  });

  it("未知のフィールドは黙って捨てて前方互換を保つ", async () => {
    mockInvoke.mockResolvedValueOnce({
      ...VALID_QUERY_RESULT,
      future_field: 42, // バックエンドが将来追加したフィールド
    });
    const result = await api.runQuery("s", "select 1");
    expect(result).not.toHaveProperty("future_field");
    expect(result.rows_affected).toBe(0);
  });
});

describe("Zod スキーマ単体 (#391)", () => {
  it("queryResult は正常/異常を正しく判定する", () => {
    expect(queryResult.safeParse(VALID_QUERY_RESULT).success).toBe(true);
    expect(queryResult.safeParse({ columns: [] }).success).toBe(false);
    expect(
      queryResult.safeParse({ ...VALID_QUERY_RESULT, elapsed_ms: "3" }).success,
    ).toBe(false);
  });

  it("connectionProfile は has_* オプショナルフラグを許容する", () => {
    const base = {
      id: "abc",
      name: "Local",
      driver: "mysql",
      host: "127.0.0.1",
      port: 3306,
      user: "root",
      database: null,
      ssh: null,
      group: null,
      color: null,
      is_production: false,
      confirm_writes: false,
      read_only: false,
      skip_history: false,
      file_path: null,
    };
    expect(connectionProfile.safeParse(base).success).toBe(true);
    expect(
      connectionProfile.safeParse({ ...base, has_db_password: true }).success,
    ).toBe(true);
    // port が文字列だと不正
    expect(connectionProfile.safeParse({ ...base, port: "3306" }).success).toBe(
      false,
    );
  });

  it("historyEntry は nullable な数値フィールドを許容する", () => {
    const entry = {
      id: 1,
      profile_id: null,
      driver: "sqlite",
      database: null,
      sql: "select 1",
      rows: null,
      rows_affected: null,
      elapsed_ms: null,
      status: "ok",
      error: null,
      executed_at: "2026-01-01T00:00:00Z",
    };
    expect(historyEntry.safeParse(entry).success).toBe(true);
    expect(historyEntry.safeParse({ ...entry, status: 200 }).success).toBe(false);
  });

  it("parseResponse はコマンド名を含むエラーを投げる", () => {
    expect(() =>
      parseResponse(queryResult, { columns: [] }, "boom"),
    ).toThrow(/boom/);
  });
});
