import { describe, expect, it } from "vitest";

import type { ForeignKey, SandboxConflict, SandboxRecord } from "../api/tauri";
import {
  SANDBOX_DEFAULT_ROW_LIMIT,
  SANDBOX_MAX_ROW_LIMIT,
  SANDBOX_SHADOW_PREFIX,
  clampSandboxRowLimit,
  isSandboxProfileId,
  isSandboxShadowTableName,
  sandboxFkClosure,
  sandboxIdFromProfileId,
  sandboxKeySignature,
  sandboxProfileId,
  sandboxSkipKeys,
  sandboxToProfile,
  unresolvedSandboxConflicts,
} from "../sandbox";

describe("isSandboxShadowTableName", () => {
  it("影テーブル名を判定する", () => {
    expect(isSandboxShadowTableName(`${SANDBOX_SHADOW_PREFIX}orders`)).toBe(true);
    expect(isSandboxShadowTableName("orders")).toBe(false);
  });
});

describe("clampSandboxRowLimit", () => {
  it("未指定/0 以下は既定値", () => {
    expect(clampSandboxRowLimit(undefined)).toBe(SANDBOX_DEFAULT_ROW_LIMIT);
    expect(clampSandboxRowLimit(null)).toBe(SANDBOX_DEFAULT_ROW_LIMIT);
    expect(clampSandboxRowLimit(0)).toBe(SANDBOX_DEFAULT_ROW_LIMIT);
    expect(clampSandboxRowLimit(-5)).toBe(SANDBOX_DEFAULT_ROW_LIMIT);
    expect(clampSandboxRowLimit(Number.NaN)).toBe(SANDBOX_DEFAULT_ROW_LIMIT);
  });

  it("上限でクランプする", () => {
    expect(clampSandboxRowLimit(SANDBOX_MAX_ROW_LIMIT * 10)).toBe(SANDBOX_MAX_ROW_LIMIT);
  });

  it("範囲内はそのまま (整数化)", () => {
    expect(clampSandboxRowLimit(42.9)).toBe(42);
  });
});

describe("sandboxKeySignature", () => {
  it("整数と文字列を区別する", () => {
    expect(sandboxKeySignature([1])).not.toBe(sandboxKeySignature(["1"]));
  });

  it("同じ複合キーは同じ署名になる", () => {
    expect(sandboxKeySignature([1, "a"])).toBe(sandboxKeySignature([1, "a"]));
  });
});

function conflict(key: number, externalRow: number[] | null): SandboxConflict {
  return {
    key: [key],
    desired_status: "different",
    external_status: externalRow ? "different" : "target_only",
    external_row: externalRow,
  };
}

describe("unresolvedSandboxConflicts / sandboxSkipKeys", () => {
  it("未解決の競合のみを返す", () => {
    const conflicts = [conflict(1, [1, 2]), conflict(2, [2, 3])];
    const resolutions = { [sandboxKeySignature([1])]: "overwrite" as const };
    const unresolved = unresolvedSandboxConflicts(conflicts, resolutions);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].key).toEqual([2]);
  });

  it("すべて解決済みなら空配列", () => {
    const conflicts = [conflict(1, [1, 2])];
    const resolutions = { [sandboxKeySignature([1])]: "skip" as const };
    expect(unresolvedSandboxConflicts(conflicts, resolutions)).toEqual([]);
  });

  it("skip と解決された行の主キーのみを返す", () => {
    const conflicts = [conflict(1, [1, 2]), conflict(2, null), conflict(3, [3, 4])];
    const resolutions = {
      [sandboxKeySignature([1])]: "skip" as const,
      [sandboxKeySignature([2])]: "overwrite" as const,
      // key 3 は未解決のまま。
    };
    expect(sandboxSkipKeys(conflicts, resolutions)).toEqual([[1]]);
  });

  it("解決が無ければ空配列", () => {
    const conflicts = [conflict(1, [1, 2])];
    expect(sandboxSkipKeys(conflicts, {})).toEqual([]);
  });
});

function fk(table: string, referenced: string): ForeignKey {
  return {
    table,
    column: "x_id",
    referenced_table: referenced,
    referenced_column: "id",
    constraint_name: null,
  };
}

describe("sandboxFkClosure", () => {
  it("推移的に参照先テーブルを取り込む", () => {
    const fks = [fk("orders", "customers"), fk("customers", "regions")];
    expect(sandboxFkClosure(["orders"], fks)).toEqual(["customers", "orders", "regions"]);
  });

  it("参照してくる側 (被参照) は取り込まない (片方向)", () => {
    // order_items -> orders だが orders を選んだだけでは order_items は入らない。
    const fks = [fk("order_items", "orders")];
    expect(sandboxFkClosure(["orders"], fks)).toEqual(["orders"]);
  });

  it("関連 FK が無ければ選択そのまま", () => {
    expect(sandboxFkClosure(["z"], [fk("a", "b")])).toEqual(["z"]);
  });
});

describe("sandboxProfileId / isSandboxProfileId / sandboxIdFromProfileId", () => {
  it("往復する", () => {
    const pid = sandboxProfileId("abcd1234");
    expect(isSandboxProfileId(pid)).toBe(true);
    expect(sandboxIdFromProfileId(pid)).toBe("abcd1234");
  });

  it("通常のプロファイル id は合成 id として扱わない", () => {
    expect(isSandboxProfileId("abcd1234")).toBe(false);
    expect(sandboxIdFromProfileId("abcd1234")).toBeNull();
  });
});

describe("sandboxToProfile", () => {
  const record: SandboxRecord = {
    id: "abcd1234",
    name: "My Sandbox",
    source_profile_id: "prof1",
    source_driver: "mysql",
    source_database: "appdb",
    tables: ["orders"],
    row_limit: 5000,
    file_path: "/tmp/abcd1234.sqlite",
    created_at: "2026-01-01T00:00:00Z",
    truncated_tables: [],
  };

  it("非永続の合成プロファイルを作る", () => {
    const profile = sandboxToProfile(record);
    expect(profile.id).toBe(sandboxProfileId("abcd1234"));
    expect(profile.driver).toBe("sqlite");
    expect(profile.file_path).toBe(record.file_path);
    expect(profile.name).toBe("My Sandbox");
    expect(profile.is_production).toBe(false);
    expect(profile.read_only).toBe(false);
    expect(isSandboxProfileId(profile.id)).toBe(true);
  });
});
