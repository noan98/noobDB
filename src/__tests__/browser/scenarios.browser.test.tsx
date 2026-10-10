import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderInBrowser } from "./render";
import App from "../../App";
import { t } from "../../i18n";
import { setQueryTimeoutSecs, setTabRestoreMode } from "../../settings";
import {
  emitChannelMessage,
  installTauriMock,
  invocationsOf,
  onCommand,
  type ChannelLike,
} from "./tauriMock";
import type { CellValue, Column, ConnectionProfile, TableColumnInfo } from "../../api/tauri";
import { __resetOutputLog } from "../../outputLog";
import { __resetMessageLog } from "../../messageLog";

// シナリオテスト (#564) — App 全体を実ブラウザにマウントし、ユーザ操作の主要
// フローを再現する。Phase 1 (画面スモーク) / Phase 2 (ビジュアル回帰) が
// 「個々の画面が描画されるか」を見るのに対し、ここでは **接続 → スキーマツリー →
// タブ → ストリーミング → 編集** と画面を跨いで流れる状態配線そのものを検証する。
// jsdom では捉えにくい実 DOM のフォーカス・ダブルクリック・イベント到着順序の
// 退行が対象。
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
  { name: "id", data_type: "INT", nullable: false, key: "PRI", default: null, extra: "auto_increment", referenced_table: null, referenced_column: null },
  { name: "name", data_type: "VARCHAR(64)", nullable: true, key: "", default: null, extra: "", referenced_table: null, referenced_column: null },
  { name: "qty", data_type: "INT", nullable: true, key: "", default: null, extra: "", referenced_table: null, referenced_column: null },
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
  onCommand("list_tables", (args) =>
    (args.database as string) === "betadb" ? ["gadgets"] : ["fruits"],
  );
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
  onCommand("plan_watch_refresh", () => ({ recorded: 0, changed: 0, errors: [] }));
  onCommand("schema_drift_list", () => []);
  onCommand("schema_drift_capture", () => ({ added: false, generations: [], summary: null }));
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
    const databases =
      sessionProfiles.get(args.sessionId as string) === BETA.id ? ["betadb"] : ["appdb"];
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
    (sessionProfiles.get(args.sessionId as string) === BETA.id ? ["betadb"] : ["appdb"]).map(
      (database) => ({ database, tables: [tableOf(database)] }),
    ),
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
  await expect
    .element(screen.getByRole("treeitem", { name: database, exact: true }))
    .toBeVisible();
}

/** ツリーで appdb を展開し、fruits テーブルをダブルクリックでタブに開く。 */
async function openFruitsTable(screen: Screen) {
  await screen.getByRole("treeitem", { name: "appdb", exact: true }).click();
  const tableRow = screen.getByRole("treeitem", { name: "fruits", exact: true });
  await expect.element(tableRow).toBeVisible();
  await tableRow.dblClick();
}

beforeEach(() => {
  localStorage.clear();
  installTauriMock();
  registerBaseHandlers();
  // 確認ダイアログを挟まず保存タブを常に復元する (切替シナリオの前提)。
  setTabRestoreMode("always");
});

describe("シナリオ: ストリーミング実行とキャンセル (実ブラウザ)", () => {
  it("ストリーミング結果が段階的に表示され、完了でステータスが確定する", async () => {
    let capturedChannel: ChannelLike | null = null;
    onCommand("run_query_stream", (args) => {
      capturedChannel = args.onEvent as ChannelLike;
      return null; // イベントはテスト側が手動で注入する
    });

    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);

    await vi.waitFor(() => {
      if (!capturedChannel) throw new Error("run_query_stream not invoked yet");
    }, { timeout: 5000 });
    const channel = capturedChannel!;

    // 1 バッチ目: 列定義 + 1 行。到着分が即座に描画される
    // (カラム未着の間はスケルトン表示で、グリッドはまだ出ない)。
    emitChannelMessage(channel, { kind: "columns", columns: FRUIT_COLUMNS });
    emitChannelMessage(channel, { kind: "rows", rows: [[1, "apple", 5]] });
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    // 実行中はストリーミングバナーと停止ボタンが出ている。
    await expect.element(screen.getByRole("button", { name: t("gridStopButton") })).toBeVisible();

    // 2 バッチ目が追記され、既存行は残る。
    emitChannelMessage(channel, { kind: "rows", rows: [[2, "banana", 3]] });
    await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    // done で確定: 完了ステータスが出てバナー (停止ボタン) は消える。
    emitChannelMessage(channel, {
      kind: "done",
      totalRows: 2,
      rowsAffected: 0,
      elapsedMs: 5,
      hasColumns: true,
      appliedAutoLimit: null,
      readOnly: true,
      schemaMayChange: false,
    });
    await expect
      .element(screen.getByText(t("statusStreamingDone", { rows: 2, ms: 5 })))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: t("gridStopButton") }))
      .not.toBeInTheDocument();
  });

  it("停止ボタンでキャンセルすると取得済み行は残り、以降のイベントは無視される", async () => {
    let capturedStreamId: string | null = null;
    let capturedChannel: ChannelLike | null = null;
    onCommand("run_query_stream", (args) => {
      capturedStreamId = args.streamId as string;
      capturedChannel = args.onEvent as ChannelLike;
      return null;
    });

    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);

    await vi.waitFor(() => {
      if (!capturedStreamId) throw new Error("run_query_stream not invoked yet");
    }, { timeout: 5000 });
    const streamId = capturedStreamId!;
    const channel = capturedChannel!;

    emitChannelMessage(channel, { kind: "columns", columns: FRUIT_COLUMNS });
    emitChannelMessage(channel, { kind: "rows", rows: [[1, "apple", 5]] });
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    await screen.getByRole("button", { name: t("gridStopButton") }).click();

    // バックエンドへキャンセルが届き、キャンセル済みステータスが出る。
    await vi.waitFor(() => {
      expect(invocationsOf("cancel_stream")).toEqual([{ streamId }]);
    }, { timeout: 5000 });
    await expect.element(
      screen.getByText(t("statusQueryCancelledPartial", { rows: 1 })),
    ).toBeVisible();

    // 取得済みの行は保持される。
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    // キャンセル後に届いた行イベントは購読解除済みのため反映されない
    // (cancel はリスナーを同期的に外すので、この emit の時点で配送先はない)。
    emitChannelMessage(channel, { kind: "rows", rows: [[2, "banana", 3]] });
    expect(screen.getByRole("gridcell", { name: "banana", exact: true }).query()).toBeNull();
  });

  it("カラム到着前のスケルトン段階でも停止ボタン (キャンセル導線) が出る", async () => {
    let capturedChannel: ChannelLike | null = null;
    onCommand("run_query_stream", (args) => {
      capturedChannel = args.onEvent as ChannelLike;
      return null; // 列イベントは送らず、スケルトン段階に留める
    });

    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);

    await vi.waitFor(() => {
      if (!capturedChannel) throw new Error("run_query_stream not invoked yet");
    }, { timeout: 5000 });

    // 列未着の「無の時間」でもバナーの停止ボタンが出ており、すぐにキャンセルできる。
    await expect
      .element(screen.getByRole("button", { name: t("gridStopButton") }))
      .toBeVisible();
    // グリッド (gridcell) はまだ描画されていない (スケルトン段階)。
    expect(screen.getByRole("gridcell", { name: "apple", exact: true }).query()).toBeNull();

    // 列 + 行が届くとスケルトンからグリッドへ切り替わり、停止ボタンは残る。
    const channel = capturedChannel!;
    emitChannelMessage(channel, { kind: "columns", columns: FRUIT_COLUMNS });
    emitChannelMessage(channel, { kind: "rows", rows: [[1, "apple", 5]] });
    await expect
      .element(screen.getByRole("gridcell", { name: "apple", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: t("gridStopButton") }))
      .toBeVisible();
  });

  it("タイムアウト間際になると警告 (残り秒数) が表示される", async () => {
    // タイムアウトを 1 秒に絞り、ライブ経過がその 8 割を超えたら間際警告が出る。
    setQueryTimeoutSecs(1);
    onCommand("run_query_stream", () => null); // 応答を返さず実行中のまま留める

    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);

    // 経過時間はバナー側が実時間で刻む。8 割 (0.8s) を越えると警告が出る。
    // setup.browser.ts はロケールを en に固定しているため、可変の残り秒数を避けて
    // 文言の静的部分 (Timing out in Ns) で照合する。
    await expect
      .element(screen.getByText(/Timing out in \d+s/), { timeout: 5000 })
      .toBeVisible();
  });
});

describe("シナリオ: インラインセル編集 → pending → Apply (実ブラウザ)", () => {
  it("セルをダブルクリックで編集し、Apply で UPDATE が 1 トランザクションに乗る", async () => {
    registerAutoStream();
    // 一括 UPDATE は構造化入力で `bulk_update_cells` に渡り、SQL の組み立てと 1 トランザ
    // クションでの実行は Rust 側が行う (#1259)。ここではその要求の中身を検証する。
    const applied: Record<string, unknown>[] = [];
    onCommand("bulk_update_cells", (args) => {
      applied.push(args);
      // サーバ側データを更新し、Apply 後の自動リフレッシュで新値が返るようにする。
      fruitsRows = fruitsRows.map((r) => (r[0] === 2 ? [2, "banana", 42] : r));
      return { columns: [], rows: [], rows_affected: 1, elapsed_ms: 2 };
    });

    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);
    await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();

    // describe_table の結果 (PK 解決) がタブへ反映され、セルが編集可能になるまで待つ。
    await vi.waitFor(() => {
      const cell = screen.getByRole("gridcell", { name: "3", exact: true }).query();
      if (!cell?.classList.contains("is-editable-cell")) {
        throw new Error("qty cell is not editable yet");
      }
    }, { timeout: 5000 });

    // banana の qty (3) をダブルクリック → インライン入力 → Enter で確定。
    await screen.getByRole("gridcell", { name: "3", exact: true }).dblClick();
    const input = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>("input.cell-edit-input");
      if (!el) throw new Error("cell edit input not open");
      return el;
    }, { timeout: 5000 });
    await page.elementLocator(input).fill("42");
    await userEvent.keyboard("{Enter}");

    // 保留編集のツールバーが出る (1 セル / 1 行)。
    await expect
      .element(screen.getByText(t("editPendingCount", { cells: 1, rows: 1 })))
      .toBeVisible();

    await screen.getByRole("button", { name: t("editApplyButton") }).click();

    // PK (id=2) を条件にした qty = 42 の更新が、1 回の要求 (= 1 トランザクション) で送られる。
    await vi.waitFor(() => {
      expect(applied).toEqual([
        {
          sessionId: expect.any(String),
          database: "appdb",
          table: "fruits",
          pkColumns: ["id"],
          groups: [{ set: [{ column: "qty", value: { kind: "number", text: "42" } }], keys: [[2]] }],
          extraStatements: [],
        },
      ]);
    }, { timeout: 5000 });

    // Apply 成功後はテーブルが自動リフレッシュされ、新値が表示される
    // (成功ステータスはリフレッシュ完了ステータスにすぐ上書きされるため、
    // ここでは最終的に画面へ残る結果だけを検証する)。
    await expect.element(screen.getByRole("gridcell", { name: "42", exact: true })).toBeVisible();
    await expect
      .element(screen.getByText(t("editPendingCount", { cells: 1, rows: 1 })))
      .not.toBeInTheDocument();
  });
});

describe("シナリオ: タブ復元と複数接続の切替 (実ブラウザ)", () => {
  it("保存済みワークスペースが接続時に復元され、テーブルタブは自動で再実行される", async () => {
    registerAutoStream();
    localStorage.setItem(
      `noobdb.tabs.${ALPHA.id}`,
      JSON.stringify({
        panes: [
          {
            tabs: [
              { kind: "query", title: "My scratch", sql: "SELECT 1" },
              { kind: "table", title: "fruits", database: "appdb", table: "fruits", sql: "" },
            ],
            activeIndex: 0,
          },
        ],
        activePane: 0,
      }),
    );

    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");

    // 両タブが戻る。
    await expect.element(screen.getByRole("tab", { name: /My scratch/ })).toBeVisible();
    await expect.element(screen.getByRole("tab", { name: /fruits/ })).toBeVisible();

    // テーブルタブは復元時に自動で初期 SELECT を再実行する。
    await vi.waitFor(() => {
      const runs = invocationsOf("run_query_stream");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ sql: "SELECT * FROM `appdb`.`fruits` LIMIT 100" });
    }, { timeout: 5000 });

    // アクティブなクエリタブのエディタには保存していた SQL が戻っている。
    await vi.waitFor(() => {
      const content = document.querySelector(".cm-content")?.textContent ?? "";
      if (!content.includes("SELECT 1")) throw new Error("editor SQL not restored");
    }, { timeout: 5000 });

    // テーブルタブへ切り替えると再実行済みの結果が表示されている。
    await screen.getByRole("tab", { name: /fruits/ }).click();
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();
  });

  it("接続を切り替えても前の接続は切断されず、戻すと再接続せず即復元される (同時接続)", async () => {
    registerAutoStream();
    const screen = await renderInBrowser(<App />);

    // Alpha に接続して fruits を開く。
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    // Beta へ切替: ツリーは Beta のスキーマになり、ワークスペースは空に戻る。
    await connectToProfile(screen, /Beta DB/, "betadb");
    await expect
      .element(screen.getByText(t("tabsEmptyTitle"), { exact: true }))
      .toBeVisible();
    expect(screen.getByRole("tab", { name: /fruits/ }).query()).toBeNull();

    // 前の接続 (Alpha) は切断されず背景で生存している (#複数同時接続)。
    // Alpha のタブは localStorage に退避され、戻ったときに復元できる。
    expect(invocationsOf("disconnect")).toEqual([]);
    const saved = JSON.parse(localStorage.getItem(`noobdb.tabs.${ALPHA.id}`) ?? "null") as {
      panes?: { tabs?: { kind?: string; table?: string }[] }[];
    } | null;
    expect(saved?.panes?.[0]?.tabs?.[0]).toMatchObject({ kind: "table", table: "fruits" });

    // Alpha に戻ると、生存中のセッションへ即時切替され (再接続しない)、
    // fruits タブが復元されてデータも再取得される。
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await expect.element(screen.getByRole("tab", { name: /fruits/ })).toBeVisible();
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    // connect は Alpha → Beta の 2 回のみ (Alpha への復帰は live セッションを再利用)。
    expect(invocationsOf("connect")).toHaveLength(2);
    // 切替を通じて一度も切断していない (両接続が同時に開いたまま)。
    expect(invocationsOf("disconnect")).toEqual([]);
  });
});

describe("シナリオ: 接続ツリーのカラム展開 (実ブラウザ)", () => {
  it("ダブルクリックではカラム一覧が開かず、チェブロンボタンのキーボード操作で開閉する", async () => {
    registerAutoStream();
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await screen.getByRole("treeitem", { name: "appdb", exact: true }).click();
    const tableRow = screen.getByRole("treeitem", { name: "fruits", exact: true });
    await expect.element(tableRow).toBeVisible();

    // ダブルクリックはテーブルタブを開くだけで、カラム一覧は展開されない (#892)。
    // (旧実装は行クリックにトグルがあり、dblclick に先行する click x2 で展開されていた。)
    await tableRow.dblClick();
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();
    await expect.element(screen.getByRole("treeitem", { name: "qty" })).not.toBeInTheDocument();

    // チェブロンはネイティブ button として公開され、キーボード (Enter) で展開できる。
    const chevron = screen.getByRole("button", {
      name: t("treeToggleColumnsAria", { table: "fruits" }),
      exact: true,
    });
    await expect.element(chevron).toBeVisible();
    (chevron.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("treeitem", { name: "qty" })).toBeVisible();

    // もう一度 Enter で折り畳まれる。
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("treeitem", { name: "qty" })).not.toBeInTheDocument();
  });
});

describe("シナリオ: SQL Editor / Result Grid の操作体系 (#1113, 実ブラウザ)", () => {
  it("エディタの右クリックで実行 → JSON ビュー切替 → パレットから EXPLAIN / アクティビティを開ける", async () => {
    registerAutoStream();
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);
    await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();

    // 1) SQL Editor の右クリックメニュー → 「クエリを実行」で再実行される。
    const sqlCalls = () =>
      invocationsOf("run_query_stream").map((a) => String((a as { sql?: unknown }).sql ?? ""));
    const before = sqlCalls().length;
    const content = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>(".cm-content");
      if (!el) throw new Error("editor not mounted");
      return el;
    }, { timeout: 5000 });
    await page.elementLocator(content).click({ button: "right" });
    await screen
      .getByRole("menuitem", { name: new RegExp(`^${t("editorMenuRunAll")}`) })
      .click();
    await vi.waitFor(() => expect(sqlCalls().length).toBeGreaterThan(before), { timeout: 5000 });
    await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();

    // 2) 結果の表示切替 (Data / JSON)。JSON ビューはコピー導線と行数を持つ。
    await screen.getByRole("radio", { name: t("resultViewJson") }).click();
    await expect.element(screen.getByRole("button", { name: t("resultJsonCopy") })).toBeVisible();
    await expect.element(screen.getByText(t("resultJsonRows", { rows: 2 }), { exact: true })).toBeVisible();
    await screen.getByRole("radio", { name: t("gridViewLabel") }).click();
    await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();

    // 3) Command Palette → 「実行計画を表示」で EXPLAIN が走る (キーボードだけで完結)。
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.element(screen.getByRole("combobox", { name: t("cmdkPlaceholder") })).toBeVisible();
    await userEvent.keyboard(t("cmdkExplainQuery"));
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => {
      expect(sqlCalls().some((sql) => sql.startsWith("EXPLAIN FORMAT=JSON "))).toBe(true);
    }, { timeout: 5000 });
    // 実行後にパレットは閉じる (退場アニメーションが終わるまで待ってから開き直す)。
    await expect
      .element(screen.getByRole("combobox", { name: t("cmdkPlaceholder") }))
      .not.toBeInTheDocument();

    // 4) Command Palette → 「アクティビティを開閉」でベルのパネルが開く。
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.element(screen.getByRole("combobox", { name: t("cmdkPlaceholder") })).toBeVisible();
    await userEvent.keyboard(t("cmdkToggleActivity"));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("dialog", { name: t("activityCenterTitle") }))
      .toBeVisible();
  });
});

describe("シナリオ: Bottom Panel のログ系タブ (#1114, 実ブラウザ)", () => {
  // 出力 / メッセージはモジュール単位の (セッション内) ストアなので、前のシナリオの
  // 実行結果が残らないよう空から始める。
  beforeEach(() => {
    __resetOutputLog();
    __resetMessageLog();
  });

  it("実行結果が出力タブに積まれ、メッセージ / アクティビティとタブで行き来できる", async () => {
    registerAutoStream();
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);
    await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();

    // 1) Command Palette → 「出力 (実行ログ)」でボトムパネルの出力タブが開く。
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.element(screen.getByRole("combobox", { name: t("cmdkPlaceholder") })).toBeVisible();
    await userEvent.keyboard(t("cmdkOutput"));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("tab", { name: t("outputTitle") }))
      .toHaveAttribute("aria-selected", "true");
    // テーブルを開いたときの SELECT が結末 (2 行) 付きで記録されている。
    const outputList = screen.getByRole("list", { name: t("outputListAria") });
    await expect.element(outputList).toBeVisible();
    await expect
      .element(outputList.getByText(t("outputSummaryRows", { rows: 2, ms: 5 })).first())
      .toBeVisible();

    // 2) 行を展開すると「新しいタブで開く」が出る (キーボード操作できるボタン)。
    await outputList.getByRole("button", { expanded: false }).first().click();
    await expect.element(screen.getByRole("button", { name: t("outputOpenInEditor") })).toBeVisible();

    // 3) 矢印キーでアクティビティタブへ。ステータスバーに出た完了メッセージも
    //    (旧「メッセージ」タブを統合したので) ここに残っている。同じ骨格 (フィルタ + クリア)。
    await screen.getByRole("tab", { name: t("outputTitle") }).click();
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .element(screen.getByRole("tab", { name: t("activityCenterTitle") }))
      .toHaveAttribute("aria-selected", "true");
    const activity = screen.getByRole("list", { name: t("activityListAria") });
    await expect
      .element(activity.getByText(t("statusStreamingDone", { rows: 2, ms: 5 })))
      .toBeVisible();
    await expect
      .element(screen.getByRole("group", { name: t("activityFilterAria") }))
      .toBeVisible();

    // 5) Esc (タブバー上) でパネルを閉じる。
    await screen.getByRole("tab", { name: t("activityCenterTitle") }).click();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("tab", { name: t("activityCenterTitle") }))
      .not.toBeInTheDocument();

    // 6) ステータスバーの「履歴を表示」からもアクティビティタブへ辿れる。
    await screen.getByRole("button", { name: t("statusOpenMessages") }).click();
    await expect
      .element(screen.getByRole("tab", { name: t("activityCenterTitle") }))
      .toHaveAttribute("aria-selected", "true");
  });
});

describe("シナリオ: 折りたたみ時のパネルバーから中核機能へ辿れる (実ブラウザ)", () => {
  it("接続前は診断が無効で理由が読め、接続後はパネルバーからプロセスモニタが開く", async () => {
    onCommand("list_processes", () => []);
    const screen = await renderInBrowser(<App />);

    // 1) 未接続でもバーは常設され、プロセスモニタは「存在は見えるが開けない」。
    const strip = screen.getByRole("navigation", { name: t("bottomPanelStripAria") });
    await expect.element(strip).toBeVisible();
    const processes = strip.getByRole("button", { name: t("processTitle") });
    await expect.element(processes).toHaveAttribute("aria-disabled", "true");
    await processes.hover();
    await expect.element(screen.getByRole("tooltip")).toHaveTextContent(t("appToolsNeedsSession"));

    // 2) 接続すると有効になり、1 クリックでボトムパネルが開く。
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await expect.element(processes).not.toHaveAttribute("aria-disabled");
    await processes.click();
    await expect
      .element(screen.getByRole("tab", { name: t("processTitle") }))
      .toHaveAttribute("aria-selected", "true");
    // 開いている間はタブバーが同じ役目を持つので、バーは二重に出さない。
    await expect.element(strip).not.toBeInTheDocument();

    // 3) 閉じるとバーへ戻る。
    await screen.getByRole("button", { name: t("bottomPanelClose") }).click();
    await expect
      .element(screen.getByRole("navigation", { name: t("bottomPanelStripAria") }))
      .toBeVisible();
  });
});

describe("シナリオ: 未接続表示の一本化 (#1276, 実ブラウザ)", () => {
  it("未接続の「未接続」はステータスバーの 1 か所だけで、接続するとヘッダに接続名が出る", async () => {
    const screen = await renderInBrowser(<App />);
    await expect.element(screen.getByText(t("appDisconnected"), { exact: true }).first()).toBeVisible();
    // ワークスペースヘッダとステータスバーの二重表示にならない。
    expect(screen.getByText(t("appDisconnected"), { exact: true }).elements()).toHaveLength(1);

    // 接続中にヘッダが担っていた接続名は失われない。
    await connectToProfile(screen, /Alpha DB/, "appdb");
    expect(screen.getByText(t("appDisconnected"), { exact: true }).elements()).toHaveLength(0);
    await expect.element(screen.getByText("Alpha DB", { exact: true }).last()).toBeVisible();
  });
});

describe("シナリオ: サイドバータブの sliding indicator とクロスフェード (#1173, 実ブラウザ)", () => {
  // アクティブインジケータ (`MotionSidebarTabIndicator`) は `aria-hidden` の
  // motion.span としてアクティブなタブの内側にのみ描画される (`SidebarTabButton`)。
  function hasIndicator(tabEl: Element) {
    return tabEl.querySelector('[aria-hidden="true"]') !== null;
  }

  it("インジケータはアクティブなタブにだけ描かれ、切替に追従する", async () => {
    const screen = await renderInBrowser(<App />);

    const connections = screen.getByRole("tab", { name: t("sidebarTabConnections") });
    const snippets = screen.getByRole("tab", { name: t("sidebarTabSnippets") });
    const history = screen.getByRole("tab", { name: t("sidebarTabHistory") });
    const local = screen.getByRole("tab", { name: t("sidebarTabLocal") });

    // 初期状態: Connections がアクティブでインジケータもそこにだけある。
    await expect.element(connections).toHaveAttribute("aria-selected", "true");
    expect(hasIndicator(connections.element())).toBe(true);
    expect(hasIndicator(snippets.element())).toBe(false);
    expect(hasIndicator(history.element())).toBe(false);
    expect(hasIndicator(local.element())).toBe(false);

    // Snippets へ切替: インジケータも移動し、他のタブからは消える。
    await snippets.click();
    await expect.element(snippets).toHaveAttribute("aria-selected", "true");
    expect(hasIndicator(snippets.element())).toBe(true);
    expect(hasIndicator(connections.element())).toBe(false);
    expect(hasIndicator(history.element())).toBe(false);
    expect(hasIndicator(local.element())).toBe(false);
  });

  it("タブ切替でパネル本文がクロスフェードし、新しい内容に差し替わる", async () => {
    const screen = await renderInBrowser(<App />);

    // Connections パネルにはプロファイル一覧 (Alpha DB) が出ている。
    await expect.element(screen.getByRole("treeitem", { name: /Alpha DB/ })).toBeVisible();

    // History へ切替: mode="wait" のクロスフェードを挟んでも最終的に新しい
    // パネル (履歴の空状態) が表示され、旧パネルの中身は消える。
    await screen.getByRole("tab", { name: t("sidebarTabHistory") }).click();
    await expect
      .element(screen.getByRole("treeitem", { name: /Alpha DB/ }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("tabpanel", { name: t("sidebarTabHistory") }))
      .toBeVisible();

    // Local へ切替: さらに別内容へ差し替わる。
    await screen.getByRole("tab", { name: t("sidebarTabLocal") }).click();
    await expect
      .element(screen.getByRole("tabpanel", { name: t("sidebarTabLocal") }))
      .toBeVisible();
  });

  it("タブ切替後も WAI-ARIA 属性 (role/aria-selected/aria-controls) が維持される", async () => {
    const screen = await renderInBrowser(<App />);

    const tablist = screen.getByRole("tablist", { name: t("sidebarTablistAria") });
    await expect.element(tablist).toBeVisible();

    const snippetsTab = screen.getByRole("tab", { name: t("sidebarTabSnippets") });
    await snippetsTab.click();

    await expect.element(snippetsTab).toHaveAttribute("aria-selected", "true");
    const controlsId = snippetsTab.element().getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();

    const panel = screen.getByRole("tabpanel", { name: t("sidebarTabSnippets") });
    await expect.element(panel).toBeVisible();
    expect(panel.element().id).toBe(controlsId);

    // 非アクティブなタブはローピング tabindex (-1) のまま。
    const historyTab = screen.getByRole("tab", { name: t("sidebarTabHistory") });
    expect(historyTab.element().getAttribute("tabindex")).toBe("-1");
    expect(snippetsTab.element().getAttribute("tabindex")).toBe("0");
  });
});

describe("シナリオ: グローバルオブジェクト検索 (#1261, 実ブラウザ)", () => {
  it("Ctrl+Shift+O で開き、入力がバックエンド検索になり、Enter で該当テーブルが開く", async () => {
    registerAutoStream();
    // 検索はバックエンド (Rust) が行う: 空クエリは索引のウォームアップ、"fruit" にだけ一致する。
    onCommand("search_schema_objects", (args) =>
      (args.query as string).trim().toLowerCase() === "fruit"
        ? [{ kind: "table", database: "appdb", table: "fruits" }]
        : [],
    );
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");

    await userEvent.keyboard("{Control>}{Shift>}o{/Shift}{/Control}");
    const input = screen.getByRole("combobox", { name: t("objSearchPlaceholder") });
    await expect.element(input).toBeVisible();
    // 開いた直後に空クエリで索引を先に作らせている (ウォームアップ)。
    await expect
      .poll(() => invocationsOf("search_schema_objects").some((a) => a.query === ""))
      .toBe(true);

    await userEvent.keyboard("fruit");
    const option = screen.getByRole("option").first();
    await expect.element(option).toBeVisible();
    // 最後の要求は入力全体 (デバウンス後)。
    const queries = invocationsOf("search_schema_objects").map((a) => a.query);
    expect(queries[queries.length - 1]).toBe("fruit");

    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();
  });
});

describe("シナリオ: keep-alive による切替 (#1311, 実ブラウザ)", () => {
  it("サイドバーのタブを往復しても load_schema_tree が再実行されず、ツリーも即表示される", async () => {
    registerAutoStream();
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await screen.getByRole("treeitem", { name: "appdb", exact: true }).click();
    await expect
      .element(screen.getByRole("treeitem", { name: "fruits", exact: true }))
      .toBeVisible();
    const loads = invocationsOf("load_schema_tree").length;
    const history = invocationsOf("list_history").length;

    await screen.getByRole("tab", { name: t("sidebarTabHistory") }).click();
    await expect
      .element(screen.getByRole("tabpanel", { name: t("sidebarTabHistory") }))
      .toBeVisible();
    await screen.getByRole("tab", { name: t("sidebarTabSnippets") }).click();
    await screen.getByRole("tab", { name: t("sidebarTabHistory") }).click();
    await screen.getByRole("tab", { name: t("sidebarTabConnections") }).click();

    // 展開状態のまま、待たずにツリーが出ている。DB からの取り直しは起きない。
    await expect
      .element(screen.getByRole("treeitem", { name: "fruits", exact: true }))
      .toBeVisible();
    expect(invocationsOf("load_schema_tree").length).toBe(loads);
    // 履歴も往復でマウントし直さない (一覧の取得は初回の 1 度だけ)。
    expect(invocationsOf("list_history").length).toBeLessThanOrEqual(history + 1);
  });

  it("ER 図を開いて閉じても、ワークスペース (エディタとグリッド) は作り直されず状態が保たれる", async () => {
    registerAutoStream();
    onCommand("describe_database", () => []);
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);
    const cell = screen.getByRole("gridcell", { name: "apple", exact: true });
    await expect.element(cell).toBeVisible();
    const cellEl = cell.element();
    const editorEl = document.querySelector(".cm-content");
    const runs = invocationsOf("run_query_stream").length;

    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.keyboard(t("cmdkActionErDiagram"));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("region", { name: t("erDiagramTitle") }))
      .toBeVisible();
    // ワークスペースは DOM に残るが、操作・読み上げ対象からは外れる。
    expect(cellEl.isConnected).toBe(true);
    expect(cellEl.closest("[inert]")).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();
    // 同じ DOM ノードのまま (再マウントされていない) で、データの再取得も走っていない。
    expect(screen.getByRole("gridcell", { name: "apple", exact: true }).element()).toBe(cellEl);
    expect(document.querySelector(".cm-content")).toBe(editorEl);
    expect(cellEl.closest("[inert]")).toBeNull();
    expect(invocationsOf("run_query_stream").length).toBe(runs);
  });
});

/** 保存済みワークスペースとしてクエリタブを仕込む (先頭がアクティブ)。 */
function seedQueryTabs(profileId: string, tabs: { title: string; sql: string }[]) {
  localStorage.setItem(
    `noobdb.tabs.${profileId}`,
    JSON.stringify({
      panes: [{ tabs: tabs.map((x) => ({ kind: "query", ...x })), activeIndex: 0 }],
      activePane: 0,
    }),
  );
}

/** ワークスペースのタブ (サイドバーのタブは draggable でない) の表示順。title 属性がタイトル。 */
function tabTitles(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="tab"][draggable]')).map(
    (el) => el.getAttribute("title") ?? "",
  );
}

/** ワークスペースのタブ (「A」など) を、サイドバーの「Connections」と区別して引く。 */
function workTab(screen: Screen, title: string) {
  return screen.getByRole("tab", { name: new RegExp(`^${title} `) });
}

/**
 * タブの右クリックメニューから「すべて閉じる」を選ぶ (メニューは再描画で DOM が差し替わるため DOM で押す)。
 * マウスの右クリック (pointerdown / mousedown / contextmenu / mouseup の連続) は Chromium の版に
 * よって外側クリック判定と競合しメニューが開いた直後に閉じることがあるため、`contextmenu`
 * イベントを直接送ってメニューを開く。開いていなければ待ちの間に開き直す。
 */
async function closeAllTabsFromMenu(screen: Screen) {
  const tabEl = workTab(screen, "A").element() as HTMLElement;
  const openMenu = () => {
    const r = tabEl.getBoundingClientRect();
    tabEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
  };
  openMenu();
  await vi.waitFor(() => {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (el) => (el.textContent ?? "").includes(t("tabCloseAll")),
    );
    if (!item) {
      openMenu();
      throw new Error("menu item missing");
    }
    item.click();
  }, { timeout: 5000 });
}

describe("シナリオ: 閉じたタブの復元 (#1353, 実ブラウザ)", () => {
  it("Cmd/Ctrl+W で閉じたクエリタブが Ctrl+Shift+T で SQL ごと戻る", async () => {
    registerAutoStream();
    localStorage.setItem(
      `noobdb.tabs.${ALPHA.id}`,
      JSON.stringify({
        panes: [
          {
            tabs: [
              { kind: "query", title: "Keep", sql: "SELECT 2" },
              { kind: "query", title: "My scratch", sql: "SELECT 1" },
            ],
            activeIndex: 1,
          },
        ],
        activePane: 0,
      }),
    );
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await expect.element(screen.getByRole("tab", { name: /My scratch/ })).toBeVisible();

    await userEvent.keyboard("{Control>}w{/Control}");
    await expect.element(screen.getByRole("tab", { name: /My scratch/ })).not.toBeInTheDocument();

    await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    await expect.element(screen.getByRole("tab", { name: /My scratch/ })).toBeVisible();
    await vi.waitFor(() => {
      const content = document.querySelector(".cm-content")?.textContent ?? "";
      if (!content.includes("SELECT 1")) throw new Error("closed tab SQL not restored");
    }, { timeout: 5000 });
  });

  it("エディタで打ったばかりの本文 (タブ state 未反映) も復元される", async () => {
    registerAutoStream();
    seedQueryTabs(ALPHA.id, [{ title: "My scratch", sql: "SELECT 1" }]);
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await expect.element(screen.getByRole("tab", { name: /My scratch/ })).toBeVisible();

    const editor = document.querySelector<HTMLElement>(".cm-content");
    if (!editor) throw new Error("editor missing");
    await page.elementLocator(editor).click();
    await userEvent.keyboard("{Control>}{End}{/Control}");
    await userEvent.keyboard(" zzqq");
    await vi.waitFor(() => {
      if (!(document.querySelector(".cm-content")?.textContent ?? "").includes("zzqq")) {
        throw new Error("typed text not in editor");
      }
    });

    await userEvent.keyboard("{Control>}w{/Control}");
    await expect.element(screen.getByRole("tab", { name: /My scratch/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    await expect.element(screen.getByRole("tab", { name: /My scratch/ })).toBeVisible();
    await vi.waitFor(() => {
      const content = document.querySelector(".cm-content")?.textContent ?? "";
      if (!content.includes("SELECT 1") || !content.includes("zzqq")) {
        throw new Error("typed text not restored");
      }
    }, { timeout: 5000 });
  });

  it("「すべて閉じる」の後に連続で復元すると、件数も並びも元どおりになる", async () => {
    registerAutoStream();
    seedQueryTabs(ALPHA.id, [
      { title: "A", sql: "SELECT 'a'" },
      { title: "B", sql: "SELECT 'b'" },
      { title: "C", sql: "SELECT 'c'" },
    ]);
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await expect.element(workTab(screen, "C")).toBeVisible();
    expect(tabTitles()).toEqual(["A", "B", "C"]);

    await closeAllTabsFromMenu(screen);
    await expect.element(workTab(screen, "A")).not.toBeInTheDocument();

    for (const title of ["A", "B", "C"]) {
      await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
      await expect.element(workTab(screen, title)).toBeVisible();
    }
    expect(tabTitles()).toEqual(["A", "B", "C"]);

    // 履歴を使い切ったあとの Ctrl+Shift+T は何もしない。
    await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    expect(tabTitles()).toEqual(["A", "B", "C"]);
  });

  it("パレットは空クエリでは固定項目だけ、検索語があれば個別項目も出す", async () => {
    registerAutoStream();
    seedQueryTabs(ALPHA.id, [
      { title: "A", sql: "SELECT 'a'" },
      { title: "B", sql: "SELECT 'b'" },
      { title: "C", sql: "SELECT 'c'" },
    ]);
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await expect.element(workTab(screen, "C")).toBeVisible();
    await closeAllTabsFromMenu(screen);
    await expect.element(workTab(screen, "A")).not.toBeInTheDocument();

    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.element(screen.getByRole("combobox", { name: t("cmdkPlaceholder") })).toBeVisible();
    await expect.element(screen.getByRole("option", { name: new RegExp(t("cmdkReopenClosedTab")) })).toBeVisible();
    const reopenRows = () =>
      Array.from(document.querySelectorAll('[role="option"]')).filter((el) =>
        (el.textContent ?? "").includes(t("cmdkReopenClosedTab")),
      );
    expect(reopenRows()).toHaveLength(1);

    await userEvent.keyboard(t("cmdkReopenClosedTab"));
    await vi.waitFor(() => expect(reopenRows().length).toBeGreaterThan(1), { timeout: 5000 });
  });

  it("別の接続で閉じたタブは、接続を切り替えたあとの復元に出てこない", async () => {
    registerAutoStream();
    seedQueryTabs(ALPHA.id, [
      { title: "A", sql: "SELECT 'a'" },
      { title: "B", sql: "SELECT 'b'" },
    ]);
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await expect.element(workTab(screen, "B")).toBeVisible();
    await userEvent.keyboard("{Control>}w{/Control}");
    await expect.element(workTab(screen, "A")).not.toBeInTheDocument();

    await connectToProfile(screen, /Beta DB/, "betadb");
    await expect.element(screen.getByText(t("tabsEmptyTitle"), { exact: true })).toBeVisible();

    await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    expect(tabTitles()).toEqual([]);
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.element(screen.getByRole("combobox", { name: t("cmdkPlaceholder") })).toBeVisible();
    await userEvent.keyboard(t("cmdkReopenClosedTab"));
    await vi.waitFor(() => {
      const rows = Array.from(document.querySelectorAll('[role="option"]'));
      expect(rows.some((el) => (el.textContent ?? "").includes(t("cmdkReopenClosedTab")))).toBe(false);
    });
  });
});

describe("シナリオ: 未確定のセル編集があるタブを閉じる (#1391)", () => {
  it("Ctrl+W で確認が出て、キャンセルするとタブも編集も残り、履歴にも積まれない", async () => {
    registerAutoStream();
    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);
    await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();
    await vi.waitFor(() => {
      const cell = screen.getByRole("gridcell", { name: "3", exact: true }).query();
      if (!cell?.classList.contains("is-editable-cell")) throw new Error("qty cell is not editable yet");
    }, { timeout: 5000 });

    await screen.getByRole("gridcell", { name: "3", exact: true }).dblClick();
    const input = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>("input.cell-edit-input");
      if (!el) throw new Error("cell edit input not open");
      return el;
    }, { timeout: 5000 });
    await page.elementLocator(input).fill("42");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByText(t("editPendingCount", { cells: 1, rows: 1 })))
      .toBeVisible();

    // Ctrl+W → 確認ダイアログ。キャンセルでタブと編集が残る。
    await userEvent.keyboard("{Control>}w{/Control}");
    await expect.element(screen.getByText(t("tabCloseDiscardTitle"))).toBeVisible();
    await screen.getByRole("button", { name: t("confirmDefaultCancel"), exact: true }).first().click();
    await expect
      .element(screen.getByText(t("editPendingCount", { cells: 1, rows: 1 })))
      .toBeVisible();

    // キャンセル時に閉じたタブ履歴へ積まれないことは pendingEditsGuard.test.ts の構造検査で
    // 固定する (テーブルタブの復元は既存タブの前面化になり、タブ数では判別できないため)。

    // 改めて閉じて OK すると、タブが閉じる。前の確認ダイアログの退場アニメと
    // フォーカス返却が終わる前に次を開くと、返却されたフォーカスが新しいダイアログの
    // 外側操作とみなされて閉じられるため、ダイアログが消えフォーカスが戻るのを待つ。
    await vi.waitFor(() => {
      if (document.querySelector("[role=dialog],[role=alertdialog]")) throw new Error("previous dialog still mounted");
      if (document.activeElement === document.body) throw new Error("focus not restored yet");
    }, { timeout: 5000 });
    await userEvent.keyboard("{Control>}w{/Control}");
    await screen.getByRole("button", { name: t("tabCloseDiscardAction") }).click();
    await expect
      .element(screen.getByText(t("editPendingCount", { cells: 1, rows: 1 })))
      .not.toBeInTheDocument();
  });
});
