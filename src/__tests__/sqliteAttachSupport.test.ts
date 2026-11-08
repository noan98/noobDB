import { describe, expect, it } from "vitest";
import {
  ATTACHED_REJECTED_OPERATIONS,
  attachedUnsupportedReason,
  isSqliteAttachedDatabase,
} from "../components/sqliteAttachSupport";

// アタッチ DB の未対応操作 (#2154)。判定は Rust の `Connection::reject_if_attached_sqlite` と一致させる。
const rustSources = import.meta.glob("../../src-tauri/src/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("attachedUnsupportedReason", () => {
  it("SQLite のアタッチ別名だけが対象で、main / 空 / 大文字小文字違いは対象外", () => {
    for (const db of ["main", "MAIN", "Main", "", null, undefined]) {
      expect(isSqliteAttachedDatabase("sqlite", db)).toBe(false);
      expect(attachedUnsupportedReason("sqlite", db, "rebuildTable")).toBeNull();
    }
    expect(isSqliteAttachedDatabase("sqlite", "archive")).toBe(true);
  });

  it("MySQL / PostgreSQL は別名のように見える値でも常に許可", () => {
    for (const driver of ["mysql", "postgres", null, undefined]) {
      for (const op of Object.keys(
        ATTACHED_REJECTED_OPERATIONS,
      ) as (keyof typeof ATTACHED_REJECTED_OPERATIONS)[]) {
        expect(attachedUnsupportedReason(driver, "archive", op)).toBeNull();
      }
    }
  });

  it("アタッチ DB では 3 操作すべてに理由が付く", () => {
    expect(attachedUnsupportedReason("sqlite", "archive", "rebuildTable")).toBe("attachedUnsupportedRebuild");
    expect(attachedUnsupportedReason("sqlite", "archive", "syncApply")).toBe(
      "schemaCompareApplyAttachedUnsupported",
    );
    expect(attachedUnsupportedReason("sqlite", "archive", "transferCreateReplace")).toBe(
      "attachedUnsupportedTransfer",
    );
  });
});

describe("バックエンドの拒否集合とのパリティ", () => {
  it("reject_if_attached_sqlite の呼び出しが、定義した操作の集合と一致する", () => {
    const found = new Set<string>();
    let calls = 0;
    let literals = 0;
    for (const src of Object.values(rustSources)) {
      // 定義 (`fn reject_if_attached_sqlite`) を除いた呼び出しの数。
      calls += [...src.matchAll(/\.reject_if_attached_sqlite\(/g)].length;
      for (const m of src.matchAll(/\.reject_if_attached_sqlite\(([\s\S]*?)\)\s*\?/g)) {
        const lit = /"([^"]+)"\s*,?\s*$/.exec(m[1] ?? "");
        if (lit?.[1]) {
          found.add(lit[1]);
          literals += 1;
        }
      }
    }
    // 文言を変数で渡す・`?` 以外で受けるなど、抜き出せない呼び出しを黙って取りこぼさない。
    expect(calls).toBeGreaterThan(0);
    expect(literals).toBe(calls);
    expect([...found].sort()).toEqual(Object.values(ATTACHED_REJECTED_OPERATIONS).sort());
  });
});
