import { describe, expect, it } from "vitest";
import type { ForeignKey, TableColumnInfo } from "../api/tauri";
import {
  buildSchemaMarkdown,
  defaultSchemaFilename,
  expandWithFkRelated,
  type SchemaExportInput,
} from "../components/schemaExport";

function col(overrides: Partial<TableColumnInfo> & { name: string }): TableColumnInfo {
  return {
    data_type: "int",
    nullable: false,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...overrides,
  };
}

function fk(
  table: string,
  column: string,
  referencedTable: string,
  referencedColumn: string | null = "id",
  constraintName: string | null = null,
): ForeignKey {
  return {
    table,
    column,
    referenced_table: referencedTable,
    referenced_column: referencedColumn,
    constraint_name: constraintName,
  };
}

describe("buildSchemaMarkdown", () => {
  const base: SchemaExportInput = {
    database: "shop",
    driver: "mysql",
    tables: [
      {
        name: "users",
        columns: [
          col({ name: "id", data_type: "int unsigned", key: "PRI", extra: "auto_increment" }),
          col({ name: "email", data_type: "varchar(255)", key: "UNI" }),
        ],
      },
      {
        name: "orders",
        columns: [
          col({ name: "id", data_type: "int unsigned", key: "PRI" }),
          col({ name: "user_id", data_type: "int unsigned", key: "MUL" }),
          col({ name: "note", data_type: "text", nullable: true }),
        ],
      },
    ],
    foreignKeys: [fk("orders", "user_id", "users")],
  };

  it("ヘッダ + テーブル見出し + カラム表 + FK 箇条書きを出力する", () => {
    const out = buildSchemaMarkdown(base);
    expect(out).toBe(
      "# shop (mysql) — 2 tables\n" +
        "\n## users\n\n" +
        "| Column | Type | Nullable | Key | Extra |\n" +
        "|" +
        " --- |".repeat(5) +
        "\n" +
        "| id | int unsigned | NO | PRI | auto_increment |\n" +
        "| email | varchar(255) | NO | UNI |  |\n" +
        "\n## orders\n\n" +
        "| Column | Type | Nullable | Key |\n" +
        "|" +
        " --- |".repeat(4) +
        "\n" +
        "| id | int unsigned | NO | PRI |\n" +
        "| user_id | int unsigned | NO | MUL |\n" +
        "| note | text | YES |  |\n" +
        "\nForeign keys:\n" +
        "- user_id → users.id\n",
    );
  });

  it("テーブル 1 件のときは単数形 (1 table)", () => {
    const out = buildSchemaMarkdown({ ...base, tables: [base.tables[0]] });
    expect(out.startsWith("# shop (mysql) — 1 table\n")).toBe(true);
  });

  it("全行で空の任意列 (Key/Default/Extra) はテーブル単位で省略する", () => {
    const out = buildSchemaMarkdown({
      ...base,
      tables: [
        { name: "plain", columns: [col({ name: "a", data_type: "text", nullable: true })] },
      ],
      foreignKeys: [],
    });
    expect(out).toContain("| Column | Type | Nullable |\n");
    expect(out).not.toContain("Key");
    expect(out).not.toContain("Default");
    expect(out).not.toContain("Extra");
  });

  it("Default は空文字列でない値があるときだけ列を出す", () => {
    const out = buildSchemaMarkdown({
      ...base,
      tables: [
        {
          name: "t",
          columns: [
            col({ name: "a", default: "0" }),
            col({ name: "b", nullable: true }),
          ],
        },
      ],
      foreignKeys: [],
    });
    expect(out).toContain("| Column | Type | Nullable | Default |\n");
    expect(out).toContain("| a | int | NO | 0 |\n");
    expect(out).toContain("| b | int | YES |  |\n");
  });

  it("セル内の | と改行は exportPreview と同じ規則でエスケープする", () => {
    const out = buildSchemaMarkdown({
      ...base,
      tables: [
        {
          name: "weird",
          columns: [col({ name: "a|b", data_type: "enum('x','y')", default: "x\ny" })],
        },
      ],
      foreignKeys: [],
    });
    expect(out).toContain("| a\\|b | enum('x','y') | NO | x<br>y |");
  });

  it("複合 FK は constraint_name でグループ化する", () => {
    const out = buildSchemaMarkdown({
      ...base,
      tables: [{ name: "order_items", columns: [col({ name: "order_id" })] }],
      foreignKeys: [
        fk("order_items", "order_id", "orders", "id", "fk_oi"),
        fk("order_items", "order_no", "orders", "no", "fk_oi"),
        fk("order_items", "product_id", "products", "id", "fk_prod"),
      ],
    });
    expect(out).toContain("- (order_id, order_no) → orders (id, no)\n");
    expect(out).toContain("- product_id → products.id\n");
  });

  it("referenced_column が null なら参照先テーブル名のみを出す", () => {
    const out = buildSchemaMarkdown({
      ...base,
      tables: [{ name: "orders", columns: [col({ name: "user_id" })] }],
      foreignKeys: [fk("orders", "user_id", "users", null)],
    });
    expect(out).toContain("- user_id → users\n");
  });

  it("参照先が出力対象外のテーブルでも FK はそのまま表記する", () => {
    const out = buildSchemaMarkdown({
      ...base,
      tables: [base.tables[1]], // orders のみ。users は含めない
    });
    expect(out).toContain("- user_id → users.id\n");
    expect(out).not.toContain("## users");
  });

  it("列詳細の取得に失敗したテーブルはプレースホルダ行を出す", () => {
    const out = buildSchemaMarkdown({
      ...base,
      tables: [{ name: "broken", columns: null }],
      foreignKeys: [],
    });
    expect(out).toContain("\n## broken\n\n_column details unavailable_\n");
  });
});

describe("expandWithFkRelated", () => {
  const fks: ForeignKey[] = [
    fk("orders", "user_id", "users"),
    fk("order_items", "order_id", "orders"),
    fk("profiles", "user_id", "users"),
    fk("logs", "actor", "logs"), // 自己参照
  ];

  it("FK を双方向に推移的に辿る (親も子も含む)", () => {
    // order_items → orders → users → (逆向きに) profiles まで届く。
    expect(expandWithFkRelated(["order_items"], fks)).toEqual(
      new Set(["order_items", "orders", "users", "profiles"]),
    );
  });

  it("FK に関与しない孤立テーブルは選択のみが残る", () => {
    expect(expandWithFkRelated(["settings"], fks)).toEqual(new Set(["settings"]));
  });

  it("自己参照 FK でも無限ループしない", () => {
    expect(expandWithFkRelated(["logs"], fks)).toEqual(new Set(["logs"]));
  });

  it("循環参照があっても停止する", () => {
    const cyclic = [fk("a", "b_id", "b"), fk("b", "c_id", "c"), fk("c", "a_id", "a")];
    expect(expandWithFkRelated(["a"], cyclic)).toEqual(new Set(["a", "b", "c"]));
  });

  it("空選択は空集合のまま", () => {
    expect(expandWithFkRelated([], fks)).toEqual(new Set());
  });
});

describe("defaultSchemaFilename", () => {
  it("schema_<db>_<timestamp>.md 形式でファイル名に安全な文字へ揃える", () => {
    const now = new Date(2026, 6, 3, 9, 5, 7);
    expect(defaultSchemaFilename("my/shop", now)).toBe("schema_my_shop_20260703_090507.md");
  });

  it("空の DB 名は database へフォールバックする", () => {
    const now = new Date(2026, 0, 1, 0, 0, 0);
    expect(defaultSchemaFilename("", now)).toBe("schema_database_20260101_000000.md");
  });
});
