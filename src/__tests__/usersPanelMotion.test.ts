import { describe, expect, it } from "vitest";
import { FIRST_BATCH_REVEAL_MAX_STEPS } from "../components/firstBatchReveal";
import {
  addedRoles,
  changedPrivilegeCells,
  isStaggerAnimated,
  PRIVILEGE_COLLAPSE_EXIT_MAX_ROWS,
  privilegeExitMode,
  USERS_PANEL_STAGGER_MAX_STEPS,
} from "../components/usersPanelMotion";

const off = { select: false, insert: false, update: false, delete: false, ddl: false };
const sel = { ...off, select: true };

describe("changedPrivilegeCells (#1890)", () => {
  it("値が変わった列だけを表ごとに返し、変化の無い行は含めない", () => {
    const out = changedPrivilegeCells(
      { a: sel, b: sel },
      { a: { ...sel, insert: true, select: false }, b: sel },
    );
    expect([...out.keys()]).toEqual(["a"]);
    expect([...(out.get("a") ?? [])].sort()).toEqual(["insert", "select"]);
  });

  it("片方にしか無い表は全 OFF として比べる (新規 GRANT の行 / 全剥奪で消えた行)", () => {
    const out = changedPrivilegeCells({ gone: sel }, { fresh: { ...off, ddl: true }, empty: off });
    expect([...(out.get("gone") ?? [])]).toEqual(["select"]);
    expect([...(out.get("fresh") ?? [])]).toEqual(["ddl"]);
    expect(out.has("empty")).toBe(false);
  });

  it("変更が無ければ空", () => {
    expect(changedPrivilegeCells({ a: sel }, { a: { ...sel } }).size).toBe(0);
  });
});

describe("addedRoles (#1890)", () => {
  it("新しく加わったロールだけを返す", () => {
    expect([...addedRoles(["r1"], ["r1", "r2"])]).toEqual(["r2"]);
    expect(addedRoles(["r1"], []).size).toBe(0);
  });
});

describe("isStaggerAnimated (#1890)", () => {
  it("段数の上限は初回バッチリビールの 12 段に揃い、それ以降は stagger に載せない", () => {
    expect(USERS_PANEL_STAGGER_MAX_STEPS).toBe(FIRST_BATCH_REVEAL_MAX_STEPS);
    expect(isStaggerAnimated(0)).toBe(true);
    expect(isStaggerAnimated(FIRST_BATCH_REVEAL_MAX_STEPS - 1)).toBe(true);
    expect(isStaggerAnimated(FIRST_BATCH_REVEAL_MAX_STEPS)).toBe(false);
    expect(isStaggerAnimated(-1)).toBe(false);
  });
});

describe("privilegeExitMode (#1890)", () => {
  it("無効なら即時、100 行以内は縮む退場、超えたら opacity のみ", () => {
    expect(privilegeExitMode(false, 3)).toBe("none");
    expect(privilegeExitMode(true, 1)).toBe("collapse");
    expect(privilegeExitMode(true, PRIVILEGE_COLLAPSE_EXIT_MAX_ROWS)).toBe("collapse");
    expect(privilegeExitMode(true, PRIVILEGE_COLLAPSE_EXIT_MAX_ROWS + 1)).toBe("fade");
  });
});
