import { describe, expect, it } from "vitest";
import {
  applyNullToken,
  buildColumnDrafts,
  inferColumnType,
  inferValueType,
  mergeColumnDrafts,
  newColumnTypeCellKind,
  newColumnTypeOptions,
  newTableRequest,
  proposeColumnNames,
  suggestTableName,
  validateNewTable,
  type NewColumnDraft,
} from "../components/newTableInference";

describe("inferValueType", () => {
  it("32bit / 64bit 整数の境界を BigInt で判定する", () => {
    expect(inferValueType("0")).toBe("integer");
    expect(inferValueType("-0")).toBe("integer");
    expect(inferValueType("2147483647")).toBe("integer");
    expect(inferValueType("-2147483648")).toBe("integer");
    expect(inferValueType("2147483648")).toBe("bigint");
    expect(inferValueType("-2147483649")).toBe("bigint");
    // Number の安全整数 (2^53) を超えても丸めずに判定する。
    expect(inferValueType("9007199254740993")).toBe("bigint");
    expect(inferValueType("9223372036854775807")).toBe("bigint");
    expect(inferValueType("-9223372036854775808")).toBe("bigint");
    // i64 を超えたら固定小数 (整数部 28 桁まで)、それ以上は文字列。
    expect(inferValueType("9223372036854775808")).toBe("decimal");
    expect(inferValueType("-9223372036854775809")).toBe("decimal");
    expect(inferValueType("1".repeat(28))).toBe("decimal");
    expect(inferValueType("1".repeat(29))).toBe("text");
  });

  it("先頭ゼロ・+ 符号・空白付きは文字列のまま残す", () => {
    expect(inferValueType("007")).toBe("text");
    expect(inferValueType("+1")).toBe("text");
    expect(inferValueType(" 1")).toBe("text");
    expect(inferValueType("1 ")).toBe("text");
    expect(inferValueType("")).toBe("text");
    expect(inferValueType("1,000")).toBe("text");
  });

  it("小数は桁数に応じて固定小数 / 浮動小数に分ける", () => {
    expect(inferValueType("12.34")).toBe("decimal");
    expect(inferValueType("-0.5")).toBe("decimal");
    expect(inferValueType("0.1234567890")).toBe("decimal");
    expect(inferValueType("0.12345678901")).toBe("double");
    expect(inferValueType("1e10")).toBe("double");
    expect(inferValueType("-1.5E-3")).toBe("double");
    expect(inferValueType("1e999")).toBe("text");
    expect(inferValueType(".5")).toBe("text");
    expect(inferValueType("1.")).toBe("text");
    expect(inferValueType("NaN")).toBe("text");
    expect(inferValueType("Infinity")).toBe("text");
  });

  it("真偽は true / false (大文字小文字不問) のみ", () => {
    expect(inferValueType("true")).toBe("boolean");
    expect(inferValueType("FALSE")).toBe("boolean");
    expect(inferValueType("yes")).toBe("text");
    expect(inferValueType("1")).toBe("integer");
  });

  it("日付はカレンダー上の実在日のみ", () => {
    expect(inferValueType("2024-02-29")).toBe("date");
    expect(inferValueType("2023-02-29")).toBe("text");
    expect(inferValueType("1900-02-29")).toBe("text");
    expect(inferValueType("2000-02-29")).toBe("date");
    expect(inferValueType("2024-13-01")).toBe("text");
    expect(inferValueType("2024-04-31")).toBe("text");
    expect(inferValueType("0000-01-01")).toBe("text");
    expect(inferValueType("2024/01/01")).toBe("text");
    expect(inferValueType("2024-1-1")).toBe("text");
  });

  it("日時は秒必須・秒未満 6 桁まで・タイムゾーンなし", () => {
    expect(inferValueType("2024-01-02 03:04:05")).toBe("datetime");
    expect(inferValueType("2024-01-02T03:04:05")).toBe("datetime");
    expect(inferValueType("2024-01-02 03:04:05.123456")).toBe("datetime");
    expect(inferValueType("2024-01-02 03:04:05.1234567")).toBe("text");
    expect(inferValueType("2024-01-02 03:04")).toBe("text");
    expect(inferValueType("2024-01-02T03:04:05Z")).toBe("text");
    expect(inferValueType("2024-01-02T03:04:05+09:00")).toBe("text");
    expect(inferValueType("2024-01-02 24:00:00")).toBe("text");
    expect(inferValueType("2024-02-30 00:00:00")).toBe("text");
  });
});

describe("inferColumnType", () => {
  it("NULL を無視し、数値は表せる最小の型へまとめる", () => {
    expect(inferColumnType(["1", null, "2"], "postgres")).toBe("integer");
    expect(inferColumnType(["1", "3000000000"], "postgres")).toBe("bigint");
    expect(inferColumnType(["1", "1.5"], "postgres")).toBe("decimal");
    expect(inferColumnType(["1.5", "1e3"], "postgres")).toBe("double");
    expect(inferColumnType(["9223372036854775807", "9223372036854775808"], "postgres")).toBe(
      "decimal",
    );
  });

  it("日付と日時が混ざれば日時、型が合わなければ文字列", () => {
    expect(inferColumnType(["2024-01-01", "2024-01-01 10:00:00"], "mysql")).toBe("datetime");
    expect(inferColumnType(["1", "abc"], "mysql")).toBe("text");
    expect(inferColumnType(["true", "1"], "postgres")).toBe("text");
    expect(inferColumnType(["2024-01-01", "1"], "postgres")).toBe("text");
  });

  it("すべて NULL / 行なしは文字列", () => {
    expect(inferColumnType([], "sqlite")).toBe("text");
    expect(inferColumnType([null, null], "sqlite")).toBe("text");
  });

  it("MySQL では真偽を推論しない (文字列へ縮退)", () => {
    expect(inferColumnType(["true", "false"], "postgres")).toBe("boolean");
    expect(inferColumnType(["true", "false"], "mssql")).toBe("boolean");
    expect(inferColumnType(["true", "false"], "mysql")).toBe("text");
    expect(newColumnTypeOptions("mysql")).not.toContain("boolean");
    expect(newColumnTypeOptions("duckdb")).toContain("boolean");
  });

  it("空文字は NULL トークン次第: NULL 化しなければ数値列が文字列になる", () => {
    const raw = ["1", "", "2"];
    expect(inferColumnType(raw.map((v) => applyNullToken(v, "")), "postgres")).toBe("integer");
    expect(inferColumnType(raw.map((v) => applyNullToken(v, null)), "postgres")).toBe("text");
    expect(applyNullToken("NULL", "NULL")).toBeNull();
    expect(applyNullToken("null", "NULL")).toBe("null");
  });
});

describe("proposeColumnNames", () => {
  it("空名は column_N、重複は大文字小文字を無視して連番を付ける", () => {
    expect(proposeColumnNames(["id", "", "  ", "Name", "name", "NAME"])).toEqual([
      "id",
      "column_2",
      "column_3",
      "Name",
      "name_2",
      "NAME_3",
    ]);
  });

  it("生成した名前と後続の元の名前の衝突も解消する", () => {
    expect(proposeColumnNames(["a", "a", "a_2"])).toEqual(["a", "a_2", "a_2_2"]);
  });

  it("予約語や記号入りの名前はそのまま (クォートはバックエンドが行う)", () => {
    expect(proposeColumnNames(["select", "order date", 'a"b'])).toEqual([
      "select",
      "order date",
      'a"b',
    ]);
  });
});

describe("suggestTableName", () => {
  it("拡張子を落として記号を _ にまとめる", () => {
    expect(suggestTableName("/tmp/Sales Report 2024.csv")).toBe("Sales_Report_2024");
    expect(suggestTableName("C:\\data\\users.ndjson")).toBe("users");
    expect(suggestTableName("/tmp/売上-明細.json")).toBe("売上_明細");
    expect(suggestTableName("/tmp/---.csv")).toBe("imported_table");
    expect(suggestTableName("")).toBe("imported_table");
  });
});

describe("buildColumnDrafts", () => {
  const preview = {
    headers: ["id", "price", "", "id", "flag", "at"],
    rows: [
      ["1", "9.99", "x", "10", "true", "2024-01-01"],
      ["9223372036854775807", "", "y", "11", "false", "2024-01-02 03:04:05"],
      ["3", "1.5"],
    ],
  };

  it("列名の提案と型の推論を行い、欠けたセルは NULL 扱い", () => {
    const drafts = buildColumnDrafts(preview, "", "postgres", true);
    expect(drafts.map((d) => [d.name, d.type])).toEqual([
      ["id", "bigint"],
      ["price", "decimal"],
      ["column_3", "text"],
      ["id_2", "integer"],
      ["flag", "boolean"],
      ["at", "datetime"],
    ]);
    expect(drafts.every((d) => d.include && d.type === d.inferredType)).toBe(true);
    expect(drafts.map((d) => d.csvIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("ヘッダなしなら column_N を提案する", () => {
    const drafts = buildColumnDrafts(preview, "", "sqlite", false);
    expect(drafts.map((d) => d.name)).toEqual([
      "column_1",
      "column_2",
      "column_3",
      "column_4",
      "column_5",
      "column_6",
    ]);
  });

  it("行がヘッダより長い場合も列を作る", () => {
    const drafts = buildColumnDrafts({ headers: ["a"], rows: [["1", "2"]] }, "", "sqlite", true);
    expect(drafts.map((d) => d.name)).toEqual(["a", "column_2"]);
  });
});

describe("validateNewTable / newTableRequest", () => {
  const d = (name: string, include = true, csvIndex = 0): NewColumnDraft => ({
    csvIndex,
    name,
    proposedName: name,
    type: "text",
    inferredType: "text",
    include,
  });

  it("テーブル名・列名の空・重複・前後空白を検出する", () => {
    expect(validateNewTable("postgres", "", [d("a")])).toEqual({ kind: "tableNameRequired" });
    expect(validateNewTable("postgres", " t", [d("a")])).toEqual({
      kind: "nameWhitespace",
      name: " t",
    });
    expect(validateNewTable("postgres", "t", [d("a", false)])).toEqual({ kind: "noColumns" });
    expect(validateNewTable("postgres", "t", [d("")])).toEqual({ kind: "columnNameRequired" });
    expect(validateNewTable("postgres", "t", [d("A"), d("a")])).toEqual({
      kind: "duplicateColumn",
      name: "a",
    });
    // 取り込まない列は重複判定の対象外。
    expect(validateNewTable("postgres", "t", [d("A"), d("a", false)])).toBeNull();
    expect(validateNewTable("postgres", "select", [d("from")])).toBeNull();
  });

  it("方言の識別子長の上限 (PostgreSQL はバイト数) を検出する", () => {
    expect(validateNewTable("postgres", "a".repeat(63), [d("a")])).toBeNull();
    expect(validateNewTable("postgres", "a".repeat(64), [d("a")])).toEqual({
      kind: "nameTooLong",
      name: "a".repeat(64),
      limit: 63,
    });
    expect(validateNewTable("postgres", "あ".repeat(22), [d("a")])?.kind).toBe("nameTooLong");
    expect(validateNewTable("mysql", "あ".repeat(64), [d("a")])).toBeNull();
    expect(validateNewTable("mysql", "t", [d("b".repeat(65))])?.kind).toBe("nameTooLong");
    expect(validateNewTable("sqlite", "a".repeat(500), [d("a")])).toBeNull();
  });

  it("取り込み対象の列だけを列定義とマッピングにする", () => {
    const req = newTableRequest([
      { csvIndex: 0, name: "id", proposedName: "id", type: "bigint", inferredType: "integer", include: true },
      { csvIndex: 1, name: "skip", proposedName: "skip", type: "text", inferredType: "text", include: false },
      { csvIndex: 2, name: "at", proposedName: "at", type: "date", inferredType: "date", include: true },
    ]);
    expect(req.columns).toEqual([
      { name: "id", type: "bigint" },
      { name: "at", type: "date" },
    ]);
    expect(req.mapping).toEqual([
      { column: "id", csvIndex: 0 },
      { column: "at", csvIndex: 2 },
    ]);
  });

  it("型アイコンは結果グリッドと同じ分類を使う", () => {
    expect(newColumnTypeCellKind("bigint")).toBe("number");
    expect(newColumnTypeCellKind("double")).toBe("decimal");
    expect(newColumnTypeCellKind("datetime")).toBe("date");
    expect(newColumnTypeCellKind("boolean")).toBe("bool");
    expect(newColumnTypeCellKind("text")).toBe("string");
  });
});

describe("mergeColumnDrafts", () => {
  it("手で変えた名前・型・除外だけを引き継ぎ、それ以外は新しい推論に追従する", () => {
    const prev = buildColumnDrafts(
      { headers: ["id", "n", "memo"], rows: [["1", "", "x"]] },
      null,
      "postgres",
      true,
    );
    expect(prev.map((d) => d.type)).toEqual(["integer", "text", "text"]);
    const edited = prev.map((d) =>
      d.csvIndex === 0
        ? { ...d, type: "bigint" as const }
        : d.csvIndex === 2
          ? { ...d, name: "note", include: false }
          : d,
    );
    // NULL トークンを "" にして取り直すと n 列は整数に変わる。
    const next = buildColumnDrafts(
      { headers: ["id", "n", "memo"], rows: [["1", "", "x"]] },
      "",
      "postgres",
      true,
    );
    const merged = mergeColumnDrafts(edited, next);
    expect(merged.map((d) => [d.name, d.type, d.include])).toEqual([
      ["id", "bigint", true],
      ["n", "text", true],
      ["note", "text", false],
    ]);
    expect(mergeColumnDrafts(null, next)).toEqual(next);
  });
});
