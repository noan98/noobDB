import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, renderWithProviders, screen } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";

/**
 * Issue #1342: 仮想化したスキーマ行リストの `scrollMargin` を、再レンダーのたびに
 * `getBoundingClientRect` で測っていた (強制リフロー)。ConnectionList が再レンダーされても
 * レイアウトを読まないことを、呼び出し回数で固定する。
 */
const TABLES = vi.hoisted(() => Array.from({ length: 300 }, (_, i) => `t${String(i).padStart(4, "0")}`));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listDatabases: vi.fn().mockResolvedValue(["db1"]),
      listTables: vi.fn().mockResolvedValue(TABLES),
      describeTable: vi.fn().mockResolvedValue([]),
      listIndexes: vi.fn().mockResolvedValue([]),
      tableRowEstimates: vi.fn().mockResolvedValue([]),
      listSchemaObjects: vi.fn().mockResolvedValue([]),
      loadSchemaTree: vi.fn(async () => ({ databases: ["db1"], open: [], tables: [] })),
      listTablesAll: vi.fn(async () => [{ database: "db1", tables: TABLES }]),
    },
  };
});

import { ConnectionList } from "../components/ConnectionList";

const noop = () => {};
const profile = makeProfile({ id: "p-a", name: "Alpha DB" });
const profiles = [profile];
const baseProps = {
  profiles,
  activeProfileId: "p-a",
  sessionId: "s1",
  connectingId: null,
  errorProfileId: null,
  onConnect: noop,
  onCreate: noop,
  onEdit: noop,
  onDuplicate: noop,
  onDelete: noop,
  onPickTable: noop,
  onImportTable: noop,
  onDumpDatabase: noop,
  onRunTableSelect: noop,
  onInsertTableSelect: noop,
  onOpenObjectDefinition: noop,
  selectLimit: 200,
};

describe("スキーマ行リストの位置計測 (#1342)", () => {
  const protoH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const protoW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  beforeEach(() => {
    localStorage.clear();
    // react-virtual は窓の寸法を offsetHeight から取る。jsdom は 0 を返すので実寸を与える。
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
  });
  afterEach(() => {
    if (protoH) Object.defineProperty(HTMLElement.prototype, "offsetHeight", protoH);
    if (protoW) Object.defineProperty(HTMLElement.prototype, "offsetWidth", protoW);
  });

  it("仮想化中に ConnectionList が再レンダーされても getBoundingClientRect を呼ばない", async () => {
    const view = renderWithProviders(<ConnectionList {...baseProps} />);
    fireEvent.click(await screen.findByRole("treeitem", { name: "db1" }));
    // 窓の位置は寸法モック次第なので、どのテーブル行でもよい (描画されていれば仮想化が動いている)。
    await waitFor(() => {
      expect(document.querySelector("[data-tree-key^='tbl:db1::']")).not.toBeNull();
    });

    // motion の Reorder.Item (layout="position") が自前で測る分は対象外。ConnectionList.tsx
    // 自身 (スキーマ行リストの scrollMargin の計測) が呼んだ回数だけを数える。
    const orig = HTMLElement.prototype.getBoundingClientRect;
    let own = 0;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if ((new Error().stack ?? "").includes("components/ConnectionList.tsx")) own += 1;
      return orig.call(this);
    });
    try {
      for (let i = 1; i <= 5; i++) {
        view.rerender(<ConnectionList {...baseProps} selectLimit={200 + i} />);
      }
      // タブ切替で「現在地」(アクティブなテーブル) が変わる。描画済みの行へ移す
      // (窓の外の行は新しくマウントされ、その行の高さの実測は別の話)。
      const shown = document.querySelector<HTMLElement>("[data-tree-key^='tbl:db1::']")!.dataset.treeKey!;
      view.rerender(<ConnectionList {...baseProps} activeTable={{ database: "db1", table: shown.replace("tbl:db1::", "") }} />);
      expect(own).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
