import { describe, expect, it } from "vitest";
import { matchErrorHint } from "../errorHints";

describe("matchErrorHint", () => {
  describe("SQL syntax error", () => {
    it("MySQL: sql syntax keyword", () => {
      expect(
        matchErrorHint(
          "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version",
        ),
      ).toBe("errorHintSyntax");
    });

    it("PostgreSQL: syntax error at or near", () => {
      expect(matchErrorHint('ERROR: syntax error at or near "SELET"')).toBe(
        "errorHintSyntax",
      );
    });

    it("SQLite: near X: syntax error", () => {
      expect(matchErrorHint('near "SELET": syntax error')).toBe(
        "errorHintSyntax",
      );
    });
  });

  describe("unknown column", () => {
    it("MySQL: Unknown column", () => {
      expect(
        matchErrorHint("Unknown column 'foo' in 'field list'"),
      ).toBe("errorHintUnknownColumn");
    });

    it("PostgreSQL: column does not exist", () => {
      expect(matchErrorHint('column "bar" does not exist')).toBe(
        "errorHintUnknownColumn",
      );
    });

    it("SQLite: no such column", () => {
      expect(matchErrorHint("no such column: baz")).toBe(
        "errorHintUnknownColumn",
      );
    });
  });

  describe("unknown database", () => {
    it("MySQL: Unknown database", () => {
      expect(matchErrorHint("Unknown database 'mydb'")).toBe(
        "errorHintUnknownDatabase",
      );
    });

    it("PostgreSQL: database does not exist", () => {
      expect(matchErrorHint('database "mydb" does not exist')).toBe(
        "errorHintUnknownDatabase",
      );
    });
  });

  describe("table not exist", () => {
    it("MySQL: Table doesn't exist", () => {
      expect(matchErrorHint("Table 'mydb.users' doesn't exist")).toBe(
        "errorHintTableNotExist",
      );
    });

    it("PostgreSQL: relation does not exist", () => {
      expect(matchErrorHint('relation "users" does not exist')).toBe(
        "errorHintTableNotExist",
      );
    });

    it("SQLite: no such table", () => {
      expect(matchErrorHint("no such table: users")).toBe(
        "errorHintTableNotExist",
      );
    });
  });

  describe("foreign key constraint", () => {
    it("MySQL: foreign key constraint fails", () => {
      expect(
        matchErrorHint(
          "Cannot add or update a child row: a foreign key constraint fails (`db`.`orders`, CONSTRAINT `fk_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`))",
        ),
      ).toBe("errorHintForeignKey");
    });

    it("PostgreSQL: violates foreign key constraint", () => {
      expect(
        matchErrorHint(
          'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"',
        ),
      ).toBe("errorHintForeignKey");
    });
  });

  describe("duplicate key", () => {
    it("MySQL: Duplicate entry", () => {
      expect(
        matchErrorHint("Duplicate entry '123' for key 'PRIMARY'"),
      ).toBe("errorHintDuplicate");
    });

    it("PostgreSQL: duplicate key value", () => {
      expect(
        matchErrorHint(
          'duplicate key value violates unique constraint "users_pkey"',
        ),
      ).toBe("errorHintDuplicate");
    });

    it("SQLite: UNIQUE constraint failed", () => {
      expect(matchErrorHint("UNIQUE constraint failed: users.email")).toBe(
        "errorHintDuplicate",
      );
    });
  });

  describe("access denied", () => {
    it("MySQL: Access denied", () => {
      expect(
        matchErrorHint(
          "Access denied for user 'root'@'localhost' (using password: YES)",
        ),
      ).toBe("errorHintAccessDenied");
    });

    it("PostgreSQL: password authentication failed", () => {
      expect(
        matchErrorHint('password authentication failed for user "admin"'),
      ).toBe("errorHintAccessDenied");
    });

    it("generic: authentication failed", () => {
      expect(matchErrorHint("authentication failed")).toBe(
        "errorHintAccessDenied",
      );
    });
  });

  describe("connection dropped mid-session (errorHintConnectionLost)", () => {
    it("MySQL: server has gone away", () => {
      expect(matchErrorHint("MySQL server has gone away")).toBe(
        "errorHintConnectionLost",
      );
    });

    it("MySQL: Lost connection during query", () => {
      expect(
        matchErrorHint("Lost connection to MySQL server during query"),
      ).toBe("errorHintConnectionLost");
    });

    it("broken pipe", () => {
      expect(
        matchErrorHint("Error reading result set's header: broken pipe"),
      ).toBe("errorHintConnectionLost");
    });

    it("connection was killed", () => {
      expect(matchErrorHint("connection was killed")).toBe(
        "errorHintConnectionLost",
      );
    });

    it("PostgreSQL: server closed the connection", () => {
      expect(
        matchErrorHint("server closed the connection unexpectedly"),
      ).toBe("errorHintConnectionLost");
    });

    it("PostgreSQL: terminating connection", () => {
      expect(
        matchErrorHint(
          "FATAL: terminating connection due to administrator command",
        ),
      ).toBe("errorHintConnectionLost");
    });

    it("sqlx: error communicating with database", () => {
      expect(
        matchErrorHint(
          "error communicating with database: Connection reset by peer",
        ),
      ).toBe("errorHintConnectionLost");
    });
  });

  describe("order: connectionLost must precede generic connection error", () => {
    it("'terminating connection' is not misidentified as generic connection error", () => {
      expect(
        matchErrorHint("FATAL: terminating connection due to idle timeout"),
      ).toBe("errorHintConnectionLost");
    });

    it("'server has gone away' is not matched by the generic connection pattern", () => {
      expect(matchErrorHint("server has gone away")).toBe(
        "errorHintConnectionLost",
      );
    });

    it("'error communicating with database' with 'connection' in the tail is connectionLost", () => {
      expect(
        matchErrorHint("error communicating with database: connection reset"),
      ).toBe("errorHintConnectionLost");
    });
  });

  describe("generic connection failure (errorHintConnection)", () => {
    it("connection refused", () => {
      expect(matchErrorHint("Connection refused (os error 111)")).toBe(
        "errorHintConnection",
      );
    });

    it("can't connect to server", () => {
      expect(
        matchErrorHint("Can't connect to MySQL server on 'localhost' (111)"),
      ).toBe("errorHintConnection");
    });

    it("cannot connect", () => {
      expect(matchErrorHint("cannot connect to host db.example.com:5432")).toBe(
        "errorHintConnection",
      );
    });

    it("connection timed out", () => {
      expect(matchErrorHint("connection timed out")).toBe(
        "errorHintConnection",
      );
    });

    it("connection reset (no 'communicating with database' prefix)", () => {
      expect(matchErrorHint("connection reset by peer")).toBe(
        "errorHintConnection",
      );
    });
  });

  describe("no match", () => {
    it("returns null for an unrecognized error", () => {
      expect(matchErrorHint("some completely unrecognized error message")).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(matchErrorHint("")).toBeNull();
    });

    it("returns null for a lock-timeout message that doesn't match any pattern", () => {
      expect(matchErrorHint("Lock wait timeout exceeded; try restarting transaction")).toBeNull();
    });
  });
});
