import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderInBrowser } from "./render";
import App from "../../App";
import { t } from "../../i18n";
import { setTabRestoreMode } from "../../settings";
import {
  emitTauriEvent,
  installTauriMock,
  invocationsOf,
  onCommand,
} from "./tauriMock";
import type { CellValue, Column, ConnectionProfile, TableColumnInfo } from "../../api/tauri";

// シナリオテスト (#564) — App 全体を実ブラウザにマウントし、ユーザ操作の主要
// フローを再現する。Phase 1 (画面スモーク) / Phase 2 (ビジュアル回帰) が
// 「個々の画面が描画されるか」を見るのに対し、ここでは **接続 → スキーマツリー →
// タブ → ストリーミング → 編集** と画面を跨いで流れる状態配線そのものを検証する。
// jsdom では捉えにくい実 DOM のフォーカス・ダブルクリック・イベント到着順序の
// 退行が対象。
//
// バックエンドは `tauriMock.ts` のフェイク Tauri ランタイムで差し替える。
// `api/tauri.ts` の型付きラッパ・zod 検証・`listenQueryStream` の streamId
// フィルタは実コードのまま通り、テストは `emitTauriEvent` で `query-stream:*`
// イベントを任意のタイミングで注入できる (実 DB 不要)。

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
  onCommand("cancel_stream", () => true);
}

/** ストリーミング一式 (columns → rows → done) を 1 ストリーム分注入する。 */
function emitQueryStreamResult(streamId: string, rows: CellValue[][]) {
  emitTauriEvent("query-stream:columns", { streamId, columns: FRUIT_COLUMNS });
  emitTauriEvent("query-stream:rows", { streamId, rows });
  emitTauriEvent("query-stream:done", {
    streamId,
    totalRows: rows.length,
    rowsAffected: 0,
    elapsedMs: 5,
    hasColumns: true,
    appliedAutoLimit: null,
  });
}

/** `run_query_stream` を「即座に全件返るクエリ」として自動応答させる。 */
function registerAutoStream() {
  onCommand("run_query_stream", (args) => {
    const streamId = args.streamId as string;
    // invoke の解決後にイベントが届く実機の順序を再現する。
    window.setTimeout(() => emitQueryStreamResult(streamId, fruitsRows), 0);
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
    let capturedStreamId: string | null = null;
    onCommand("run_query_stream", (args) => {
      capturedStreamId = args.streamId as string;
      return null; // イベントはテスト側が手動で注入する
    });

    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);

    await vi.waitFor(() => {
      if (!capturedStreamId) throw new Error("run_query_stream not invoked yet");
    }, { timeout: 5000 });
    const streamId = capturedStreamId!;

    // 1 バッチ目: 列定義 + 1 行。到着分が即座に描画される
    // (カラム未着の間はスケルトン表示で、グリッドはまだ出ない)。
    emitTauriEvent("query-stream:columns", { streamId, columns: FRUIT_COLUMNS });
    emitTauriEvent("query-stream:rows", { streamId, rows: [[1, "apple", 5]] });
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    // 実行中はストリーミングバナーと停止ボタンが出ている。
    await expect.element(screen.getByRole("button", { name: t("gridStopButton") })).toBeVisible();

    // 2 バッチ目が追記され、既存行は残る。
    emitTauriEvent("query-stream:rows", { streamId, rows: [[2, "banana", 3]] });
    await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    // done で確定: 完了ステータスが出てバナー (停止ボタン) は消える。
    emitTauriEvent("query-stream:done", {
      streamId,
      totalRows: 2,
      rowsAffected: 0,
      elapsedMs: 5,
      hasColumns: true,
      appliedAutoLimit: null,
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
    onCommand("run_query_stream", (args) => {
      capturedStreamId = args.streamId as string;
      return null;
    });

    const screen = await renderInBrowser(<App />);
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await openFruitsTable(screen);

    await vi.waitFor(() => {
      if (!capturedStreamId) throw new Error("run_query_stream not invoked yet");
    }, { timeout: 5000 });
    const streamId = capturedStreamId!;

    emitTauriEvent("query-stream:columns", { streamId, columns: FRUIT_COLUMNS });
    emitTauriEvent("query-stream:rows", { streamId, rows: [[1, "apple", 5]] });
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    await screen.getByRole("button", { name: t("gridStopButton") }).click();

    // バックエンドへキャンセルが届き、キャンセル済みステータスが出る。
    await vi.waitFor(() => {
      expect(invocationsOf("cancel_stream")).toEqual([{ streamId }]);
    }, { timeout: 5000 });
    await expect.element(screen.getByText(t("statusQueryCancelled"))).toBeVisible();

    // 取得済みの行は保持される。
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    // キャンセル後に届いた行イベントは購読解除済みのため反映されない
    // (cancel はリスナーを同期的に外すので、この emit の時点で配送先はない)。
    emitTauriEvent("query-stream:rows", { streamId, rows: [[2, "banana", 3]] });
    expect(screen.getByRole("gridcell", { name: "banana", exact: true }).query()).toBeNull();
  });
});

describe("シナリオ: インラインセル編集 → pending → Apply (実ブラウザ)", () => {
  it("セルをダブルクリックで編集し、Apply で UPDATE が 1 トランザクションに乗る", async () => {
    registerAutoStream();
    const applied: string[][] = [];
    onCommand("run_query_transaction", (args) => {
      applied.push(args.statements as string[]);
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

    // PK (id=2) を WHERE に使った UPDATE が 1 文だけトランザクションに乗る。
    await vi.waitFor(() => {
      expect(applied).toEqual([
        ["UPDATE `appdb`.`fruits` SET `qty` = 42 WHERE `id` = 2;"],
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

  it("接続を切り替えると前のタブは退避され、元の接続に戻すと復元される", async () => {
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

    // 前のセッションは切断され、Alpha のタブは localStorage に退避されている。
    expect(invocationsOf("disconnect")).toEqual([{ sessionId: `sess-${ALPHA.id}-1` }]);
    const saved = JSON.parse(localStorage.getItem(`noobdb.tabs.${ALPHA.id}`) ?? "null") as {
      panes?: { tabs?: { kind?: string; table?: string }[] }[];
    } | null;
    expect(saved?.panes?.[0]?.tabs?.[0]).toMatchObject({ kind: "table", table: "fruits" });

    // Alpha に戻ると fruits タブが復元され、データも再取得される。
    await connectToProfile(screen, /Alpha DB/, "appdb");
    await expect.element(screen.getByRole("tab", { name: /fruits/ })).toBeVisible();
    await expect.element(screen.getByRole("gridcell", { name: "apple", exact: true })).toBeVisible();

    // connect は Alpha → Beta → Alpha の 3 回。
    expect(invocationsOf("connect")).toHaveLength(3);
  });
});
