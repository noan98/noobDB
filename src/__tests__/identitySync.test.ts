import { describe, expect, it } from "vitest";
import type { TableColumnInfo } from "../api/tauri";
import {
  buildIdentitySyncSql,
  findIdentityColumn,
  mysqlMaxValueSql,
  parseMaxValue,
} from "../components/identitySync";

function col(over: Partial<TableColumnInfo> & { name: string }): TableColumnInfo {
  return {
    data_type: "text",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  };
}

describe("findIdentityColumn", () => {
  it("MySQL は extra に auto_increment を含む列を返す", () => {
    const cols = [
      col({ name: "id", data_type: "int", key: "PRI", extra: "auto_increment" }),
      col({ name: "name" }),
    ];
    expect(findIdentityColumn("mysql", cols)).toBe("id");
  });

  it("MySQL で auto_increment 列が無ければ null", () => {
    expect(findIdentityColumn("mysql", [col({ name: "id", key: "PRI", data_type: "int" })])).toBeNull();
  });

  it("PostgreSQL は整数の単一列 PK (serial / identity) を返す", () => {
    expect(
      findIdentityColumn("postgres", [
        col({ name: "id", data_type: "integer", key: "PRI", default: "nextval('t_id_seq'::regclass)" }),
      ]),
    ).toBe("id");
    expect(
      findIdentityColumn("postgres", [col({ name: "id", data_type: "bigint", key: "PRI" })]),
    ).toBe("id");
  });

  it("PostgreSQL の text PK・複合 PK・PK 無しは null", () => {
    expect(findIdentityColumn("postgres", [col({ name: "code", key: "PRI" })])).toBeNull();
    expect(
      findIdentityColumn("postgres", [
        col({ name: "a", data_type: "integer", key: "PRI" }),
        col({ name: "b", data_type: "integer", key: "PRI" }),
      ]),
    ).toBeNull();
    expect(findIdentityColumn("postgres", [col({ name: "n", data_type: "integer" })])).toBeNull();
  });

  it("SQLite は INTEGER の単一列 PK のみ", () => {
    expect(findIdentityColumn("sqlite", [col({ name: "id", data_type: "INTEGER", key: "PRI" })])).toBe("id");
    expect(findIdentityColumn("sqlite", [col({ name: "id", data_type: "TEXT", key: "PRI" })])).toBeNull();
    expect(findIdentityColumn("sqlite", [col({ name: "id", data_type: "INTEGER" })])).toBeNull();
  });
});

describe("parseMaxValue", () => {
  it("null は空テーブルとして 0", () => {
    expect(parseMaxValue(null)).toBe("0");
  });
  it("64bit 値は文字列のまま丸めない", () => {
    expect(parseMaxValue("18446744073709551615")).toBe("18446744073709551615");
  });
  it("安全整数を超える number と非整数は null", () => {
    expect(parseMaxValue(2 ** 60)).toBeNull();
    expect(parseMaxValue("1; DROP TABLE t")).toBeNull();
    expect(parseMaxValue("1.5")).toBeNull();
  });
});

describe("buildIdentitySyncSql", () => {
  it("PostgreSQL は setval を 1 文で生成する", () => {
    expect(buildIdentitySyncSql("postgres", "public", "orders", "id")).toBe(
      `SELECT setval(pg_get_serial_sequence('"public"."orders"', 'id'), COALESCE(MAX("id"), 1), MAX("id") IS NOT NULL) FROM "public"."orders";`,
    );
  });

  it("PostgreSQL は識別子とリテラルのクォートをエスケープする", () => {
    const sql = buildIdentitySyncSql("postgres", "public", `o'"x`, `i'd`);
    expect(sql).toContain(`'"public"."o''""x"'`);
    expect(sql).toContain(`'i''d'`);
    expect(sql).toContain(`MAX("i'd")`);
  });

  it("MySQL は MAX+1 をリテラルで埋め込む", () => {
    expect(buildIdentitySyncSql("mysql", "shop", "orders", "id", "41")).toBe(
      "ALTER TABLE `shop`.`orders` AUTO_INCREMENT = 42;",
    );
  });

  it("MySQL は 64bit の上限付近でも BigInt で計算する", () => {
    expect(buildIdentitySyncSql("mysql", "d", "t", "id", "9007199254740993")).toBe(
      "ALTER TABLE `d`.`t` AUTO_INCREMENT = 9007199254740994;",
    );
  });

  it("MySQL は空テーブル (null) で 1、不正な最大値は null", () => {
    expect(buildIdentitySyncSql("mysql", "d", "t", "id", null)).toBe(
      "ALTER TABLE `d`.`t` AUTO_INCREMENT = 1;",
    );
    expect(buildIdentitySyncSql("mysql", "d", "t", "id", "abc")).toBeNull();
  });

  it("SQLite は sqlite_sequence を更新する", () => {
    expect(buildIdentitySyncSql("sqlite", "main", "notes", "id")).toBe(
      `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(rowid), 0) FROM "notes") WHERE name = 'notes';`,
    );
  });

  it("MySQL の MAX 問い合わせ SQL", () => {
    expect(mysqlMaxValueSql("shop", "orders", "id")).toBe(
      "SELECT MAX(`id`) FROM `shop`.`orders`",
    );
  });
});
