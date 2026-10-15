import { describe, expect, it } from "vitest";
import { parseKeybindings, planBindingAssignment, serializeKeybindings } from "../keybindingIO";
import { resolveShortcutBindings } from "../shortcuts";

// 保存時の検証 (settings.ts の sanitizeShortcutOverrides) と同じ基準: 空でない文字列だけ残す。
const sanitize = (input: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim().length > 0) out[k] = v;
  }
  return out;
};

describe("planBindingAssignment (#1631)", () => {
  it("衝突しなければ 1 件だけ変える", () => {
    expect(planBindingAssignment({}, "commandPalette", "Mod+Shift+9")).toEqual({
      changes: { commandPalette: "Mod+Shift+9" },
      swapped: null,
    });
  });
  it("同じスコープで使用中のコンボなら相手と入れ替える (表記ゆれも同一視)", () => {
    const r = resolveShortcutBindings({});
    const plan = planBindingAssignment({}, "commandPalette", "mod+p");
    expect(plan.swapped).toBe("sidebarFilter");
    expect(plan.changes).toEqual({ commandPalette: "mod+p", sidebarFilter: r.commandPalette });
  });
  it("入れ替えを反映すると衝突が残らない", () => {
    const plan = planBindingAssignment({}, "commandPalette", "Mod+P");
    const after = resolveShortcutBindings(plan.changes);
    expect(after.commandPalette).toBe("Mod+P");
    expect(after.sidebarFilter).toBe("Mod+K");
  });
});

describe("serialize / parseKeybindings (#1631)", () => {
  it("既定と同じ値は書き出さず、往復で復元できる", () => {
    const json = serializeKeybindings({ commandPalette: "Mod+Shift+9", sidebarFilter: "Mod+P" });
    const parsed = JSON.parse(json);
    expect(parsed.kind).toBe("noobdb-keybindings");
    expect(parsed.bindings).toEqual({ commandPalette: "Mod+Shift+9" });
    const back = parseKeybindings(json, sanitize);
    expect(back).toEqual({ ok: true, bindings: { commandPalette: "Mod+Shift+9" }, ignored: 0, conflicts: 0 });
  });
  it("素の { id: combo } も受け、未知の id・空文字は無視として数える", () => {
    const r = parseKeybindings(
      JSON.stringify({ commandPalette: "Mod+Shift+9", nope: "Mod+Q", sidebarFilter: "  ", n: 3 }),
      sanitize,
    );
    expect(r).toEqual({ ok: true, bindings: { commandPalette: "Mod+Shift+9" }, ignored: 3, conflicts: 0 });
  });
  it("取り込み後に衝突するアクション数を返す", () => {
    const r = parseKeybindings(JSON.stringify({ bindings: { commandPalette: "Mod+P" } }), sanitize);
    expect(r.ok && r.conflicts).toBe(2);
  });
  it("壊れた JSON・オブジェクトでないものは失敗", () => {
    expect(parseKeybindings("{", sanitize)).toEqual({ ok: false });
    expect(parseKeybindings("[1]", sanitize)).toEqual({ ok: false });
    expect(parseKeybindings('{"bindings":5}', sanitize)).toEqual({ ok: false });
  });
});
