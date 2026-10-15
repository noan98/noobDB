import { describe, expect, it } from "vitest";
import {
  allColumnsExcluded,
  buildTransferColumnSpecs,
  defaultColumnDraft,
  defaultTransferTableName,
  parseLimitRows,
  makeTransferStreamId,
  pickDefaultDatabase,
  toDriverKind,
  transferConfirmSteps,
  validateTransferTarget,
  writesExistingTable,
  type TransferSource,
} from "../components/dataTransfer";

const tableSource: TransferSource = { kind: "table", database: "app", table: "orders" };
const querySource: TransferSource = { kind: "query", database: "app", sql: "SELECT 1" };

describe("接続間データ転送 (#986) の純ロジック", () => {
  it("既定のテーブル名はテーブル転送なら同名、クエリ結果なら query_result", () => {
    expect(defaultTransferTableName(tableSource)).toBe("orders");
    expect(defaultTransferTableName(querySource)).toBe("query_result");
  });

  it("ドライバ文字列を DriverKind に絞る", () => {
    expect(toDriverKind("mysql")).toBe("mysql");
    expect(toDriverKind("postgres")).toBe("postgres");
    expect(toDriverKind("sqlite")).toBe("sqlite");
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

    it("upsert は append と同じく既存テーブルが必要 (#1539)", () => {
      expect(validateTransferTarget({ ...base, mode: "upsert" })).toBe("tableMissing");
      expect(validateTransferTarget({ ...base, tableName: "orders", mode: "upsert" })).toBeNull();
      expect(writesExistingTable("upsert")).toBe(true);
      expect(writesExistingTable("append")).toBe(true);
      expect(writesExistingTable("create")).toBe(false);
      expect(writesExistingTable("replace")).toBe(false);
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
      // クエリ元は、同名のテーブルを読まない限り対象外
      expect(
        validateTransferTarget({ ...same, mode: "replace", source: querySource, tableName: "orders" }),
      ).toBeNull();
    });

    it("クエリ元が転送先と同名のテーブルを読むなら置き換えを拒否 (#1598)", () => {
      const q = (sql: string): TransferSource => ({ kind: "query", database: "app", sql });
      const same = { ...base, sameProfileAndDatabase: true, tableName: "users", mode: "replace" as const };
      expect(validateTransferTarget({ ...same, source: q("SELECT * FROM users WHERE active = 1") })).toBe(
        "queryReadsTarget",
      );
      expect(validateTransferTarget({ ...same, source: q("SELECT * FROM `app`.`Users`") })).toBe(
        "queryReadsTarget",
      );
      // 別 DB を修飾して読むクエリは、転送先 DB が違っても (同じプロファイルなら) 拒否
      expect(
        validateTransferTarget({
          ...same,
          sameProfileAndDatabase: false,
          sameProfile: true,
          source: q("SELECT * FROM shop.users"),
        }),
      ).toBe("queryReadsTarget");
      // コメント・文字列リテラル・前方一致の別名は読み取り元ではない
      expect(
        validateTransferTarget({ ...same, source: q("SELECT 'users' /* users */ FROM users_old") }),
      ).toBeNull();
      // 別接続・別 DB なら問題ない
      expect(
        validateTransferTarget({ ...same, sameProfileAndDatabase: false, source: q("SELECT * FROM users") }),
      ).toBeNull();
    });

    it("PostgreSQL は大文字小文字違いを別テーブルとして扱う (#1598)", () => {
      const same = { ...base, sameProfileAndDatabase: true, mode: "replace" as const };
      const src: TransferSource = { kind: "table", database: "app", table: "users" };
      expect(
        validateTransferTarget({ ...same, source: src, tableName: "Users", targetDriver: "postgres" }),
      ).toBeNull();
      expect(
        validateTransferTarget({ ...same, source: src, tableName: "users", targetDriver: "postgres" }),
      ).toBe("sameTable");
      expect(
        validateTransferTarget({ ...same, source: src, tableName: "Users", targetDriver: "mysql" }),
      ).toBe("sameTable");
    });
  });

  describe("transferConfirmSteps", () => {
    it("非本番の新規作成・追記は確認なし", () => {
      expect(transferConfirmSteps({ mode: "create", tableExists: false, isProduction: false })).toEqual([]);
      expect(transferConfirmSteps({ mode: "append", tableExists: true, isProduction: false })).toEqual([]);
      expect(transferConfirmSteps({ mode: "upsert", tableExists: true, isProduction: false })).toEqual([]);
      // 本番への upsert は書き込みの確認 (DROP を伴わないので強確認ではない)。
      expect(transferConfirmSteps({ mode: "upsert", tableExists: true, isProduction: true })).toEqual([
        "production",
      ]);
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

describe("列の選択・改名・型上書きと試験転送 (#1623)", () => {
  const cols = [{ name: "id" }, { name: "secret" }, { name: "flag" }];

  it("既定のままの列は指定に含めない (指定が空なら従来どおり全列)", () => {
    expect(buildTransferColumnSpecs(cols, {})).toEqual([]);
    expect(buildTransferColumnSpecs(cols, { id: defaultColumnDraft() })).toEqual([]);
  });

  it("除外・改名・型上書きを列指定にする。改名は前後の空白を除き、同名なら無視", () => {
    const specs = buildTransferColumnSpecs(cols, {
      id: { ...defaultColumnDraft(), name: "  id " },
      secret: { ...defaultColumnDraft(), include: false },
      flag: { ...defaultColumnDraft(), name: " is_on ", type: "integer" },
    });
    expect(specs).toEqual([
      { source: "secret", exclude: true },
      { source: "flag", name: "is_on", type: { kind: "integer" } },
    ]);
  });

  it("decimal は精度と小数桁を載せる", () => {
    const specs = buildTransferColumnSpecs(cols, {
      id: { ...defaultColumnDraft(), type: "decimal", precision: 20, scale: 4 },
    });
    expect(specs).toEqual([{ source: "id", type: { kind: "decimal", precision: 20, scale: 4 } }]);
  });

  it("全列を外したら検出する (ソース列が未取得のときは対象外)", () => {
    expect(allColumnsExcluded([], {})).toBe(false);
    expect(allColumnsExcluded(cols, {})).toBe(false);
    const off = { ...defaultColumnDraft(), include: false };
    expect(allColumnsExcluded(cols, { id: off, secret: off, flag: off })).toBe(true);
    expect(allColumnsExcluded(cols, { id: off, secret: off })).toBe(false);
  });

  it("試験転送の行数は正の整数だけ受け付ける", () => {
    expect(parseLimitRows("100")).toBe(100);
    expect(parseLimitRows(" 5 ")).toBe(5);
    for (const bad of ["", "0", "-1", "1.5", "abc", "1e3", "99999999999999999999"]) {
      expect(parseLimitRows(bad), bad).toBeNull();
    }
  });
});
