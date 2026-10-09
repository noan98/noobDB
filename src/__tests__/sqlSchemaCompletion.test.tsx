import { describe, expect, it } from "vitest";
import type { Completion } from "@codemirror/autocomplete";
import type { ForeignKey, TableColumnInfo } from "../api/tauri";
import {
  buildSchemaNamespace,
  completionIconName,
  describeColumn,
  findColumnInfo,
  keywordCompletionOption,
  type ColumnInfoLabels,
} from "../components/sqlSchemaCompletion";
import { renderColumnInfo } from "../components/completionInfoPanel";
import { renderCompletionIcon } from "../components/completionIcons";

const labels: ColumnInfoLabels = {
  type: "Type",
  nullable: "Nullable",
  nullAllowed: "NULL allowed",
  notNull: "NOT NULL",
  primaryKey: "Key",
  references: "References",
  defaultValue: "Default",
};

function col(over: Partial<TableColumnInfo>): TableColumnInfo {
  return {
    name: "id",
    data_type: "int",
    nullable: false,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  };
}

const fk = (table: string, column: string, rt: string, rc: string | null): ForeignKey => ({
  table,
  column,
  referenced_table: rt,
  referenced_column: rc,
  constraint_name: null,
});

const base = { idQuote: "`", idCaseInsensitive: true, fks: [] as ForeignKey[], namespaceDb: null };

type Node = { self: Completion; children: Completion[] };

describe("buildSchemaNamespace", () => {
  it("テーブルに table、列に column の種別を付ける", () => {
    const ns = buildSchemaNamespace({ ...base, tables: { users: ["id", "name"] } }) as Record<string, Node>;
    expect(ns.users.self).toEqual({ label: "users", type: "table" });
    expect(ns.users.children.map((c) => [c.label, c.type])).toEqual([
      ["id", "column"],
      ["name", "column"],
    ]);
  });

  it("FK 列は key 種別で、参照先を detail に出す", () => {
    const ns = buildSchemaNamespace({
      ...base,
      tables: { orders: ["id", "user_id"] },
      fks: [fk("Orders", "USER_ID", "users", "id")],
    }) as Record<string, Node>;
    const [id, userId] = ns.orders.children;
    expect(id.type).toBe("column");
    expect(id.detail).toBeUndefined();
    expect(userId.type).toBe("key");
    expect(userId.detail).toBe("→ users.id");
  });

  it("参照列が不明な FK はテーブル名だけを出す", () => {
    const ns = buildSchemaNamespace({
      ...base,
      tables: { a: ["b_id"] },
      fks: [fk("a", "b_id", "b", null)],
    }) as Record<string, Node>;
    expect(ns.a.children[0].detail).toBe("→ b");
  });

  it("単純な識別子でない名前は方言のクォートで apply する", () => {
    const ns = buildSchemaNamespace({ ...base, tables: { "my table": ["a b"] } }) as Record<string, Node>;
    expect(ns["my table"].self.apply).toBe("`my table`");
    expect(ns["my table"].children[0].apply).toBe("`a b`");
  });

  it("大文字小文字を区別する方言では大文字を含む名前もクォートする", () => {
    const ns = buildSchemaNamespace({
      ...base,
      idQuote: '"',
      idCaseInsensitive: false,
      tables: { Users: ["id"] },
    }) as Record<string, Node>;
    expect(ns.Users.self.apply).toBe('"Users"');
    expect(ns.Users.children[0].apply).toBeUndefined();
  });

  it("DB 名前空間を足すと database 種別の下に同じテーブルが入る", () => {
    const ns = buildSchemaNamespace({ ...base, namespaceDb: "shop", tables: { t: ["c"] } }) as Record<
      string,
      { self: Completion; children: Record<string, Node> }
    >;
    expect(ns.shop.self).toEqual({ label: "shop", type: "database" });
    expect(ns.shop.children.t.self.type).toBe("table");
    expect(ns.t).toBeDefined();
  });

  it("columnInfo を渡すと列候補にだけ info が付く", () => {
    const calls: string[] = [];
    const ns = buildSchemaNamespace({
      ...base,
      tables: { t: ["c"] },
      columnInfo: (table, column) => {
        calls.push(`${table}.${column}`);
        return () => null;
      },
    }) as Record<string, Node>;
    expect(calls).toEqual(["t.c"]);
    expect(typeof ns.t.children[0].info).toBe("function");
    expect(ns.t.self.info).toBeUndefined();
  });
});

describe("keywordCompletionOption", () => {
  it("lang-sql の種別を keyword / datatype / function に寄せる", () => {
    expect(keywordCompletionOption("SELECT", "keyword").type).toBe("keyword");
    expect(keywordCompletionOption("INT", "type").type).toBe("datatype");
    expect(keywordCompletionOption("COUNT", "variable").type).toBe("function");
  });
});

describe("describeColumn", () => {
  it("型・NULL 可否・主キー・FK 参照先・既定値・コメントを整形する", () => {
    const c = describeColumn(
      col({
        name: "user_id",
        data_type: "bigint",
        nullable: true,
        key: "PRI",
        referenced_table: "users",
        referenced_column: "id",
        default: "0",
        comment: " 所有者 ",
      }),
      labels,
    );
    expect(c.title).toBe("user_id");
    expect(c.rows).toEqual([
      { label: "Type", value: "bigint" },
      { label: "Nullable", value: "NULL allowed" },
      { label: "Key", value: "PRIMARY KEY" },
      { label: "References", value: "users.id" },
      { label: "Default", value: "0" },
    ]);
    expect(c.comment).toBe("所有者");
  });

  it("NOT NULL で値の無い項目は行ごと省く", () => {
    const c = describeColumn(col({ default: "", comment: "  " }), labels);
    expect(c.rows).toEqual([
      { label: "Type", value: "int" },
      { label: "Nullable", value: "NOT NULL" },
    ]);
    expect(c.comment).toBeUndefined();
  });

  it("参照列が不明ならテーブル名だけを出す", () => {
    const c = describeColumn(col({ referenced_table: "users" }), labels);
    expect(c.rows.find((r) => r.label === "References")?.value).toBe("users");
  });
});

describe("findColumnInfo", () => {
  it("大文字小文字を無視して探す", () => {
    const cols = [col({ name: "Id" }), col({ name: "Name" })];
    expect(findColumnInfo(cols, "name")?.name).toBe("Name");
    expect(findColumnInfo(cols, "zzz")).toBeUndefined();
  });
});

describe("completionIconName", () => {
  it("種別ごとに別のアイコンを返す", () => {
    const names = ["table", "column", "key", "function", "keyword"].map((t) => completionIconName(t));
    expect(new Set(names).size).toBe(5);
  });
  it("他ソースの種別 (property / type / constant) も解決し、未知は null", () => {
    expect(completionIconName("property")).toBe("columns");
    expect(completionIconName("type")).toBe("table");
    expect(completionIconName("constant")).toBe("link");
    expect(completionIconName("unknown")).toBeNull();
    expect(completionIconName(undefined)).toBeNull();
  });
  it("空白区切りの複数種別は先頭の既知種別を使う", () => {
    expect(completionIconName("zzz key")).toBe("key");
  });
});

describe("DOM 描画", () => {
  it("情報パネルは見出し・行・コメントを textContent で描く", () => {
    const el = renderColumnInfo({
      title: "<b>x</b>",
      rows: [{ label: "Type", value: "int" }],
      comment: "memo",
    });
    expect(el.className).toBe("cm-sqlInfo");
    expect(el.querySelector(".cm-sqlInfo-title")?.textContent).toBe("<b>x</b>");
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("dt")?.textContent).toBe("Type");
    expect(el.querySelector("dd")?.textContent).toBe("int");
    expect(el.querySelector(".cm-sqlInfo-comment")?.textContent).toBe("memo");
  });

  it("種別アイコンは種別クラスと svg を持ち、未知種別は空の枠", () => {
    const el = renderCompletionIcon("table");
    expect(el.classList.contains("cm-completionIcon-table")).toBe(true);
    expect(el.querySelector("svg")).not.toBeNull();
    const none = renderCompletionIcon("unknown");
    expect(none.classList.contains("cm-completionIcon")).toBe(true);
    expect(none.querySelector("svg")).toBeNull();
  });
});
