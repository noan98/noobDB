import { describe, expect, it } from "vitest";
import { illustrationForError, type ErrorIllustrationKind } from "../errorHints";

/**
 * illustrationForError のユニットテスト。
 *
 * errorHints.ts の matchErrorHint と同じエラー文言を使い、
 * エラー種別に応じた ErrorIllustrationKind が返ることを検証する。
 */
describe("illustrationForError", () => {
  describe("connectionFailed: 接続失敗系のエラー", () => {
    it("Connection refused → connectionFailed", () => {
      const result: ErrorIllustrationKind = illustrationForError(
        "Connection refused (os error 111)",
      );
      expect(result).toBe("connectionFailed");
    });

    it("cannot connect → connectionFailed", () => {
      expect(
        illustrationForError("Can't connect to MySQL server on 'localhost' (111)"),
      ).toBe("connectionFailed");
    });

    it("server has gone away → connectionFailed", () => {
      expect(illustrationForError("MySQL server has gone away")).toBe("connectionFailed");
    });

    it("lost connection → connectionFailed", () => {
      expect(
        illustrationForError("Lost connection to MySQL server during query"),
      ).toBe("connectionFailed");
    });

    it("broken pipe → connectionFailed", () => {
      expect(
        illustrationForError("Error reading result set's header: broken pipe"),
      ).toBe("connectionFailed");
    });

    it("server closed the connection → connectionFailed", () => {
      expect(
        illustrationForError("server closed the connection unexpectedly"),
      ).toBe("connectionFailed");
    });

    it("terminating connection → connectionFailed", () => {
      expect(
        illustrationForError("FATAL: terminating connection due to administrator command"),
      ).toBe("connectionFailed");
    });

    it("error communicating with database → connectionFailed", () => {
      expect(
        illustrationForError(
          "error communicating with database: Connection reset by peer",
        ),
      ).toBe("connectionFailed");
    });

    it("connection timed out → connectionFailed (接続失敗が timeout より優先)", () => {
      // "connection timed out" は timeout パターン ("timed out") にも一致するが、
      // 接続失敗パターンを先に評価するため connectionFailed を返す。matchErrorHint
      // が返す errorHintConnection (接続先の確認を促すヒント) と整合する。
      expect(illustrationForError("connection timed out")).toBe("connectionFailed");
    });
  });

  describe("timeout: タイムアウト系のエラー", () => {
    it("timed out → timeout", () => {
      expect(
        illustrationForError("Query timed out after 30s and was cancelled."),
      ).toBe("timeout");
    });

    it("timeout (小文字) → timeout", () => {
      expect(illustrationForError("lock wait timeout exceeded")).toBe("timeout");
    });

    it("timed out (スペース区切り) → timeout", () => {
      expect(illustrationForError("query timed out")).toBe("timeout");
    });
  });

  describe("permissionDenied: 権限不足 / 認証失敗", () => {
    it("Access denied → permissionDenied", () => {
      expect(
        illustrationForError(
          "Access denied for user 'root'@'localhost' (using password: YES)",
        ),
      ).toBe("permissionDenied");
    });

    it("authentication failed → permissionDenied", () => {
      expect(illustrationForError("authentication failed")).toBe("permissionDenied");
    });

    it("password authentication failed → permissionDenied", () => {
      expect(
        illustrationForError('password authentication failed for user "admin"'),
      ).toBe("permissionDenied");
    });

    it("permission denied → permissionDenied", () => {
      expect(illustrationForError("permission denied for table users")).toBe(
        "permissionDenied",
      );
    });

    it("insufficient privilege → permissionDenied", () => {
      expect(illustrationForError("insufficient privilege to execute this command")).toBe(
        "permissionDenied",
      );
    });
  });

  describe("schemaLoadFailed: スキーマ系エラー", () => {
    it("Unknown column → schemaLoadFailed", () => {
      expect(
        illustrationForError("Unknown column 'foo' in 'field list'"),
      ).toBe("schemaLoadFailed");
    });

    it("no such column → schemaLoadFailed", () => {
      expect(illustrationForError("no such column: baz")).toBe("schemaLoadFailed");
    });

    it("column does not exist → schemaLoadFailed", () => {
      expect(illustrationForError('column "bar" does not exist')).toBe("schemaLoadFailed");
    });

    it("Unknown database → schemaLoadFailed", () => {
      expect(illustrationForError("Unknown database 'mydb'")).toBe("schemaLoadFailed");
    });

    it("database does not exist → schemaLoadFailed", () => {
      expect(illustrationForError('database "mydb" does not exist')).toBe(
        "schemaLoadFailed",
      );
    });

    it("Table doesn't exist → schemaLoadFailed", () => {
      expect(
        illustrationForError("Table 'mydb.users' doesn't exist"),
      ).toBe("schemaLoadFailed");
    });

    it("no such table → schemaLoadFailed", () => {
      expect(illustrationForError("no such table: users")).toBe("schemaLoadFailed");
    });

    it("relation does not exist → schemaLoadFailed", () => {
      expect(
        illustrationForError('relation "users" does not exist'),
      ).toBe("schemaLoadFailed");
    });
  });

  describe("queryFailed: その他のクエリエラー (フォールバック)", () => {
    it("SQL syntax error → queryFailed", () => {
      expect(
        illustrationForError(
          "You have an error in your SQL syntax; check the manual",
        ),
      ).toBe("queryFailed");
    });

    it("duplicate entry → queryFailed", () => {
      expect(
        illustrationForError("Duplicate entry '123' for key 'PRIMARY'"),
      ).toBe("queryFailed");
    });

    it("foreign key constraint → queryFailed", () => {
      expect(
        illustrationForError(
          "Cannot add or update a child row: a foreign key constraint fails",
        ),
      ).toBe("queryFailed");
    });

    it("全く関係ないエラー → queryFailed", () => {
      expect(illustrationForError("some completely unrecognized error message")).toBe(
        "queryFailed",
      );
    });

    it("空文字 → queryFailed", () => {
      expect(illustrationForError("")).toBe("queryFailed");
    });
  });

  describe("優先順位: connectionFailed が timeout より先に評価される", () => {
    it("'connection timed out' は connectionFailed を返す (接続失敗パターンが先)", () => {
      // timeout パターンにも "connection timed out" の "timed out" が含まれるが、
      // illustrationForError は connectionFailed を先にテストするため
      // connectionFailed を返す (matchErrorHint のヒントと整合させるため)。
      const result = illustrationForError("connection timed out");
      expect(result).toBe("connectionFailed");
    });
  });
});
