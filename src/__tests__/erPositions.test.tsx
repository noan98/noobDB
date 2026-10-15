import { beforeEach, describe, expect, it } from "vitest";
import {
  ER_LAYOUT_MAX_ENTRIES,
  clearErLayout,
  erLayoutKey,
  mergeErLayout,
  readErLayout,
  sanitizeErLayouts,
  writeErLayout,
} from "../components/erPositions";

beforeEach(() => {
  localStorage.clear();
});

describe("ER 図のノード位置の保存 (#1628)", () => {
  it("保存した位置を同じ接続・DB・方向・密度で読み戻せる", () => {
    writeErLayout("p1", "app", "LR", "comfortable", { users: { x: 10, y: 20 } });
    expect(readErLayout("p1", "app", "LR", "comfortable")).toEqual({ users: { x: 10, y: 20 } });
  });

  it("接続や DB が違えば別物、方向/密度が違えば使わない", () => {
    writeErLayout("p1", "app", "LR", "comfortable", { users: { x: 1, y: 2 } });
    expect(readErLayout("p2", "app", "LR", "comfortable")).toBeNull();
    expect(readErLayout("p1", "other", "LR", "comfortable")).toBeNull();
    expect(readErLayout("p1", "app", "TB", "comfortable")).toBeNull();
    expect(readErLayout("p1", "app", "LR", "compact")).toBeNull();
  });

  it("同じ方向/密度では既存分とマージし、別の方向/密度では置き換える", () => {
    writeErLayout("p1", "app", "LR", "comfortable", { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } });
    writeErLayout("p1", "app", "LR", "comfortable", { b: { x: 9, y: 9 } });
    expect(readErLayout("p1", "app", "LR", "comfortable")).toEqual({ a: { x: 1, y: 1 }, b: { x: 9, y: 9 } });
    writeErLayout("p1", "app", "TB", "comfortable", { c: { x: 3, y: 3 } });
    expect(readErLayout("p1", "app", "LR", "comfortable")).toBeNull();
    expect(readErLayout("p1", "app", "TB", "comfortable")).toEqual({ c: { x: 3, y: 3 } });
  });

  it("リセットで消える", () => {
    writeErLayout("p1", "app", "LR", "comfortable", { a: { x: 1, y: 1 } });
    clearErLayout("p1", "app");
    expect(readErLayout("p1", "app", "LR", "comfortable")).toBeNull();
  });

  it("壊れた保存値や不正な座標は無視して自動レイアウトに倒す", () => {
    localStorage.setItem("noobdb.erPositions.v1", "{not json");
    expect(readErLayout("p1", "app", "LR", "comfortable")).toBeNull();
    expect(
      sanitizeErLayouts({
        k: {
          direction: "LR",
          density: "compact",
          positions: { a: { x: 1, y: 2 }, b: { x: "1", y: 2 }, c: { x: NaN, y: 0 } },
        },
        bad: { direction: 1 },
        arr: [],
      }),
    ).toEqual({ k: { direction: "LR", density: "compact", positions: { a: { x: 1, y: 2 } } } });
  });

  it("保存数が上限を超えたら古い順に捨てる", () => {
    let all = {};
    for (let i = 0; i < ER_LAYOUT_MAX_ENTRIES + 3; i++) {
      all = mergeErLayout(all, erLayoutKey("p", `db${i}`), "LR", "comfortable", { t: { x: i, y: i } });
    }
    const keys = Object.keys(all);
    expect(keys).toHaveLength(ER_LAYOUT_MAX_ENTRIES);
    expect(keys).not.toContain(erLayoutKey("p", "db0"));
    expect(keys).toContain(erLayoutKey("p", `db${ER_LAYOUT_MAX_ENTRIES + 2}`));
  });
});
