import { describe, expect, it } from "vitest";
import {
  defaultTransferTableName,
  makeTransferStreamId,
  pickDefaultDatabase,
  toDriverKind,
  transferConfirmSteps,
  validateTransferTarget,
  type TransferSource,
} from "../components/dataTransfer";

const tableSource: TransferSource = { kind: "table", database: "app", table: "orders" };
const querySource: TransferSource = { kind: "query", database: "app", sql: "SELECT 1" };

describe("接続間データ転送 (#986) の純ロジック", () => {
  it("既定のテーブル名はテーブル転送なら同名、クエリ結果なら query_result", () => {
    expect(defaultTransferTableName(tableSource)).toBe("orders");
    expect(defaultTransferTableName(querySource)).toBe("query_result");
  });

  it("ドライバ文字列を DriverKind に絞る (DuckDB / MSSQL も落とさない)", () => {
    expect(toDriverKind("duckdb")).toBe("duckdb");
    expect(toDriverKind("mssql")).toBe("mssql");
    expect(toDriverKind("oracle")).toBeNull();
  });

  it("既定 DB はプロファイルの DB が一覧にあればそれ、無ければ先頭", () => {
    expect(pickDefaultDatabase(["a", "b"], "b")).toBe("b");
    expect(pickDefaultDatabase(["a", "b"], "zzz")).toBe("a");
    expect(pickDefaultDatabase([], null)).toBeNull();
  });

  describe("validateTransferTarget", () => {
    const base = {
      tableName: "orders_copy",
      mode: "create" as const,
      existingTables: ["orders", "Customers"],
      sameProfileAndDatabase: false,
      source: tableSource,
    };

    it("空のテーブル名は不可", () => {
      expect(validateTransferTarget({ ...base, tableName: "  " })).toBe("tableEmpty");
    });

    it("create で同名 (大小無視) があれば衝突としてユーザに選ばせる", () => {
      expect(validateTransferTarget({ ...base, tableName: "customers" })).toBe("tableExists");
      expect(validateTransferTarget(base)).toBeNull();
    });

    it("replace は既存があっても可、append は既存が必要", () => {
      expect(validateTransferTarget({ ...base, tableName: "orders", mode: "replace" })).toBeNull();
      expect(validateTransferTarget({ ...base, mode: "append" })).toBe("tableMissing");
      expect(validateTransferTarget({ ...base, tableName: "orders", mode: "append" })).toBeNull();
    });

    it("一覧が未取得なら衝突判定はしない (バックエンドが最終判定)", () => {
      expect(validateTransferTarget({ ...base, tableName: "orders", existingTables: null })).toBeNull();
    });

    it("同じ接続・同じ DB の同じテーブルへの作り直しは拒否 (ソースを消してしまう)", () => {
      const same = { ...base, sameProfileAndDatabase: true, tableName: "ORDERS" };
      expect(validateTransferTarget({ ...same, mode: "replace" })).toBe("sameTable");
      expect(validateTransferTarget({ ...same, mode: "create" })).toBe("sameTable");
      // 追記は自己コピー (行の複製) として許す
      expect(validateTransferTarget({ ...same, mode: "append" })).toBeNull();
      // クエリ結果の転送は対象外
      expect(
        validateTransferTarget({ ...same, mode: "replace", source: querySource, tableName: "orders" }),
      ).toBeNull();
    });
  });

  describe("transferConfirmSteps", () => {
    it("非本番の新規作成・追記は確認なし", () => {
      expect(transferConfirmSteps({ mode: "create", tableExists: false, isProduction: false })).toEqual([]);
      expect(transferConfirmSteps({ mode: "append", tableExists: true, isProduction: false })).toEqual([]);
    });

    it("既存テーブルの置き換えは常に確認、本番ならタイプ入力の強確認", () => {
      expect(transferConfirmSteps({ mode: "replace", tableExists: true, isProduction: false })).toEqual([
        "replace",
      ]);
      expect(transferConfirmSteps({ mode: "replace", tableExists: true, isProduction: true })).toEqual([
        "productionTyped",
      ]);
    });

    it("本番接続への書き込みは warning 確認 (置き換え先が無ければ通常の本番確認)", () => {
      expect(transferConfirmSteps({ mode: "create", tableExists: false, isProduction: true })).toEqual([
        "production",
      ]);
      expect(transferConfirmSteps({ mode: "replace", tableExists: false, isProduction: true })).toEqual([
        "production",
      ]);
    });
  });

  it("stream id は呼び出しごとに一意", () => {
    expect(makeTransferStreamId()).not.toBe(makeTransferStreamId());
  });
});
