// F6 の領域フォーカス巡回で、着地した領域にパルス用クラスが付くことを実ブラウザで固定する (#1764)。
// 共通セットアップはアニメーションを 0s にして animationend が即発火しクラスが外れるため、
// このテストでは着地クラスの再生時間を延ばして「付いている」状態を観測する。
import { beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { renderInBrowser } from "./render";
import App from "../../App";
import { setMotionPreference, setTabRestoreMode } from "../../settings";
import { emitChannelMessage, installTauriMock, onCommand, type ChannelLike } from "./tauriMock";
import type { CellValue, Column, ConnectionProfile, TableColumnInfo } from "../../api/tauri";

// ---- フィクスチャ (scenarios.browser.test.tsx と同じ最小構成) ----
//
// バックエンドは `tauriMock.ts` のフェイク Tauri ランタイムで差し替える。
// `api/tauri.ts` の型付きラッパ・zod 検証・`listenQueryStream` の Channel
// レジストリは実コードのまま通り、テストは `emitChannelMessage` で
// `run_query_stream` の Channel (#1096) へ columns/rows/done メッセージを任意
// のタイミングで注入できる (実 DB 不要)。

// ---- フィクスチャ ----------------------------------------------------------

function makeProfile(id: string, name: string, database: string): ConnectionProfile {
  return {
    id,
    name,
    driver: "mysql",
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    database,
    ssh: null,
    group: null,
    color: null,
    is_production: false,
    confirm_writes: false,
    read_only: false,
    skip_history: false,
    file_path: null,
  };
}

const ALPHA = makeProfile("p-alpha", "Alpha DB", "appdb");
const BETA = makeProfile("p-beta", "Beta DB", "betadb");

const FRUIT_COLUMNS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "name", type_name: "VARCHAR" },
  { name: "qty", type_name: "INT" },
];

const FRUIT_TABLE_COLUMNS: TableColumnInfo[] = [
  {
    name: "id",
    data_type: "INT",
    nullable: false,
    key: "PRI",
    default: null,
    extra: "auto_increment",
    referenced_table: null,
    referenced_column: null,
  },
  {
    name: "name",
    data_type: "VARCHAR(64)",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  },
  {
    name: "qty",
    data_type: "INT",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  },
];

// fruits テーブルの「サーバ側」データ。Apply のシナリオではトランザクション
// ハンドラがこれを書き換え、リフレッシュ後の再取得で更新後の値が返る。
let fruitsRows: CellValue[][];
// connect が払い出したセッション → プロファイルの対応 (DB 名の出し分けに使う)。
let sessionProfiles: Map<string, string>;
let connectSeq: number;

/** App のマウント〜接続〜スキーマツリー閲覧で呼ばれる全コマンドの応答を登録する。 */
function registerBaseHandlers() {
  sessionProfiles = new Map();
  connectSeq = 0;
  fruitsRows = [
    [1, "apple", 5],
    [2, "banana", 3],
  ];
  onCommand("list_profiles", () => [ALPHA, BETA]);
  onCommand("list_snippets", () => []);
  onCommand("list_history", () => []);
  onCommand("list_history_sql", () => []);
  onCommand("connect", (args) => {
    const req = args.req as { profile_id?: string };
    connectSeq += 1;
    const sessionId = `sess-${req.profile_id ?? "anon"}-${connectSeq}`;
    sessionProfiles.set(sessionId, req.profile_id ?? "");
    return { session_id: sessionId };
  });
  onCommand("disconnect", () => null);
  onCommand("ping_session", () => true);
  onCommand("list_databases", (args) =>
    sessionProfiles.get(args.sessionId as string) === BETA.id ? ["betadb"] : ["appdb"],
  );
  onCommand("list_tables", (args) => ((args.database as string) === "betadb" ? ["gadgets"] : ["fruits"]));
  onCommand("describe_table", () => FRUIT_TABLE_COLUMNS);
  onCommand("list_indexes", () => []);
  onCommand("schema_overview", (args) => [
    {
      name: (args.database as string) === "betadb" ? "gadgets" : "fruits",
      columns: ["id", "name", "qty"],
    },
  ]);
  onCommand("foreign_keys", () => []);
  // estimate を null にしてツリーの行数バッジを出さない (バッジが付くと
  // treeitem のアクセシブルネームが "fruits 2" に変わり、ロケータが不安定になる)。
  onCommand("table_row_estimates", (args) => [
    { name: (args.database as string) === "betadb" ? "gadgets" : "fruits", estimate: null },
  ]);
  onCommand("list_schema_objects", () => []);
  // 接続時の背景チェック (スキーマドリフト #736 / 実行計画ウォッチ #743)。どちらも
  // Rust 内で完結する IPC (#1260) なので、ウォッチも世代も無い空の応答を固定で返す。
  onCommand("plan_watch_list", () => []);
  onCommand("plan_watch_refresh", () => ({
    recorded: 0,
    changed: 0,
    errors: [],
    warned: [],
    warnedSummaries: [],
  }));
  onCommand("schema_drift_list", () => []);
  onCommand("schema_drift_capture", () => ({
    added: false,
    database: "appdb",
    generations: [],
    summary: null,
  }));
  onCommand("list_table_comments", () => []);
  // 集約 IPC (#1263): テーブルを開く処理とスキーマツリーの復元 / 検索は、
  // 個別コマンドの代わりにこれらを呼ぶ。内容は上の個別ハンドラと同じ。
  const tableOf = (db: string) => (db === "betadb" ? "gadgets" : "fruits");
  const openResult = (db: string, table: string, limit: number) => {
    const base = `SELECT * FROM \`${db}\`.\`${table}\``;
    return {
      base,
      sql: `${base} LIMIT ${limit}`,
      columns: FRUIT_TABLE_COLUMNS,
      row_identity: null,
      row_estimate: null,
    };
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
  onCommand("table_row_estimate", () => null);
  onCommand("load_schema_tree", (args) => {
    const databases = sessionProfiles.get(args.sessionId as string) === BETA.id ? ["betadb"] : ["appdb"];
    return {
      databases,
      open: (args.openDbs as string[])
        .filter((db) => databases.includes(db))
        .map((db) => ({
          database: db,
          tables: [tableOf(db)],
          row_estimates: [{ name: tableOf(db), estimate: null }],
          objects: [],
          comments: [],
        })),
      tables: (args.openTableKeys as string[]).map((key) => ({
        key,
        columns: FRUIT_TABLE_COLUMNS,
        indexes: [],
      })),
    };
  });
  onCommand("list_tables_all", (args) =>
    (sessionProfiles.get(args.sessionId as string) === BETA.id ? ["betadb"] : ["appdb"]).map((database) => ({
      database,
      tables: [tableOf(database)],
    })),
  );
  onCommand("cancel_stream", () => ({ cancelled: true, deliveredRows: 1 }));
}

/** ストリーミング一式 (columns → rows → done) を 1 ストリーム分注入する。 */
function emitQueryStreamResult(channel: ChannelLike, rows: CellValue[][]) {
  emitChannelMessage(channel, { kind: "columns", columns: FRUIT_COLUMNS });
  emitChannelMessage(channel, { kind: "rows", rows });
  emitChannelMessage(channel, {
    kind: "done",
    totalRows: rows.length,
    rowsAffected: 0,
    elapsedMs: 5,
    hasColumns: true,
    appliedAutoLimit: null,
    readOnly: true,
    schemaMayChange: false,
  });
}

/** `run_query_stream` を「即座に全件返るクエリ」として自動応答させる。 */
function registerAutoStream() {
  onCommand("run_query_stream", (args) => {
    const channel = args.onEvent as ChannelLike;
    // invoke の解決後にイベントが届く実機の順序を再現する。
    window.setTimeout(() => emitQueryStreamResult(channel, fruitsRows), 0);
    return null;
  });
}

type Screen = Awaited<ReturnType<typeof renderInBrowser>>;

/** 接続リストのプロファイル行をクリックして接続し、ツリーに DB が出るまで待つ。 */
async function connectToProfile(screen: Screen, name: RegExp, database: string) {
  await screen.getByRole("treeitem", { name }).click();
  // Playwright の name は部分一致のため、プロファイル行 (ホスト/DB 名を含む) に
  // 誤マッチしないよう DB ノードは exact 指定する。
  await expect.element(screen.getByRole("treeitem", { name: database, exact: true })).toBeVisible();
}

/** ツリーで appdb を展開し、fruits テーブルをダブルクリックでタブに開く。 */
async function openFruitsTable(screen: Screen) {
  await screen.getByRole("treeitem", { name: "appdb", exact: true }).click();
  const tableRow = screen.getByRole("treeitem", { name: "fruits", exact: true });
  await expect.element(tableRow).toBeVisible();
  await tableRow.dblClick();
}

function holdLandingAnimation(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `.is-focus-landing, .is-focus-landing::after { animation-duration: 600s !important; }`;
  document.head.appendChild(style);
  return style;
}

function landed(): Element[] {
  return Array.from(document.querySelectorAll(".is-focus-landing"));
}

async function bootWithTable() {
  const screen = await renderInBrowser(<App />);
  await connectToProfile(screen, /Alpha DB/, "appdb");
  await openFruitsTable(screen);
  const cell = screen.getByRole("gridcell", { name: "banana", exact: true });
  await expect.element(cell).toBeVisible();
  // F6 は「アクティブなペイン」のエディタ / グリッドへ移るので、先にペインを有効にしておく。
  await cell.click();
}

beforeEach(() => {
  localStorage.clear();
  installTauriMock();
  setTabRestoreMode("always");
  registerBaseHandlers();
  registerAutoStream();
});

describe("F6 フォーカス遷移キュー (#1764)", () => {
  it("着地した領域 (サイドバー → エディタ → 結果グリッド) に is-focus-landing が移る", async () => {
    const hold = holdLandingAnimation();
    await bootWithTable();
    try {
      await userEvent.keyboard("{F6}");
      await expect.poll(() => landed().map((el) => el.tagName)).toEqual(["ASIDE"]);
      await userEvent.keyboard("{F6}");
      await expect.poll(() => landed().map((el) => !!el.querySelector(".cm-editor"))).toEqual([true]);
      await userEvent.keyboard("{F6}");
      await expect
        .poll(() => landed().map((el) => el.getAttribute("data-testid") ?? el.tagName))
        .toHaveLength(1);
      expect(landed()[0]?.matches("aside") || landed()[0]?.querySelector(".cm-editor")).toBeFalsy();
    } finally {
      hold.remove();
    }
  });

  it("reduced-motion (アプリ設定) では着地クラスを付けない", async () => {
    const hold = holdLandingAnimation();
    setMotionPreference("reduced");
    try {
      await bootWithTable();
      await userEvent.keyboard("{F6}");
      await userEvent.keyboard("{F6}");
      expect(landed()).toHaveLength(0);
    } finally {
      setMotionPreference("system");
      hold.remove();
    }
  });
});
