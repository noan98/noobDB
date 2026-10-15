import { describe, expect, it } from "vitest";
import type { ConnectionProfile } from "../api/tauri";
import { BACKGROUND_PING_INTERVAL_MS, nextStaleProfileIds } from "../backgroundHealth";
import { buildGroupMoveRequest, existingGroupNames, normalizeGroupName } from "../profileGroup";
import { filterProfileCards, profileGroupNames, UNGROUPED_FILTER } from "../profileSearch";
import {
  EMPTY_PROFILE_SELECTION,
  isProfileSelected,
  orderedSelectedProfileIds,
  profileSelectionSize,
  pruneProfileSelection,
  rangeProfileSelection,
  toggleProfileSelection,
} from "../profileSelection";

function prof(id: string, over: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id,
    name: `name-${id}`,
    driver: "mysql",
    host: `${id}.example.com`,
    port: 3306,
    user: "app",
    database: null,
    ssh: null,
    group: null,
    color: null,
    is_production: false,
    confirm_writes: false,
    read_only: false,
    skip_history: false,
    file_path: null,
    ...over,
  };
}

describe("profileSelection (#1630)", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("Ctrl+クリックで出し入れし、起点を更新する", () => {
    let sel = toggleProfileSelection(EMPTY_PROFILE_SELECTION, "b");
    expect(isProfileSelected(sel, "b")).toBe(true);
    expect(sel.anchor).toBe("b");
    sel = toggleProfileSelection(sel, "d");
    expect(profileSelectionSize(sel)).toBe(2);
    sel = toggleProfileSelection(sel, "b");
    expect([...sel.ids]).toEqual(["d"]);
  });

  it("Shift+クリックは起点から範囲を選び、起点は動かさない", () => {
    let sel = toggleProfileSelection(EMPTY_PROFILE_SELECTION, "b");
    sel = rangeProfileSelection(sel, order, "d");
    expect(orderedSelectedProfileIds(sel, order)).toEqual(["b", "c", "d"]);
    expect(sel.anchor).toBe("b");
    // 逆向きの範囲取り直しは置き換え。
    sel = rangeProfileSelection(sel, order, "a");
    expect(orderedSelectedProfileIds(sel, order)).toEqual(["a", "b"]);
  });

  it("起点が無いときの Shift は単独選択、additive は既存の選択に足す", () => {
    const single = rangeProfileSelection(EMPTY_PROFILE_SELECTION, order, "c");
    expect([...single.ids]).toEqual(["c"]);
    const base = toggleProfileSelection(EMPTY_PROFILE_SELECTION, "a");
    const added = rangeProfileSelection({ ids: new Set(["e"]), anchor: base.anchor }, order, "b", true);
    expect(orderedSelectedProfileIds(added, order)).toEqual(["a", "b", "e"]);
  });

  it("消えた行は選択から外れ、起点も外れる", () => {
    const sel = rangeProfileSelection(toggleProfileSelection(EMPTY_PROFILE_SELECTION, "a"), order, "c");
    const pruned = pruneProfileSelection(sel, ["a", "b", "x"]);
    expect([...pruned.ids].sort()).toEqual(["a", "b"]);
    const noAnchor = pruneProfileSelection(sel, ["b", "c"]);
    expect(noAnchor.anchor).toBeNull();
    // 変化が無ければ同一参照。
    expect(pruneProfileSelection(sel, order)).toBe(sel);
  });
});

describe("profileGroup (#1630)", () => {
  it("グループ名は前後の空白を除き、空は未分類 (null)", () => {
    expect(normalizeGroupName("  prod  ")).toBe("prod");
    expect(normalizeGroupName("   ")).toBeNull();
    expect(normalizeGroupName(null)).toBeNull();
  });

  it("既存グループは重複なし・名前順で未分類を含めない", () => {
    expect(
      existingGroupNames([
        prof("1", { group: "b" }),
        prof("2"),
        prof("3", { group: "a" }),
        prof("4", { group: "b" }),
      ]),
    ).toEqual(["a", "b"]);
  });

  it("グループ移動リクエストは group だけを変え、秘密のフィールドを含めない", () => {
    const p = prof("p1", {
      group: "old",
      color: "#123456",
      is_production: true,
      ssh: { host: "h", port: 22, user: "u", auth_method: "key", private_key_path: "/k", local_port: 15432 },
      ssl_mode: "require",
      init_sql: "SET x=1",
    });
    const req = buildGroupMoveRequest(p, "  new ");
    expect(req.group).toBe("new");
    expect(req.id).toBe("p1");
    expect(req.is_production).toBe(true);
    expect(req.ssh?.local_port).toBe(15432);
    expect(req.ssl_mode).toBe("require");
    expect(req.init_sql).toBe("SET x=1");
    for (const secret of [
      "db_password",
      "ssh_passphrase",
      "ssh_password",
      "ssh_jump_passphrase",
      "ssh_jump_password",
    ]) {
      expect(secret in req).toBe(false);
    }
    expect(buildGroupMoveRequest(p, "").group).toBeNull();
  });
});

describe("profileSearch (#1630)", () => {
  const list = [
    prof("1", { name: "Prod DB", group: "production", host: "prod.example.com" }),
    prof("2", { name: "Staging", group: "stg", database: "shop" }),
    prof("3", { name: "Scratch", driver: "sqlite", file_path: "/tmp/scratch.db", host: "" }),
  ];

  it("名前・ホスト・DB・ファイル・グループを大小無視の AND で絞り込む", () => {
    expect(filterProfileCards(list, "prod", null).map((p) => p.id)).toEqual(["1"]);
    expect(filterProfileCards(list, "SHOP stg", null).map((p) => p.id)).toEqual(["2"]);
    expect(filterProfileCards(list, "scratch.db", null).map((p) => p.id)).toEqual(["3"]);
    expect(filterProfileCards(list, "  ", null)).toHaveLength(3);
  });

  it("グループのチップと検索語を組み合わせ、未分類のみも選べる", () => {
    expect(filterProfileCards(list, "", "stg").map((p) => p.id)).toEqual(["2"]);
    expect(filterProfileCards(list, "", UNGROUPED_FILTER).map((p) => p.id)).toEqual(["3"]);
    expect(filterProfileCards(list, "prod", "stg")).toEqual([]);
  });

  it("チップに出すグループ名は名前順で未分類を含めない", () => {
    expect(profileGroupNames(list)).toEqual(["production", "stg"]);
  });
});

describe("backgroundHealth (#1630)", () => {
  it("切れた背景接続を加え、生き返ったものを外す", () => {
    const reg = ["a", "b", "c"];
    let s = nextStaleProfileIds(
      new Set(),
      [
        { profileId: "a", alive: false },
        { profileId: "b", alive: true },
      ],
      reg,
    );
    expect([...s]).toEqual(["a"]);
    s = nextStaleProfileIds(s, [{ profileId: "a", alive: true }], reg);
    expect(s.size).toBe(0);
  });

  it("開いていない接続は集合から落ち、変化が無ければ同一参照を返す", () => {
    const prev = new Set(["a", "gone"]);
    const next = nextStaleProfileIds(prev, [], ["a"]);
    expect([...next]).toEqual(["a"]);
    expect(nextStaleProfileIds(next, [], ["a"])).toBe(next);
    // 登録に居ないプロファイルの結果は無視する。
    expect(nextStaleProfileIds(new Set(), [{ profileId: "zzz", alive: false }], ["a"]).size).toBe(0);
  });

  it("確認間隔は低頻度 (30 秒以上)", () => {
    expect(BACKGROUND_PING_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe("savedTabsSummary (#1630)", () => {
  it("タブ数・ペイン・先頭の空でない SQL 行を要約し、長い行は切る", async () => {
    const { summarizeSavedWorkspace, sqlHeadLine } = await import("../savedTabsSummary");
    const ws = {
      activePane: 0,
      panes: [
        {
          activeIndex: 0,
          tabs: [
            { kind: "query" as const, title: "Query 1", sql: "\n\n  SELECT 1;\nSELECT 2" },
            { kind: "table" as const, title: "users", database: "app", table: "users", sql: "" },
          ],
        },
        {
          activeIndex: 0,
          tabs: [{ kind: "explain" as const, title: "E", database: "app", sql: "EXPLAIN x" }],
        },
      ],
    };
    const s = summarizeSavedWorkspace(ws);
    expect(s.total).toBe(3);
    expect(s.panes.map((p) => p.tabs.length)).toEqual([2, 1]);
    expect(s.panes[0].tabs[0].sqlHead).toBe("SELECT 1;");
    expect(s.panes[0].tabs[1]).toMatchObject({ target: "app.users", sqlHead: "" });
    expect(s.panes[1].tabs[0].target).toBe("app");
    expect(sqlHeadLine("x".repeat(100), 10)).toBe(`${"x".repeat(10)}…`);
  });
});
