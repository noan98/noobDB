// 描画性能ベンチマーク (#1307)。`pnpm bench:ui` で実行する (CI では走らない)。
//
// App 全体を実 Chromium にモック接続で描画し、Epic #1306 で問題になった 4 つの操作の
// 処理コストを測る。測るのは「改善前後の相対比較」のための数値で、実機 (WebView2 +
// 本番ビルドの React) の絶対値ではない。React は開発ビルドで動くので、実機より数倍
// 遅く出る。読み方は `.claude/skills/noobdb-testing/references/perf-bench.md`。
//
// シナリオ:
//   1. タブ切替        — 大きな結果を持つテーブルタブを順に切り替える
//   2. ツリーのスクロール — 1,000 テーブルを展開したスキーマツリーを rAF ごとにスクロールする
//   3. エディタ入力     — SQL エディタに 1 文字ずつ入力する
//   4. サイドバー幅のドラッグ — リサイズハンドルに pointermove を送り続ける
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { cdp, commands } from "vitest/browser";
import { EditorView } from "@codemirror/view";
import { renderInBrowser } from "../browser/render";
import App from "../../App";
import { setTabRestoreMode } from "../../settings";
import {
  emitChannelMessage,
  installTauriMock,
  onCommand,
  type ChannelLike,
} from "../browser/tauriMock";
import type { CellValue, Column, ConnectionProfile, TableColumnInfo } from "../../api/tauri";

// ---- 規模 (Epic #1306 の「大規模スキーマ」の想定) ---------------------------------

const TABLE_COUNT = 1000;
const COLUMNS_PER_TABLE = 20;
const RESULT_ROWS = 5000;
const RESULT_BATCH = 1000;
const OPEN_TABS = 4;
const TAB_SWITCHES = 8;
const TYPED_CHARS = 30;
const DRAG_MOVES = 30;
const SCROLL_FRAMES = 120;
const SCROLL_STEP_PX = 40;

// ---- フィクスチャ ------------------------------------------------------------------

const PROFILE: ConnectionProfile = {
  id: "p-perf",
  name: "Perf DB",
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  database: "appdb",
  ssh: null,
  group: null,
  color: null,
  is_production: false,
  confirm_writes: false,
  read_only: false,
  skip_history: false,
  file_path: null,
};

const TABLES = Array.from({ length: TABLE_COUNT }, (_, i) => `t${String(i + 1).padStart(4, "0")}`);
const COLUMN_NAMES = Array.from({ length: COLUMNS_PER_TABLE }, (_, i) => (i === 0 ? "id" : `col_${i}`));

const TABLE_COLUMNS: TableColumnInfo[] = COLUMN_NAMES.map((name, i) => ({
  name,
  data_type: i === 0 ? "INT" : "VARCHAR(64)",
  nullable: i !== 0,
  key: i === 0 ? "PRI" : "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
}));

const RESULT_COLUMNS: Column[] = COLUMN_NAMES.map((name, i) => ({
  name,
  type_name: i === 0 ? "INT" : "VARCHAR",
}));

const RESULT_ROWS_DATA: CellValue[][] = Array.from({ length: RESULT_ROWS }, (_, r) =>
  COLUMN_NAMES.map((_, c) => (c === 0 ? r + 1 : `value_${r}_${c}`)),
);

function registerHandlers() {
  onCommand("list_profiles", () => [PROFILE]);
  onCommand("list_snippets", () => []);
  onCommand("list_history", () => []);
  onCommand("list_history_sql", () => []);
  onCommand("list_sandboxes", () => []);
  onCommand("list_tasks", () => []);
  onCommand("connect", () => ({ session_id: "sess-perf" }));
  onCommand("disconnect", () => null);
  onCommand("ping_session", () => true);
  onCommand("list_databases", () => ["appdb"]);
  onCommand("list_tables", () => TABLES);
  onCommand("describe_table", () => TABLE_COLUMNS);
  onCommand("list_indexes", () => []);
  onCommand("schema_overview", () => TABLES.map((name) => ({ name, columns: COLUMN_NAMES })));
  onCommand("foreign_keys", () => []);
  onCommand("table_row_estimates", () => TABLES.map((name) => ({ name, estimate: null })));
  onCommand("table_row_estimate", () => null);
  onCommand("list_schema_objects", () => []);
  onCommand("list_table_comments", () => []);
  onCommand("plan_watch_list", () => []);
  onCommand("plan_watch_refresh", () => ({ recorded: 0, changed: 0, errors: [] }));
  onCommand("schema_drift_list", () => []);
  onCommand("schema_drift_capture", () => ({ added: false, generations: [], summary: null }));
  const openResult = (db: string, table: string, limit: number) => {
    const base = `SELECT * FROM \`${db}\`.\`${table}\``;
    return { base, sql: `${base} LIMIT ${limit}`, columns: TABLE_COLUMNS, row_identity: null, row_estimate: null };
  };
  onCommand("open_table", (args) =>
    openResult(args.database as string, args.table as string, args.limit as number),
  );
  onCommand("open_tables", (args) =>
    (args.tables as [string, string][]).map(([database, table]) => ({
      database,
      table,
      result: openResult(database, table, args.limit as number),
      error: null,
    })),
  );
  onCommand("load_schema_tree", (args) => ({
    databases: ["appdb"],
    open: (args.openDbs as string[])
      .filter((db) => db === "appdb")
      .map((database) => ({
        database,
        tables: TABLES,
        row_estimates: TABLES.map((name) => ({ name, estimate: null })),
        objects: [],
        comments: [],
      })),
    tables: (args.openTableKeys as string[]).map((key) => ({ key, columns: TABLE_COLUMNS, indexes: [] })),
  }));
  onCommand("list_tables_all", () => [{ database: "appdb", tables: TABLES }]);
  onCommand("cancel_stream", () => ({ cancelled: true, deliveredRows: 0 }));
  onCommand("run_query_stream", (args) => {
    const channel = args.onEvent as ChannelLike;
    // 実機と同じく、invoke の解決後に列 → 行バッチ → 完了の順で届ける。
    window.setTimeout(() => {
      emitChannelMessage(channel, { kind: "columns", columns: RESULT_COLUMNS });
      for (let i = 0; i < RESULT_ROWS_DATA.length; i += RESULT_BATCH) {
        emitChannelMessage(channel, { kind: "rows", rows: RESULT_ROWS_DATA.slice(i, i + RESULT_BATCH) });
      }
      emitChannelMessage(channel, {
        kind: "done",
        totalRows: RESULT_ROWS_DATA.length,
        rowsAffected: 0,
        elapsedMs: 5,
        hasColumns: true,
        appliedAutoLimit: null,
        readOnly: true,
        schemaMayChange: false,
      });
    }, 0);
    return null;
  });
}

// ---- 計測の道具 --------------------------------------------------------------------

/** React の commit を数える。シナリオごとに `reset` する。 */
const reactStats = { commits: 0, renderMs: 0 };
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  reactStats.commits += 1;
  reactStats.renderMs += actualDuration;
};

/**
 * 1 タスク譲る。setTimeout(0) はネストで 4ms に丸められるので、MessageChannel を使う
 * (React のスケジューラも MessageChannel でタスクを積むため、FIFO で後ろに並べば
 * 「React が予約した描画が終わった後」に戻ってこられる)。
 */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 操作直後に、React の描画とレイアウトが終わるまでを同期的に待ち切る。 */
async function settle(): Promise<void> {
  await yieldTask();
  await yieldTask();
  // レイアウトを強制して、スタイル計算とレイアウトのコストも計測区間に含める。
  void document.body.offsetHeight;
}

/**
 * vitest の `CDPSession` 型は provider の型を取り込んだときだけ中身が付く空の
 * interface なので、ここで使う `send` だけを型付けする。
 */
type CdpSender = { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
const cdpSession = () => cdp() as unknown as CdpSender;

interface CdpMetrics {
  script: number;
  layout: number;
  style: number;
  task: number;
}

async function readCdp(): Promise<CdpMetrics> {
  const res = (await cdpSession().send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  const get = (name: string) => (res.metrics.find((m) => m.name === name)?.value ?? 0) * 1000;
  return {
    script: get("ScriptDuration"),
    layout: get("LayoutDuration"),
    style: get("RecalcStyleDuration"),
    task: get("TaskDuration"),
  };
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

interface ScenarioResult {
  name: string;
  iterations: number;
  /** 1 回の操作の、操作開始 → 描画とレイアウトの完了までの時間 (ms)。 */
  opMs: { p50: number; p95: number; max: number };
  /** 1 回あたりの React の commit 数と描画時間 (開発ビルド)。 */
  react: { commitsPerOp: number; renderMsPerOp: number };
  /** 1 回あたりのメインスレッド時間 (ms)。CDP の Performance ドメインの累計の差分。 */
  mainThreadPerOp: CdpMetrics;
  longTasks: { count: number; maxMs: number };
  /** rAF のフレーム間隔 (スクロールのシナリオのみ)。 */
  frames?: { p50: number; p95: number; over16_7Pct: number };
}

const results: ScenarioResult[] = [];

/**
 * シナリオを `iterations` 回まわして計測する。`op` は 1 回分の操作を同期的に起こすだけでよい
 * (完了待ちはこの関数が行う)。操作の間に `gapMs` 待ち、非同期の後処理 (IPC の再取得や
 * タイマー) もメインスレッド時間に含める。
 */
async function runScenario(
  name: string,
  iterations: number,
  op: (i: number) => void,
  opts: { gapMs?: number } = {},
): Promise<ScenarioResult> {
  const gapMs = opts.gapMs ?? 50;
  const longTasks: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push(e.duration);
  });
  observer.observe({ type: "longtask" });
  await sleep(300);
  reactStats.commits = 0;
  reactStats.renderMs = 0;
  console.log(`[perf] ${name}: 計測開始 (${iterations} 回)`);
  const before = await readCdp();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    op(i);
    await settle();
    samples.push(performance.now() - t0);
    await sleep(gapMs);
  }
  const after = await readCdp();
  observer.disconnect();
  const per = (v: number) => v / iterations;
  const result: ScenarioResult = {
    name,
    iterations,
    opMs: { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples) },
    react: { commitsPerOp: per(reactStats.commits), renderMsPerOp: per(reactStats.renderMs) },
    mainThreadPerOp: {
      script: per(after.script - before.script),
      layout: per(after.layout - before.layout),
      style: per(after.style - before.style),
      task: per(after.task - before.task),
    },
    longTasks: { count: longTasks.length, maxMs: longTasks.length ? Math.max(...longTasks) : 0 },
  };
  results.push(result);
  return result;
}

const f1 = (v: number) => v.toFixed(1);

function toMarkdown(rows: ScenarioResult[]): string {
  const head = [
    "| シナリオ | 回数 | 処理時間 p50 / p95 / 最大 (ms) | React commit / 回 | React 描画 (ms/回) | メインスレッド (ms/回) Task = Script + Layout + Style + その他 | LongTask 件数 (最大 ms) |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  const body = rows.map((r) => {
    const m = r.mainThreadPerOp;
    return `| ${r.name} | ${r.iterations} | ${f1(r.opMs.p50)} / ${f1(r.opMs.p95)} / ${f1(r.opMs.max)} | ${f1(r.react.commitsPerOp)} | ${f1(r.react.renderMsPerOp)} | ${f1(m.task)} = ${f1(m.script)} + ${f1(m.layout)} + ${f1(m.style)} + … | ${r.longTasks.count} (${f1(r.longTasks.maxMs)}) |`;
  });
  const frames = rows
    .filter((r) => r.frames)
    .map(
      (r) =>
        `- ${r.name}: フレーム間隔 p50 ${f1(r.frames!.p50)}ms / p95 ${f1(r.frames!.p95)}ms / 16.7ms 超え ${f1(r.frames!.over16_7Pct)}%`,
    );
  return [...head, ...body, "", ...frames].join("\n");
}

// ---- 準備: 接続して 1,000 テーブルを展開し、大きな結果のタブを開く --------------------

type Screen = Awaited<ReturnType<typeof renderInBrowser>>;
let screen: Screen;

beforeAll(async () => {
  await cdpSession().send("Performance.enable", { timeDomain: "threadTicks" });
});

beforeEach(() => {
  localStorage.clear();
  installTauriMock();
  registerHandlers();
  setTabRestoreMode("never");
});

async function bootAndOpenTabs(): Promise<void> {
  screen = await renderInBrowser(
    <Profiler id="app" onRender={onRender}>
      <App />
    </Profiler>,
  );
  await screen.getByRole("treeitem", { name: /Perf DB/ }).click();
  const db = screen.getByRole("treeitem", { name: "appdb", exact: true });
  await expect.element(db).toBeVisible();
  await db.click();
  await expect.element(screen.getByRole("treeitem", { name: TABLES[TABLE_COUNT - 1], exact: true })).toBeInTheDocument();
  for (let i = 0; i < OPEN_TABS; i += 1) {
    await screen.getByRole("treeitem", { name: TABLES[i], exact: true }).dblClick();
    await expect.element(screen.getByRole("gridcell", { name: "value_0_1", exact: true })).toBeVisible();
  }
  // 起動スプラッシュや初回の遅延ロードが落ち着くのを待つ。
  await sleep(1500);
}

function tabElements(): HTMLElement[] {
  return TABLES.slice(0, OPEN_TABS).map(
    (name) => screen.getByRole("tab", { name: new RegExp(name) }).element() as HTMLElement,
  );
}

// ---- シナリオ ----------------------------------------------------------------------

it("UI 性能ベンチマーク", async () => {
  await bootAndOpenTabs();

  // 1. タブ切替
  const tabs = tabElements();
  expect(tabs).toHaveLength(OPEN_TABS);
  await runScenario(
    "タブ切替",
    TAB_SWITCHES,
    (i) => tabs[i % OPEN_TABS].click(),
    { gapMs: 200 },
  );

  // 2. スキーマツリーのスクロール (rAF ごとにスクロール位置を進め、フレーム間隔も記録する)
  const tree = document.querySelector<HTMLElement>("[role=tree]");
  expect(tree).not.toBeNull();
  tree!.scrollTop = 0;
  const scroll = await runScenario(
    "ツリーのスクロール",
    SCROLL_FRAMES,
    () => {
      tree!.scrollTop += SCROLL_STEP_PX;
    },
    { gapMs: 0 },
  );
  // 処理時間とは別に、連続スクロール中の実フレーム間隔を測る。
  tree!.scrollTop = 0;
  const frameIntervals: number[] = [];
  let lastFrame = await nextFrame();
  for (let i = 0; i < SCROLL_FRAMES; i += 1) {
    tree!.scrollTop += SCROLL_STEP_PX;
    const now = await nextFrame();
    frameIntervals.push(now - lastFrame);
    lastFrame = now;
  }
  scroll.frames = {
    p50: percentile(frameIntervals, 0.5),
    p95: percentile(frameIntervals, 0.95),
    over16_7Pct: (frameIntervals.filter((v) => v > 16.7 * 1.5).length / frameIntervals.length) * 100,
  };

  // 3. エディタ入力 (表示中のペインのエディタに 1 文字ずつ挿入する)
  const editorEl = document.querySelector<HTMLElement>(".cm-editor");
  expect(editorEl).not.toBeNull();
  const view = EditorView.findFromDOM(editorEl!);
  expect(view).not.toBeNull();
  await runScenario(
    "エディタ入力",
    TYPED_CHARS,
    () => {
      const end = view!.state.doc.length;
      view!.dispatch({ changes: { from: end, insert: " " }, userEvent: "input.type" });
    },
  );

  // 4. サイドバー幅のドラッグ
  const handle = document.querySelector<HTMLElement>("[role=separator][aria-orientation=vertical]");
  expect(handle).not.toBeNull();
  const rect = handle!.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  const pointer = (type: string, x: number) =>
    handle!.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true }),
    );
  pointer("pointerdown", rect.left + 2);
  await runScenario(
    "サイドバー幅のドラッグ",
    DRAG_MOVES,
    (i) => pointer("pointermove", rect.left + 2 + (i % 2 === 0 ? 40 : -40) + (i % 10)),
    { gapMs: 0 },
  );
  pointer("pointerup", rect.left + 2);
});

afterAll(async () => {
  const markdown = toMarkdown(results);
  console.log(`\n## UI 性能ベンチマーク結果\n\n${markdown}\n`);
  // パスはプロジェクトルート基準。
  await commands.writeFile(
    "src/__tests__/perf/__perf__/latest.json",
    JSON.stringify({ measuredAt: new Date().toISOString(), userAgent: navigator.userAgent, results }, null, 2),
  );
  await commands.writeFile("src/__tests__/perf/__perf__/latest.md", `${markdown}\n`);
});
