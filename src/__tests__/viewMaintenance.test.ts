import { describe, expect, it } from "vitest";
import {
  buildCreateViewSql,
  buildDropViewSql,
  buildReplaceViewSql,
  extractViewBody,
} from "../components/viewMaintenance";

describe("buildCreateViewSql", () => {
  it("qualifies with database.name on MySQL/PostgreSQL/DuckDB", () => {
    expect(buildCreateViewSql("mysql", "shop", "top_users", "SELECT * FROM users")).toBe(
      "CREATE VIEW `shop`.`top_users` AS\nSELECT * FROM users;",
    );
    expect(buildCreateViewSql("postgres", "public", "top_users", "SELECT * FROM users")).toBe(
      'CREATE VIEW "public"."top_users" AS\nSELECT * FROM users;',
    );
    expect(buildCreateViewSql("duckdb", "main", "top_users", "SELECT * FROM users")).toBe(
      'CREATE VIEW "main"."top_users" AS\nSELECT * FROM users;',
    );
  });

  it("has no schema qualification on SQLite", () => {
    expect(buildCreateViewSql("sqlite", "main", "top_users", "SELECT * FROM users")).toBe(
      'CREATE VIEW "top_users" AS\nSELECT * FROM users;',
    );
  });

  it("uses a dbo-only (no database prefix) qualification on MSSQL, unlike DROP TABLE's 3-part form (#729)", () => {
    expect(buildCreateViewSql("mssql", "shop", "top_users", "SELECT * FROM users")).toBe(
      "CREATE VIEW [dbo].[top_users] AS\nSELECT * FROM users;",
    );
  });

  it("strips a trailing semicolon from the source query before wrapping", () => {
    expect(buildCreateViewSql("mysql", "shop", "v", "SELECT 1;  ")).toBe(
      "CREATE VIEW `shop`.`v` AS\nSELECT 1;",
    );
  });
});

describe("buildReplaceViewSql", () => {
  it("uses a single CREATE OR REPLACE VIEW statement on MySQL/PostgreSQL/DuckDB", () => {
    expect(buildReplaceViewSql("mysql", "shop", "v", "SELECT 1")).toEqual([
      "CREATE OR REPLACE VIEW `shop`.`v` AS\nSELECT 1;",
    ]);
    expect(buildReplaceViewSql("postgres", "public", "v", "SELECT 1")).toEqual([
      'CREATE OR REPLACE VIEW "public"."v" AS\nSELECT 1;',
    ]);
    expect(buildReplaceViewSql("duckdb", "main", "v", "SELECT 1")).toEqual([
      'CREATE OR REPLACE VIEW "main"."v" AS\nSELECT 1;',
    ]);
  });

  it("uses CREATE OR ALTER VIEW on MSSQL (no CREATE OR REPLACE in T-SQL)", () => {
    expect(buildReplaceViewSql("mssql", "shop", "v", "SELECT 1")).toEqual([
      "CREATE OR ALTER VIEW [dbo].[v] AS\nSELECT 1;",
    ]);
  });

  it("splits into DROP VIEW IF EXISTS + CREATE VIEW on SQLite (no OR REPLACE support)", () => {
    expect(buildReplaceViewSql("sqlite", "main", "v", "SELECT 1")).toEqual([
      'DROP VIEW IF EXISTS "v";',
      'CREATE VIEW "v" AS\nSELECT 1;',
    ]);
  });
});

describe("buildDropViewSql", () => {
  it("drops with a qualified, quoted name", () => {
    expect(buildDropViewSql("mysql", "shop", "v")).toBe("DROP VIEW `shop`.`v`;");
    expect(buildDropViewSql("sqlite", "main", "v")).toBe('DROP VIEW "v";');
  });

  it("uses dbo-only qualification on MSSQL (DROP VIEW disallows a database prefix)", () => {
    expect(buildDropViewSql("mssql", "shop", "v")).toBe("DROP VIEW [dbo].[v];");
  });
});

describe("extractViewBody", () => {
  it("strips MySQL's SHOW CREATE VIEW wrapper (ALGORITHM/DEFINER/SQL SECURITY clauses)", () => {
    const ddl =
      "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v1` AS select `t1`.`a` AS `a` from `t1`";
    expect(extractViewBody(ddl)).toBe("select `t1`.`a` AS `a` from `t1`");
  });

  it("strips SQLite's raw CREATE VIEW statement", () => {
    expect(extractViewBody("CREATE VIEW v1 AS SELECT * FROM t1")).toBe("SELECT * FROM t1");
  });

  it("strips MSSQL's OBJECT_DEFINITION text, including a WITH SCHEMABINDING clause", () => {
    expect(extractViewBody("CREATE VIEW dbo.v1 WITH SCHEMABINDING AS SELECT a FROM dbo.t1")).toBe(
      "SELECT a FROM dbo.t1",
    );
  });

  it("keeps a leading WITH (CTE) view body intact", () => {
    const ddl = "CREATE VIEW v1 AS WITH cte AS (SELECT 1 AS a) SELECT * FROM cte";
    expect(extractViewBody(ddl)).toBe("WITH cte AS (SELECT 1 AS a) SELECT * FROM cte");
  });

  it("passes PostgreSQL's pg_get_viewdef output through unchanged (already body-only)", () => {
    const body = "SELECT t.a,\n    t.b\n   FROM t;";
    expect(extractViewBody(body)).toBe(body);
  });

  it("trims surrounding whitespace even when no CREATE VIEW wrapper is found", () => {
    expect(extractViewBody("  SELECT 1  \n")).toBe("SELECT 1");
  });
});
