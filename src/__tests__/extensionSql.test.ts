import { describe, expect, it } from "vitest";
import {
  buildCreateExtensionSql,
  buildDropExtensionSql,
  buildExtensionSql,
  buildUpdateExtensionSql,
  formatExtensionDependent,
  groupExtensionDependents,
  isDestructiveExtensionAction,
  isPreloaded,
  matchesExtensionFilter,
  needsPreload,
} from "../components/extensionSql";

// PostgreSQL の拡張機能の CREATE / ALTER / DROP EXTENSION の組み立て (#2160)。

describe("extension SQL", () => {
  it("導入は IF NOT EXISTS を付け、スキーマと CASCADE は指定したときだけ付ける", () => {
    expect(buildCreateExtensionSql("pg_trgm", { schema: "", cascade: false })).toBe(
      'CREATE EXTENSION IF NOT EXISTS "pg_trgm"',
    );
    expect(buildCreateExtensionSql("pg_trgm", { schema: " ext ", cascade: true })).toBe(
      'CREATE EXTENSION IF NOT EXISTS "pg_trgm" SCHEMA "ext" CASCADE',
    );
  });

  it("識別子の引用符は二重にする (ハイフン入りの uuid-ossp など)", () => {
    expect(buildCreateExtensionSql("uuid-ossp", { schema: 'we"ird', cascade: false })).toBe(
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA "we""ird"',
    );
  });

  it("更新は既定のバージョンへ。バージョンを渡すとリテラルで TO を付ける", () => {
    expect(buildUpdateExtensionSql("hstore")).toBe('ALTER EXTENSION "hstore" UPDATE');
    expect(buildUpdateExtensionSql("hstore", "1.8")).toBe("ALTER EXTENSION \"hstore\" UPDATE TO '1.8'");
    expect(buildUpdateExtensionSql("hstore", "1'8")).toBe("ALTER EXTENSION \"hstore\" UPDATE TO '1''8'");
  });

  it("削除は CASCADE を付けた形が破壊的", () => {
    expect(buildDropExtensionSql("cube", false)).toBe('DROP EXTENSION "cube"');
    expect(buildDropExtensionSql("cube", true)).toBe('DROP EXTENSION "cube" CASCADE');
    expect(isDestructiveExtensionAction("drop")).toBe(true);
    expect(isDestructiveExtensionAction("install")).toBe(false);
    expect(isDestructiveExtensionAction("update")).toBe(false);
  });

  it("buildExtensionSql は操作に応じて振り分ける", () => {
    const opts = { schema: "", cascade: false };
    expect(buildExtensionSql("install", "a", opts)).toMatch(/^CREATE EXTENSION/);
    expect(buildExtensionSql("update", "a", opts, "2.0")).toBe("ALTER EXTENSION \"a\" UPDATE TO '2.0'");
    expect(buildExtensionSql("drop", "a", { ...opts, cascade: true })).toBe('DROP EXTENSION "a" CASCADE');
  });
});

describe("shared_preload_libraries", () => {
  it("pg_stat_statements は事前読み込みが要る。接頭辞つきの指定も一致とみなす", () => {
    expect(needsPreload("pg_stat_statements")).toBe(true);
    expect(needsPreload("hstore")).toBe(false);
    expect(isPreloaded("pg_stat_statements", ["auto_explain", "pg_stat_statements"])).toBe(true);
    expect(isPreloaded("pg_stat_statements", ["$libdir/pg_stat_statements"])).toBe(true);
    expect(isPreloaded("pg_stat_statements", [])).toBe(false);
  });
});

describe("matchesExtensionFilter", () => {
  const installed = { installed_version: "1.0", updatable: false };
  const updatable = { installed_version: "1.0", updatable: true };
  const available = { installed_version: null, updatable: false };
  it("絞り込みごとに該当する行だけを通す", () => {
    expect([installed, updatable, available].map((e) => matchesExtensionFilter(e, "all"))).toEqual([
      true,
      true,
      true,
    ]);
    expect([installed, updatable, available].map((e) => matchesExtensionFilter(e, "installed"))).toEqual([
      true,
      true,
      false,
    ]);
    expect([installed, updatable, available].map((e) => matchesExtensionFilter(e, "available"))).toEqual([
      false,
      false,
      true,
    ]);
    expect([installed, updatable, available].map((e) => matchesExtensionFilter(e, "updatable"))).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe("依存オブジェクトのまとめ (#2177)", () => {
  it("種別の並びは列が先頭で、0 件の種別は出さない。未知の種別は other に寄せる", () => {
    const groups = groupExtensionDependents([
      { kind: "view", name: "v" },
      { kind: "function", name: "f" },
      { kind: "column", name: "c1" },
      { kind: "mystery", name: "m" },
      { kind: "column", name: "c2" },
    ]);
    expect(groups.map((g) => [g.kind, g.items.length])).toEqual([
      ["column", 2],
      ["view", 1],
      ["function", 1],
      ["other", 1],
    ]);
    expect(groups[0]?.items.map((i) => i.name)).toEqual(["c1", "c2"]);
    expect(groupExtensionDependents([])).toEqual([]);
  });

  it("表示名は schema.table.name で、無い部分は省く", () => {
    expect(formatExtensionDependent({ schema: "public", table: "t", name: "c" })).toBe("public.t.c");
    expect(formatExtensionDependent({ schema: null, table: null, name: "f()" })).toBe("f()");
  });
});
