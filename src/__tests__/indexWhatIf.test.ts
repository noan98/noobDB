import { describe, expect, it } from "vitest";
import type { IndexWhatIfModeSupport, IndexWhatIfSupport } from "../api/tauri";
import {
  buildWhatIfRequest,
  canRunWhatIf,
  toggleWhatIfColumn,
  WHATIF_UNAVAILABLE_KEY,
  whatIfModeSupport,
  type WhatIfFormState,
} from "../components/indexWhatIf";
import { dictionaries } from "../i18n";

const ok = (over: Partial<IndexWhatIfModeSupport> = {}): IndexWhatIfModeSupport => ({
  method: "hypopg",
  unavailable: null,
  locksTable: false,
  buildsIndex: false,
  ...over,
});
const no = (unavailable: IndexWhatIfModeSupport["unavailable"]): IndexWhatIfModeSupport => ({
  method: null,
  unavailable,
  locksTable: false,
  buildsIndex: false,
});
const form = (over: Partial<WhatIfFormState> = {}): WhatIfFormState => ({
  database: "public",
  table: "t",
  sql: "SELECT 1",
  action: "disable",
  index: "idx_a",
  columns: [],
  confirmed: false,
  ...over,
});

describe("インデックス試算の純ロジック (#2326)", () => {
  it("種類に対応する可否を選ぶ", () => {
    const s: IndexWhatIfSupport = { hypopgVersion: null, disable: ok(), add: no("needsHypopg") };
    expect(whatIfModeSupport(s, "disable")).toBe(s.disable);
    expect(whatIfModeSupport(s, "add")).toBe(s.add);
    expect(whatIfModeSupport(null, "add")).toBeNull();
  });

  it("使えない方法・指定不足は実行できない", () => {
    expect(canRunWhatIf(form(), ok())).toBe(true);
    expect(canRunWhatIf(form(), no("readOnly"))).toBe(false);
    expect(canRunWhatIf(form(), null)).toBe(false);
    expect(canRunWhatIf(form({ index: "" }), ok())).toBe(false);
    expect(canRunWhatIf(form({ sql: "  " }), ok())).toBe(false);
    expect(canRunWhatIf(form({ action: "add", columns: [] }), ok())).toBe(false);
    expect(canRunWhatIf(form({ action: "add", columns: ["a"] }), ok())).toBe(true);
  });

  it("ロックを取る経路は同意するまで実行できない", () => {
    const locking = ok({ method: "rollbackDdl", locksTable: true });
    expect(canRunWhatIf(form(), locking)).toBe(false);
    expect(canRunWhatIf(form({ confirmed: true }), locking)).toBe(true);
  });

  it("依頼は種類に応じた項目だけを持ち、同意はロックを取る経路でだけ立つ", () => {
    const locking = ok({ method: "rollbackDdl", locksTable: true });
    expect(buildWhatIfRequest(form({ confirmed: true }), locking)).toMatchObject({
      action: "disable",
      index: "idx_a",
      columns: [],
      confirmLocking: true,
    });
    expect(
      buildWhatIfRequest(form({ action: "add", columns: ["a", "b"], index: "stale", confirmed: true }), ok()),
    ).toMatchObject({ action: "add", index: null, columns: ["a", "b"], confirmLocking: false });
  });

  it("列の選択は選んだ順を保ち、再クリックで外れる", () => {
    expect(toggleWhatIfColumn([], "a")).toEqual(["a"]);
    expect(toggleWhatIfColumn(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleWhatIfColumn(["a", "b"], "a")).toEqual(["b"]);
  });

  it("使えない理由の文言が ja / en の両方にある", () => {
    for (const key of Object.values(WHATIF_UNAVAILABLE_KEY)) {
      expect(dictionaries.ja[key]).toBeTruthy();
      expect(dictionaries.en[key]).toBeTruthy();
    }
  });
});
