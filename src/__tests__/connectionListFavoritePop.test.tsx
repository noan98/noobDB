import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import type { TableRef } from "../tableQuickAccess";

/**
 * Issue #1782: お気に入りを「追加」した直後の行だけ★が一度ポップする。
 * 初回描画・解除・他の行には `data-fav-pop` が付かない。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const listDatabases = vi.fn().mockResolvedValue(["db1"]);
  return {
    ...actual,
    api: {
      ...actual.api,
      listDatabases,
      listTables: vi.fn().mockResolvedValue(["tbl1", "tbl2"]),
      describeTable: vi.fn().mockResolvedValue([]),
      listIndexes: vi.fn().mockResolvedValue([]),
      tableRowEstimates: vi.fn().mockResolvedValue([]),
      listSchemaObjects: vi.fn().mockResolvedValue([]),
      loadSchemaTree: vi.fn(async () => ({ databases: ["db1"], open: [], tables: [] })),
      listTablesAll: vi.fn(async () => [{ database: "db1", tables: ["tbl1", "tbl2"] }]),
    },
  };
});

import { ConnectionList } from "../components/ConnectionList";

const noop = () => {};
const profile = makeProfile({ id: "p-a", name: "Alpha DB" });

function Harness({ initial }: { initial: TableRef[] }) {
  const [favorites, setFavorites] = useState<TableRef[]>(initial);
  return (
    <ConnectionList
      profiles={[profile]}
      activeProfileId="p-a"
      sessionId="s1"
      connectingId={null}
      errorProfileId={null}
      onConnect={noop}
      onCreate={noop}
      onEdit={noop}
      onDuplicate={noop}
      onDelete={noop}
      onPickTable={noop}
      onImportTable={noop}
      onDumpDatabase={noop}
      onRunTableSelect={noop}
      onInsertTableSelect={noop}
      onOpenObjectDefinition={noop}
      selectLimit={200}
      favorites={favorites}
      onToggleFavorite={(database, table) =>
        setFavorites((prev) =>
          prev.some((f) => f.database === database && f.table === table)
            ? prev.filter((f) => !(f.database === database && f.table === table))
            : [...prev, { database, table }],
        )
      }
    />
  );
}

const favRow = (table: string) => document.querySelector(`[data-tree-key="qa:favorite:db1::${table}"]`);
const popping = () => document.querySelectorAll("[data-fav-pop]");

async function openMenuOn(name: string, item: string) {
  fireEvent.contextMenu(await screen.findByRole("treeitem", { name }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("お気に入り追加のポップ (#1782)", () => {
  beforeEach(() => localStorage.clear());

  it("初回描画の既存お気に入りはポップしない", async () => {
    renderWithProviders(<Harness initial={[{ database: "db1", table: "tbl1" }]} />);
    await waitFor(() => expect(favRow("tbl1")).not.toBeNull());
    expect(popping()).toHaveLength(0);
  });

  it("追加した行の★だけポップし、しばらくすると外れる。解除では付かない", async () => {
    renderWithProviders(<Harness initial={[{ database: "db1", table: "tbl1" }]} />);
    fireEvent.click(await screen.findByRole("treeitem", { name: "db1" }));
    await screen.findByRole("treeitem", { name: "tbl2" });

    await openMenuOn("tbl2", t("contextMenuAddFavorite"));
    await waitFor(() => expect(favRow("tbl2")?.querySelector("[data-fav-pop]")).not.toBeNull());
    expect(favRow("tbl1")?.querySelector("[data-fav-pop]")).toBeNull();
    // 窓が閉じたら一度きりで外れる。
    await waitFor(() => expect(popping()).toHaveLength(0), { timeout: 3000 });

    await openMenuOn("tbl2", t("contextMenuRemoveFavorite"));
    await waitFor(() => expect(favRow("tbl2")).toBeNull());
    expect(popping()).toHaveLength(0);
  });
});
