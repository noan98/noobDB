import { describe, it, expect } from "vitest";
import { DEFAULT_DUMP_OPTIONS, DUMP_OPTION_KEY_KINDS, DRIVER_OPTIONS, OPTION_ROWS } from "../dumpOptionForm";
import { DUMP_BOOL_KEYS } from "../inputMemory";

/**
 * `DumpOptions` の全キーが、DumpModal とタスクスケジューラのダンプ設定の**両方**で扱われることを固定する (#2131)。
 * 両画面は同じ部品 (`DumpOptionsFields`) と同じ定義 (`dumpOptionForm`) を使うので、ここでは
 * 定義側の網羅性を見る。`DumpOptions` に項目を足すと `DUMP_OPTION_KEY_KINDS` の型検査で止まる。
 */
describe("ダンプオプションの両フォーム網羅 (#2131)", () => {
  const kinds = Object.entries(DUMP_OPTION_KEY_KINDS);

  it("toggle に分類された全キーが、スイッチ行を持ち、いずれかのドライバで表示される", () => {
    const rowKeys = new Set<string>(OPTION_ROWS.map((r) => r.key));
    const shown = new Set<string>(Object.values(DRIVER_OPTIONS).flat());
    for (const [key, kind] of kinds) {
      if (kind !== "toggle") continue;
      expect(rowKeys.has(key), `${key} に OPTION_ROWS の行が無い`).toBe(true);
      expect(shown.has(key), `${key} がどのドライバにも表示されない`).toBe(true);
    }
    // 逆向き: スイッチ行は必ず toggle として分類されている。
    for (const row of OPTION_ROWS) {
      expect(DUMP_OPTION_KEY_KINDS[row.key]).toBe("toggle");
    }
  });

  it("engine (native) はエンジン選択のあるドライバで選べる", () => {
    expect(DRIVER_OPTIONS.mysql).toContain("native");
    expect(DRIVER_OPTIONS.postgres).toContain("native");
  });

  it("真偽値のキーは、前回値の記憶 (inputMemory) の対象と一致する", () => {
    const toggles = kinds.filter(([, k]) => k === "toggle" || k === "engine").map(([key]) => key);
    expect([...DUMP_BOOL_KEYS].sort()).toEqual([...toggles].sort());
  });

  it("新規の既定値は全スイッチ行のキーを含む (DumpModal と新規タスクで共通)", () => {
    for (const row of OPTION_ROWS) {
      expect(DEFAULT_DUMP_OPTIONS[row.key], `${row.key} の既定値が無い`).not.toBeUndefined();
    }
  });
});
