import { describe, expect, it } from "vitest";
import {
  changeSetStatementText,
  decideReplaceGuard,
  discardedEditsForUndo,
  pendingChangeCounts,
  routeOfPageNav,
} from "../pendingGuard";
import type { DirtyTabLike } from "../tabDirty";

const tab = (over: Partial<DirtyTabLike & { applyingEdits?: boolean }> = {}) => ({
  kind: "table",
  pendingEdits: {},
  pendingDeletes: [],
  pendingInserts: [],
  ...over,
});

describe("routeOfPageNav", () => {
  it("ページ送りはページ番号だけ", () => {
    expect(routeOfPageNav(undefined, undefined)).toBe("page");
    expect(routeOfPageNav(undefined, { force: true } as never)).toBe("page");
  });
  it("ページサイズ", () => {
    expect(routeOfPageNav(50, undefined)).toBe("pageSize");
  });
  it("サーバ側ソート / フィルタ (解除の null も含む)", () => {
    expect(routeOfPageNav(undefined, { sort: { column: "a" } })).toBe("sort");
    expect(routeOfPageNav(undefined, { sort: null })).toBe("sort");
    expect(routeOfPageNav(undefined, { filter: null })).toBe("filter");
  });
});

describe("pendingChangeCounts", () => {
  it("セル数 / 削除行 / 追加行を数え、空の行エントリは数えない", () => {
    expect(
      pendingChangeCounts({
        pendingEdits: { "1": { 0: "a", 2: "b" }, "2": {}, "3": { 1: "c" } },
        pendingDeletes: ["9"],
        pendingInserts: [{ 0: "x" }, { 0: "y" }],
      }),
    ).toEqual({ edits: 3, editedRows: 3, deletes: 1, inserts: 2 });
  });
});

describe("decideReplaceGuard", () => {
  const dirty = {
    セル編集: tab({ pendingEdits: { "1": { 0: "a" } } }),
    削除予定: tab({ pendingDeletes: ["1"] }),
    追加行: tab({ pendingInserts: [{ 0: "a" }] }),
  };

  // 判定は経路 (ページ送り / ソート / フィルタ / 再実行 / TX) に依らず同じ。3 種のどれでも確認が出る。
  for (const [label, t] of Object.entries(dirty)) {
    it(`${label}があれば確認`, () => {
      expect(decideReplaceGuard({ tab: t }).kind).toBe("confirm");
    });
  }

  it("変更が無ければそのまま続行", () => {
    expect(decideReplaceGuard({ tab: tab() })).toEqual({ kind: "proceed" });
  });

  it("空の行エントリだけなら続行", () => {
    expect(decideReplaceGuard({ tab: tab({ pendingEdits: { "1": {} } }) })).toEqual({ kind: "proceed" });
  });

  it("件数を返す", () => {
    const g = decideReplaceGuard({ tab: tab({ pendingEdits: { "1": { 0: "a" } }, pendingDeletes: ["2"] }) });
    expect(g).toEqual({ kind: "confirm", counts: { edits: 1, editedRows: 1, deletes: 1, inserts: 0 } });
  });

  it("skip (自動リフレッシュ / 確認済みの再入) なら変更があっても続行", () => {
    expect(decideReplaceGuard({ tab: tab({ pendingDeletes: ["1"] }), skip: true })).toEqual({
      kind: "proceed",
    });
  });

  it("タブが無ければ続行 (置き換え対象が無い)", () => {
    expect(decideReplaceGuard({ tab: null })).toEqual({ kind: "proceed" });
    expect(decideReplaceGuard({ tab: undefined })).toEqual({ kind: "proceed" });
  });

  it("Apply 実行中は確認ではなく保留", () => {
    expect(decideReplaceGuard({ tab: tab({ pendingDeletes: ["1"], applyingEdits: true }) })).toEqual({
      kind: "applying",
    });
  });

  it("Apply 実行中でも変更が無ければ続行 (判定は変更の有無が先)", () => {
    expect(decideReplaceGuard({ tab: tab({ applyingEdits: true }) })).toEqual({ kind: "proceed" });
  });
});

describe("discardedEditsForUndo", () => {
  it("セル編集があればそのまま返し、無ければ null (削除予定・追加行だけでは積まない)", () => {
    const edits = { "1": { 0: "a" } };
    expect(discardedEditsForUndo(edits)).toBe(edits);
    expect(discardedEditsForUndo({})).toBeNull();
    expect(discardedEditsForUndo({ "1": {} })).toBeNull();
  });
});

describe("changeSetStatementText", () => {
  it("送る文の種類と件数を UPDATE / INSERT / DELETE の順で並べる", () => {
    expect(changeSetStatementText({ editedRows: 3, inserts: 1, deletes: 2 })).toBe(
      "UPDATE 3 / INSERT 1 / DELETE 2",
    );
  });

  it("0 件の種類は省く", () => {
    expect(changeSetStatementText({ editedRows: 0, inserts: 0, deletes: 2 })).toBe("DELETE 2");
    expect(changeSetStatementText({ editedRows: 2, inserts: 0, deletes: 0 })).toBe("UPDATE 2");
    expect(changeSetStatementText({ editedRows: 0, inserts: 0, deletes: 0 })).toBe("");
  });
});
