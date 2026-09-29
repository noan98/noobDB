import { describe, expect, it } from "vitest";
import {
  buildCreateNamespaceSql,
  buildDropNamespaceSql,
  isProtectedNamespace,
  isValidNamespaceName,
  supportedNamespaceKinds,
  treeNamespaceKind,
} from "../components/databaseMaintenance";

describe("supportedNamespaceKinds / treeNamespaceKind", () => {
  it("maps each driver to what it can create and what its tree node is", () => {
    expect(supportedNamespaceKinds("mysql")).toEqual(["database"]);
    expect(supportedNamespaceKinds("postgres")).toEqual(["database", "schema"]);
    expect(supportedNamespaceKinds("sqlite")).toEqual([]);
    expect(treeNamespaceKind("mysql")).toBe("database");
    expect(treeNamespaceKind("postgres")).toBe("schema");
    expect(treeNamespaceKind("sqlite")).toBeNull();
  });
});

describe("buildCreateNamespaceSql", () => {
  it("creates a MySQL database with backtick quoting and optional charset/collation", () => {
    expect(buildCreateNamespaceSql("mysql", "database", "shop")).toBe("CREATE DATABASE `shop`;");
    expect(
      buildCreateNamespaceSql("mysql", "database", "shop", { charset: "utf8mb4", collation: "utf8mb4_bin" }),
    ).toBe("CREATE DATABASE `shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;");
  });

  it("escapes embedded quotes and trims the name", () => {
    expect(buildCreateNamespaceSql("mysql", "database", "  a`b ")).toBe("CREATE DATABASE `a``b`;");
    expect(buildCreateNamespaceSql("postgres", "schema", 'a"b')).toBe('CREATE SCHEMA "a""b";');
  });

  it("ignores charset/collation that are not plain tokens (no SQL injection)", () => {
    expect(
      buildCreateNamespaceSql("mysql", "database", "x", { charset: "utf8; DROP DATABASE y", collation: "" }),
    ).toBe("CREATE DATABASE `x`;");
  });

  it("creates PostgreSQL databases and schemas with double quotes", () => {
    expect(buildCreateNamespaceSql("postgres", "database", "app")).toBe('CREATE DATABASE "app";');
    expect(buildCreateNamespaceSql("postgres", "schema", "audit")).toBe('CREATE SCHEMA "audit";');
    // MySQL 専用オプションは PostgreSQL では無視する
    expect(buildCreateNamespaceSql("postgres", "database", "app", { charset: "utf8" })).toBe('CREATE DATABASE "app";');
  });

  it("returns null for unsupported combinations and empty names", () => {
    expect(buildCreateNamespaceSql("sqlite", "database", "x")).toBeNull();
    expect(buildCreateNamespaceSql("sqlite", "schema", "x")).toBeNull();
    expect(buildCreateNamespaceSql("mysql", "schema", "x")).toBeNull();
    expect(buildCreateNamespaceSql("mysql", "database", "   ")).toBeNull();
  });
});

describe("buildDropNamespaceSql", () => {
  it("drops with quoted identifiers and never adds CASCADE", () => {
    expect(buildDropNamespaceSql("mysql", "database", "shop")).toBe("DROP DATABASE `shop`;");
    expect(buildDropNamespaceSql("postgres", "schema", "audit")).toBe('DROP SCHEMA "audit";');
    expect(buildDropNamespaceSql("postgres", "database", 'we"ird')).toBe('DROP DATABASE "we""ird";');
  });

  it("returns null for unsupported combinations and empty names", () => {
    expect(buildDropNamespaceSql("sqlite", "database", "main")).toBeNull();
    expect(buildDropNamespaceSql("mysql", "schema", "x")).toBeNull();
    expect(buildDropNamespaceSql("postgres", "schema", "")).toBeNull();
  });
});

describe("isProtectedNamespace / isValidNamespaceName", () => {
  it("protects MySQL system databases only", () => {
    expect(isProtectedNamespace("mysql", "mysql")).toBe(true);
    expect(isProtectedNamespace("mysql", "Information_Schema")).toBe(true);
    expect(isProtectedNamespace("mysql", "shop")).toBe(false);
    expect(isProtectedNamespace("postgres", "public")).toBe(false);
  });

  it("rejects blank names", () => {
    expect(isValidNamespaceName("  ")).toBe(false);
    expect(isValidNamespaceName("a")).toBe(true);
  });
});
