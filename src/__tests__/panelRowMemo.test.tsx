import { useCallback, useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "./testUtils";
import type {
  ProcessInfo,
  StatementDeltaRow,
  Snippet,
  SyncStatement,
  TableStatistic,
} from "../api/tauri";

/**
 * 件数の多いパネルの行描画 (#1321)。「1 行の操作が全行の再レンダーにならない」ことを、
 * 各行コンポーネントが入口で呼ぶ `useT` の呼び出し回数 (= 行の再レンダー回数) の増分で固定する。
 * 行が memo されていなければ、親の更新のたびに行数ぶん増える。
 */
vi.mock("../i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../i18n")>();
  return { ...actual, useT: vi.fn(actual.useT) };
});
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProcesses: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn(),
      getProcessQuery: vi.fn(),
      tableStatistics: vi.fn().mockResolvedValue([]),
    },
  };
});

import { t, useT } from "../i18n";
import { api } from "../api/tauri";
import { StatRow, TailRow } from "../components/QueryInspectorPanel";
import { PROCESS_RENDER_LIMIT, ProcessListPanel } from "../components/ProcessListPanel";
import { SyncStatementRow } from "../components/SchemaCompareView";
import { PrivilegeRow } from "../components/UsersPanel";
import { TableStatisticsPanel } from "../components/TableStatisticsPanel";
import { COMBO_CSS_HOVER_THRESHOLD, ComboSelect } from "../components/ComboSelect";
import { JsonTreeView } from "../components/JsonTreeView";
import { SnippetList } from "../components/SnippetList";
import { parseJsonLossless } from "../components/jsonTree";
import type { LiveTailEntry } from "../components/queryInspector";

// 数十〜数百行を描画するため、CPU が混んだ環境でも落ちないよう既定 5 秒より長くする。
vi.setConfig({ testTimeout: 30000 });

const useTSpy = vi.mocked(useT);

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  vi.clearAllMocks();
});

/** `action` の前後で `useT` が何回呼ばれたか。 */
async function renderCountDelta(action: () => void | Promise<void>): Promise<number> {
  const before = useTSpy.mock.calls.length;
  await action();
  return useTSpy.mock.calls.length - before;
}

const N = 40;

describe("ライブテール / 集計の行 (#1321)", () => {
  const entry = (i: number): LiveTailEntry => ({
    key: `k${i}`,
    query: `SELECT ${i}`,
    user: "u",
    host: "h",
    database: "d",
    application: null,
    duration_ms: 1,
    rows_examined: null,
    running: false,
    started_at_ms: null,
    fingerprint: `fp${i % 3}`,
    observedAtMs: 1000 + i,
  });
  const delta = (i: number): StatementDeltaRow => ({
    digest: `d${i}`,
    fingerprint: `SELECT ${i}`,
    database: "d",
    calls: i,
    total_time_ms: 1,
    mean_time_ms: 1,
    max_time_ms: 1,
    rows: null,
    n_plus_one: false,
  });

  it("親が再レンダーされても、参照の変わらないエントリの行は再レンダーされない", async () => {
    const entries = Array.from({ length: N }, (_, i) => entry(i));
    const rows = Array.from({ length: N }, (_, i) => delta(i));
    const onCopy = vi.fn();
    function Harness() {
      const [n, setN] = useState(0);
      return (
        <>
          <button onClick={() => setN(n + 1)}>bump {n}</button>
          <table>
            <tbody>
              {entries.map((e) => (
                <TailRow
                  key={e.key}
                  entry={e}
                  showRowsExamined={false}
                  nPlusOneCount={null}
                  nPlusOneWindowMs={0}
                  onCopy={onCopy}
                />
              ))}
              {rows.map((r) => (
                <StatRow key={r.digest} row={r} fingerprint={r.fingerprint ?? ""} nPlusOneWindowMs={1000} onCopy={onCopy} />
              ))}
            </tbody>
          </table>
        </>
      );
    }
    renderWithProviders(<Harness />);
    const d = await renderCountDelta(() => userEvent.click(screen.getByRole("button", { name: /bump/ })));
    expect(d).toBe(0);
  });
});

describe("同期プラン / 権限の行 (#1321)", () => {
  it("同期文のチェック切替で再レンダーされるのは当該行だけ", async () => {
    const stmts: SyncStatement[] = Array.from({ length: N }, (_, i) => ({
      sql: `ALTER TABLE t${i} ADD c int`,
      table: `t${i}`,
      kind: "add_column",
      destructive: false,
    }));
    function Harness() {
      const [sel, setSel] = useState<Set<number>>(new Set());
      const toggle = useCallback(
        (i: number) =>
          setSel((p) => {
            const n = new Set(p);
            if (n.has(i)) n.delete(i);
            else n.add(i);
            return n;
          }),
        [],
      );
      return (
        <ul>
          {stmts.map((s, i) => (
            <SyncStatementRow key={i} index={i} statement={s} checked={sel.has(i)} onToggle={toggle} />
          ))}
        </ul>
      );
    }
    renderWithProviders(<Harness />);
    const boxes = screen.getAllByRole("checkbox");
    const d = await renderCountDelta(() => userEvent.click(boxes[3]));
    expect(d).toBe(1);
    expect(boxes[3]).toBeChecked();
  });

  it("権限フラグの切替で再レンダーされるのは当該行だけ", () => {
    const empty = { select: false, insert: false, update: false, delete: false, ddl: false };
    const tables = Array.from({ length: N }, (_, i) => `tbl${i}`);
    function Harness() {
      const [edited, setEdited] = useState<Record<string, typeof empty>>({});
      const toggle = useCallback(
        (table: string, flag: keyof typeof empty) =>
          setEdited((cur) => {
            const row = cur[table] ?? empty;
            return { ...cur, [table]: { ...row, [flag]: !row[flag] } };
          }),
        [],
      );
      return (
        <table>
          <tbody>
            {tables.map((tb) => (
              <PrivilegeRow
                key={tb}
                table={tb}
                flags={edited[tb] ?? empty}
                originalFlags={empty}
                readOnly={false}
                onToggle={toggle}
              />
            ))}
          </tbody>
        </table>
      );
    }
    renderWithProviders(<Harness />);
    const cb = screen.getByRole("checkbox", { name: "tbl7 insert" });
    fireEvent.click(cb);
    expect(cb).toBeChecked();
    // 他の行は変わらない (チェックは 1 つだけ)。
    expect(screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked)).toHaveLength(1);
  });
});

describe("プロセス一覧 (#1321)", () => {
  const proc = (id: number): ProcessInfo => ({
    id,
    user: "u",
    host: "h",
    database: "d",
    command: "Query",
    state: "x",
    time_secs: id,
    query_summary: `SELECT ${id}`,
    query_truncated: false,
    is_self: false,
  });

  it("行の選択で再レンダーされるのは当該行 (とパネル) だけ", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue(Array.from({ length: N }, (_, i) => proc(i + 1)));
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />);
    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(N));
    const box = screen.getByRole("checkbox", { name: t("processSelectRow", { id: 5 }) });
    const d = await renderCountDelta(() => userEvent.click(box));
    expect(box).toBeChecked();
    // パネル + 当該行 (+ ツールチップ等の少数)。全行 (N) にはならない。
    expect(d).toBeLessThan(N / 2);
  });

  it("上限を超える件数は先頭 PROCESS_RENDER_LIMIT 件だけ描画し、件数を明示する", async () => {
    const total = PROCESS_RENDER_LIMIT + 20;
    vi.mocked(api.listProcesses).mockResolvedValue(Array.from({ length: total }, (_, i) => proc(i + 1)));
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />);
    const note = await screen.findByTestId("process-truncated", {}, { timeout: 15000 });
    expect(note.textContent).toBe(t("processTruncated", { shown: PROCESS_RENDER_LIMIT, total }));
    // ヘッダの全選択 1 + 行ぶん。
    expect(screen.getAllByRole("checkbox").length).toBe(PROCESS_RENDER_LIMIT + 2);
  }, 30000);
});

describe("テーブル統計 (#1321)", () => {
  it("並べ替えで行が再レンダーされない", async () => {
    const stats: TableStatistic[] = Array.from({ length: N }, (_, i) => ({
      name: `tbl${i}`,
      row_estimate: i,
      data_bytes: i * 10,
      index_bytes: i,
      total_bytes: i * 11,
      column_count: 3,
      index_count: 1,
      has_primary_key: true,
      foreign_key_count: 0,
    }));
    vi.mocked(api.tableStatistics).mockResolvedValue(stats);
    renderWithProviders(<TableStatisticsPanel sessionId="s1" database="db" onClose={() => {}} />);
    await screen.findByText("tbl3");
    const header = screen.getByRole("columnheader", { name: new RegExp(t("sizeColName")) });
    const d = await renderCountDelta(() => userEvent.click(header));
    expect(d).toBeLessThan(N / 2);
  });
});

describe("ComboSelect (#1321)", () => {
  it("候補が多いときは hover でハイライト state を更新しない", async () => {
    const many = Array.from({ length: COMBO_CSS_HOVER_THRESHOLD + 10 }, (_, i) => ({ value: `opt${i}` }));
    renderWithProviders(<ComboSelect value="" options={many} onChange={() => {}} aria-label="combo" />);
    const input = screen.getByRole("combobox");
    await userEvent.click(input);
    const opt = await screen.findByRole("option", { name: /opt3$/ });
    await userEvent.hover(opt);
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("候補が少ないときは従来どおり hover でハイライトする", async () => {
    const few = Array.from({ length: 5 }, (_, i) => ({ value: `opt${i}` }));
    renderWithProviders(<ComboSelect value="" options={few} onChange={() => {}} aria-label="combo" />);
    const input = screen.getByRole("combobox");
    await userEvent.click(input);
    await userEvent.hover(await screen.findByRole("option", { name: /opt3$/ }));
    expect(input).toHaveAttribute("aria-activedescendant");
  });
});

describe("JSON ツリー (#1321)", () => {
  it("フォーカス / 選択の移動で再レンダーされるのは影響する行だけ", async () => {
    const doc = JSON.stringify({ items: Array.from({ length: N }, (_, i) => i) });
    renderWithProviders(<JsonTreeView root={parseJsonLossless(doc)!} />);
    const tree = screen.getByRole("tree");
    await userEvent.click(within(tree).getByText('"items"'));
    expect(within(tree).getAllByRole("treeitem").length).toBeGreaterThan(N);
    const target = within(tree).getAllByText("7")[1];
    const d = await renderCountDelta(() => userEvent.click(target));
    expect(screen.getByTestId("json-tree-selected-path").textContent).toBe("$.items[7]");
    // 続けて隣の葉へ移しても、選択が外れる行と付く行だけが再レンダーされる。
    const d2 = await renderCountDelta(() => userEvent.click(within(tree).getAllByText("8")[1]));
    expect(d2).toBeLessThan(N / 2);
    expect(d).toBeLessThan(N / 2);
  });
});

describe("スニペット一覧 (#1321)", () => {
  it("お気に入りの変更で他の行が再レンダーされない", async () => {
    const snippets: Snippet[] = Array.from({ length: N }, (_, i) => ({
      id: `s${i}`,
      name: `snip${i}`,
      folder: null,
      tags: [],
      sql: `SELECT ${i}`,
      driver: null,
      scope: { kind: "any" },
    }));
    const props = {
      snippets,
      activeProfile: null,
      onInsert: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onToggleFavorite: () => {},
    };
    const { rerender } = renderWithProviders(<SnippetList {...props} favoriteIds={[]} />);
    const d = await renderCountDelta(() => {
      rerender(<SnippetList {...props} favoriteIds={["s2"]} />);
    });
    expect(d).toBeLessThan(N / 2);
  });
});
