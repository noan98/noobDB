import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { api, listenDumpStream, type DumpStreamHandlers } from "../api/tauri";
import { dumpOptionLock, resolveDumpOptions, type DumpLockContext } from "../dumpOptionLocks";
import { DumpModal } from "../components/DumpModal";
import { t } from "../i18n";
import { loadDumpPrefs, saveDumpPrefs } from "../inputMemory";

// ダンプ実行時のイベント購読は Tauri 無しの jsdom では張れないので、購読だけ差し替える。
vi.mock("../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tauri")>()),
  listenDumpStream: vi.fn(async () => () => {}),
}));

/**
 * DB ダンプモーダル (#604)。マウント時に Tauri 呼び出しを持たない (`dumpDatabase` は
 * 実行ボタン押下時のみ)。ダイアログとしてマウントでき、タイトルが可視であること・
 * 閉じるボタンで `onClose` が呼ばれることを固定する。
 */
describe("DumpModal render smoke (#604)", () => {
  it("mounts as a dialog and shows the dump title with the database name", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="appdb" driver="mysql" onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("dumpTitle", { database: "appdb" }))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(<DumpModal sessionId="s1" database="appdb" driver="mysql" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t("dumpClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // SQLite はライブ接続から直接生成する (外部ツール不要) ので、外部ツール前提の
  // 注記ではなくネイティブ用の注記と、適用できるオプションを表示する。
  it("shows native-dump note and options for sqlite", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    expect(screen.getByText(t("dumpNoteNative"))).toBeInTheDocument();
    expect(screen.queryByText(t("dumpNote"))).not.toBeInTheDocument();
    expect(screen.getByText(t("dumpOptNoData"))).toBeInTheDocument();
    expect(screen.getByText(t("dumpOptAddDropTable"))).toBeInTheDocument();
    // mysqldump 専用のオプションは出さない。
    expect(screen.queryByText(t("dumpOptSingleTransaction"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("dumpOptEvents"))).not.toBeInTheDocument();
  });

  // gzip (#1539): 全ドライバで選べ、切り替えると保存先の拡張子が .sql ⇔ .sql.gz に追従する。
  it("gzip toggle swaps the save path extension between .sql and .sql.gz", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    const pathInput = screen.getByLabelText(t("dumpSavePath")) as HTMLInputElement;
    expect(pathInput.value.endsWith(".sql")).toBe(true);
    const gzip = screen.getByRole("switch", { name: t("dumpOptGzip") });
    fireEvent.click(gzip);
    expect(pathInput.value.endsWith(".sql.gz")).toBe(true);
    fireEvent.click(gzip);
    expect(pathInput.value.endsWith(".sql")).toBe(true);
    expect(pathInput.value.endsWith(".gz")).toBe(false);
  });

  // #1624: ドライバ別の追加オプション。
  it("shows the mysql-only extra flags and the sqlite-only snapshot toggle per driver", () => {
    const { unmount } = renderWithProviders(
      <DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />,
    );
    expect(screen.getByRole("switch", { name: t("dumpOptNoTablespaces") })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: t("dumpOptGtidPurgedOff") })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: t("dumpOptChecksum") })).not.toBeChecked();
    expect(screen.queryByRole("switch", { name: t("dumpOptSqliteSnapshot") })).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    expect(screen.queryByRole("switch", { name: t("dumpOptNoTablespaces") })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: t("dumpOptSqliteSnapshot") })).toBeInTheDocument();
  });

  it("スナップショット中は無視される SQL 形式向けスイッチを無効にする", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    expect(screen.getByRole("switch", { name: t("dumpOptNoData") })).toBeEnabled();
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptSqliteSnapshot") }));
    for (const k of [
      "dumpOptNoData",
      "dumpOptNoCreateInfo",
      "dumpOptAddDropTable",
      "dumpOptFormatSql",
    ] as const) {
      expect(screen.getByRole("switch", { name: t(k) })).toBeDisabled();
    }
    expect(screen.getByRole("switch", { name: t("dumpOptGzip") })).toBeEnabled();
  });

  it("snapshot toggle swaps the save path extension to .db (and .db.gz with gzip)", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    const pathInput = screen.getByLabelText(t("dumpSavePath")) as HTMLInputElement;
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptSqliteSnapshot") }));
    expect(pathInput.value.endsWith(".db")).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptGzip") }));
    expect(pathInput.value.endsWith(".db.gz")).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptSqliteSnapshot") }));
    expect(pathInput.value.endsWith(".sql.gz")).toBe(true);
  });
});

// 前回のスイッチと保存先ディレクトリをプロファイルごとに復元する (#1631)。
// #2033: MySQL / PostgreSQL は外部ツールなしのネイティブ生成を選べる。
describe("DumpModal 生成エンジンのカード選択 (#2094)", () => {
  const engine = (id: "native" | "external") => screen.getByTestId(`dump-engine-${id}`);
  const mockTool = (path: string | null) =>
    vi.spyOn(api, "dumpToolStatus").mockResolvedValue({ tool: "mysqldump", path, install: null } as never);

  afterEach(() => vi.restoreAllMocks());

  it("mysql / postgres にだけエンジンのカードを出し、既定は外部ツール。SQLite には出さない", () => {
    const { unmount } = renderWithProviders(
      <DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />,
    );
    expect(engine("external")).toHaveAttribute("aria-pressed", "true");
    expect(engine("native")).toHaveAttribute("aria-pressed", "false");
    unmount();
    const pg = renderWithProviders(
      <DumpModal sessionId="s1" database="public" driver="postgres" onClose={() => {}} />,
    );
    expect(engine("native")).toBeInTheDocument();
    pg.unmount();
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    expect(screen.queryByTestId("dump-engine-native")).not.toBeInTheDocument();
  });

  it("オプションは構造 / データ / 出力 / 互換の 4 グループに分かれる", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />);
    for (const g of ["structure", "data", "output", "compat"]) {
      expect(screen.getByTestId(`dump-group-${g}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("dump-group-data")).toContainElement(
      screen.getByRole("switch", { name: t("dumpOptSingleTransaction") }),
    );
  });

  it("内蔵を選ぶと注記が切り替わり、外部ツール専用のスイッチは消さずに理由つきで無効になる", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />);
    expect(screen.getByText(t("dumpNote", { tool: "mysqldump" }))).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: t("dumpOptSingleTransaction") })).toBeEnabled();
    fireEvent.click(engine("native"));
    expect(engine("native")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(t("dumpNoteNative"))).toBeInTheDocument();
    // 内蔵の実挙動に合わせた固定値で表示する (一貫性は取れない = OFF、GTID / テーブルスペース / 所有者などは常に出さない = ON)。
    const single = screen.getByRole("switch", { name: t("dumpOptSingleTransaction") });
    expect(single).toBeDisabled();
    expect(single).not.toBeChecked();
    for (const k of ["dumpOptNoTablespaces", "dumpOptGtidPurgedOff", "dumpOptCompleteInsert"] as const) {
      const sw = screen.getByRole("switch", { name: t(k) });
      expect(sw).toBeDisabled();
      expect(sw).toBeChecked();
    }
    // 理由が画面に出る (単一トランザクションは一貫性の説明つき)。
    expect(screen.getByText(t("dumpLockNativeConsistency"))).toBeInTheDocument();
    expect(screen.getAllByText(t("dumpLockNativeAlways")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t("dumpLockBadge")).length).toBeGreaterThan(0);
    // ネイティブでも効くスイッチは触れる。
    expect(screen.getByRole("switch", { name: t("dumpOptNoData") })).toBeEnabled();
    expect(screen.getByRole("switch", { name: t("dumpOptGzip") })).toBeEnabled();
    // 外部ツールへ戻すと復帰する。
    fireEvent.click(engine("external"));
    expect(screen.getByRole("switch", { name: t("dumpOptSingleTransaction") })).toBeEnabled();
    expect(screen.getByRole("switch", { name: t("dumpOptSingleTransaction") })).toBeChecked();
  });

  it("ツール未導入なら自動で内蔵へ切り替え、外部ツールのカードは無効 + 理由つきになる", async () => {
    mockTool(null);
    renderWithProviders(<DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />);
    await waitFor(() => expect(engine("native")).toHaveAttribute("aria-pressed", "true"));
    // 内蔵を選んでいても、未導入の外部カードは無効 + 理由つき。
    expect(engine("external")).toBeDisabled();
    expect(engine("external")).toHaveTextContent(t("dumpEngineToolMissing"));
    expect(engine("external")).toHaveTextContent(t("dumpEngineExternalDisabled", { tool: "mysqldump" }));
    expect(engine("native")).toBeEnabled();
    // 警告ではなく info の帯で切り替えを知らせる。
    expect(screen.getByText(t("dumpEngineAutoSwitched", { tool: "mysqldump" }))).toBeInTheDocument();
    expect(screen.queryByText(t("dumpToolMissingTitle", { tool: "mysqldump" }))).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: t("dumpOptSingleTransaction") })).toBeDisabled();
  });

  it("自動で内蔵へ切り替えても、実行時の prefs には元の選択 (外部ツール) を保存する", async () => {
    localStorage.clear();
    mockTool(null);
    vi.spyOn(api, "dumpDatabase").mockResolvedValue(undefined as never);
    renderWithProviders(
      <DumpModal sessionId="s1" database="app" driver="mysql" profileId="p-auto" onClose={() => {}} />,
    );
    await waitFor(() => expect(engine("native")).toHaveAttribute("aria-pressed", "true"));
    fireEvent.change(screen.getByLabelText(t("dumpSavePath")), { target: { value: "/tmp/out.sql" } });
    fireEvent.click(screen.getByRole("button", { name: t("dumpExecute") }));
    await waitFor(() => expect(api.dumpDatabase).toHaveBeenCalled());
    expect(vi.mocked(api.dumpDatabase).mock.calls[0][0].options.native).toBe(true);
    expect(loadDumpPrefs("p-auto")?.options.native).toBe(false);
  });

  it("自動切り替え後にルーチンを自分で変えたら、その選択を prefs に保存する", async () => {
    localStorage.clear();
    mockTool(null);
    vi.spyOn(api, "dumpDatabase").mockResolvedValue(undefined as never);
    renderWithProviders(
      <DumpModal sessionId="s1" database="app" driver="mysql" profileId="p-rt" onClose={() => {}} />,
    );
    await waitFor(() => expect(engine("native")).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptRoutines") }));
    fireEvent.change(screen.getByLabelText(t("dumpSavePath")), { target: { value: "/tmp/out.sql" } });
    fireEvent.click(screen.getByRole("button", { name: t("dumpExecute") }));
    await waitFor(() => expect(api.dumpDatabase).toHaveBeenCalled());
    expect(vi.mocked(api.dumpDatabase).mock.calls[0][0].options.routines).toBe(true);
    expect(loadDumpPrefs("p-rt")?.options.routines).toBe(true);
    expect(loadDumpPrefs("p-rt")?.options.native).toBe(false);
  });

  it("内蔵でダンプ実行中は、未導入ツールのインストールボタンを押せない", async () => {
    vi.spyOn(api, "dumpToolStatus").mockResolvedValue({
      tool: "mysqldump",
      path: null,
      install: { manager: "winget", command: "winget install mysql", location: "C:/x", oneClick: true },
    } as never);
    vi.spyOn(api, "dumpDatabase").mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />);
    const install = await screen.findByRole("button", { name: t("dumpToolInstall", { tool: "mysqldump" }) });
    expect(install).toBeEnabled();
    fireEvent.change(screen.getByLabelText(t("dumpSavePath")), { target: { value: "/tmp/out.sql" } });
    fireEvent.click(screen.getByRole("button", { name: t("dumpExecute") }));
    await waitFor(() => expect(install).toBeDisabled());
  });

  it("prefs の native: true でツール未導入なら「切り替えました」は出さず、未導入の案内だけを info で出す", async () => {
    localStorage.clear();
    saveDumpPrefs("p-nat2", { options: { native: true }, dir: "" });
    mockTool(null);
    renderWithProviders(
      <DumpModal sessionId="s1" database="app" driver="mysql" profileId="p-nat2" onClose={() => {}} />,
    );
    await waitFor(() => expect(engine("external")).toBeDisabled());
    expect(engine("native")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(t("dumpEngineAutoSwitched", { tool: "mysqldump" }))).not.toBeInTheDocument();
    expect(screen.getByText(t("dumpToolMissingTitle", { tool: "mysqldump" }))).toBeInTheDocument();
  });

  it("実行エラー後の再検出でツールが無くても、選択中の外部ツールを内蔵へ切り替えない", async () => {
    const status = vi.spyOn(api, "dumpToolStatus");
    status.mockResolvedValueOnce({ tool: "mysqldump", path: "/x", install: null } as never);
    status.mockResolvedValue({ tool: "mysqldump", path: null, install: null } as never);
    vi.spyOn(api, "dumpDatabase").mockResolvedValue(undefined as never);
    let handlers: DumpStreamHandlers | null = null;
    vi.mocked(listenDumpStream).mockImplementationOnce(async (_id, h) => {
      handlers = h;
      return () => {};
    });
    renderWithProviders(<DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />);
    await waitFor(() => expect(engine("external")).toHaveTextContent(t("dumpEngineToolFound")));
    fireEvent.change(screen.getByLabelText(t("dumpSavePath")), { target: { value: "/tmp/out.sql" } });
    fireEvent.click(screen.getByRole("button", { name: t("dumpExecute") }));
    await waitFor(() => expect(handlers).not.toBeNull());
    await waitFor(() => expect(api.dumpDatabase).toHaveBeenCalled());
    (handlers as unknown as DumpStreamHandlers).onError?.({ error: "boom" } as never);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(engine("external")).toBeDisabled());
    expect(engine("external")).toHaveAttribute("aria-pressed", "true");
    expect(engine("native")).toHaveAttribute("aria-pressed", "false");
  });

  it("prefs の native: true で開くと内蔵が選ばれ、外部へ戻すと元の値が復帰する", () => {
    localStorage.clear();
    saveDumpPrefs("p-nat", { options: { native: true, singleTransaction: true }, dir: "" });
    renderWithProviders(
      <DumpModal sessionId="s1" database="app" driver="mysql" profileId="p-nat" onClose={() => {}} />,
    );
    expect(engine("native")).toHaveAttribute("aria-pressed", "true");
    const single = screen.getByRole("switch", { name: t("dumpOptSingleTransaction") });
    expect(single).toBeDisabled();
    expect(single).not.toBeChecked();
    fireEvent.click(engine("external"));
    expect(screen.getByRole("switch", { name: t("dumpOptSingleTransaction") })).toBeChecked();
    expect(screen.getByRole("switch", { name: t("dumpOptSingleTransaction") })).toBeEnabled();
  });

  it("SQLite のスナップショット ON では SQL 形式向けスイッチが OFF 表示になり、送信値も false になる", async () => {
    const dump = vi.spyOn(api, "dumpDatabase").mockResolvedValue(undefined as never);
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(t("dumpSavePath")), { target: { value: "/tmp/out.db" } });
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptNoData") }));
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptSqliteSnapshot") }));
    for (const k of ["dumpOptNoData", "dumpOptAddDropTable"] as const) {
      expect(screen.getByRole("switch", { name: t(k) })).toBeDisabled();
      expect(screen.getByRole("switch", { name: t(k) })).not.toBeChecked();
    }
    expect(screen.getAllByText(t("dumpLockSnapshot")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: t("dumpExecute") }));
    await waitFor(() => expect(dump).toHaveBeenCalled());
    const sent = dump.mock.calls[0][0].options;
    expect(sent.sqliteSnapshot).toBe(true);
    expect(sent.noData).toBe(false);
    expect(sent.addDropTable).toBe(false);
  });

  it("ダンプ進捗を進捗バー・StatTile で出し、完了で緑のバーと Callout を残す (#2092)", async () => {
    vi.spyOn(api, "dumpToolStatus").mockResolvedValue({
      tool: "mysqldump",
      path: "/x",
      install: null,
    } as never);
    vi.spyOn(api, "dumpDatabase").mockResolvedValue(undefined as never);
    let handlers: DumpStreamHandlers | null = null;
    vi.mocked(listenDumpStream).mockImplementationOnce(async (_id, h) => {
      handlers = h;
      return () => {};
    });
    renderWithProviders(<DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(t("dumpSavePath")), { target: { value: "/tmp/out.sql" } });
    fireEvent.click(screen.getByRole("button", { name: t("dumpExecute") }));
    await waitFor(() => expect(handlers).not.toBeNull());
    await waitFor(() => expect(api.dumpDatabase).toHaveBeenCalled());
    const h = handlers as unknown as DumpStreamHandlers;
    act(() => h.onProgress?.({ bytes: 2048, elapsedMs: 10_000, tables: 1, tablesTotal: 4 } as never));
    const detail = await screen.findByTestId("dump-progress-detail");
    expect(detail).toHaveTextContent(t("progressPercent", { percent: 25 }));
    expect(detail).toHaveTextContent(t("dumpStatTables"));
    expect(detail).toHaveTextContent(t("progressEta", { time: "0:30" }));
    act(() => h.onDone?.({ bytes: 4096 } as never));
    const cb = await screen.findByText(t("dumpResultDone", { bytes: "4.1 KB", secs: "10.0" }));
    expect(cb).toBeInTheDocument();
    const bar = screen
      .getByTestId("dump-progress-detail")
      .querySelector("[aria-hidden] > div") as HTMLElement;
    expect(bar.style.background).toContain("--success-solid");
  });

  it("ツールが検出済みならカードに検出済みを出し、選べる", async () => {
    mockTool("/usr/bin/mysqldump");
    renderWithProviders(<DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />);
    await waitFor(() => expect(engine("external")).toHaveTextContent(t("dumpEngineToolFound")));
    expect(engine("external")).toBeEnabled();
  });

  it("PostgreSQL は pg_dump のとき関数を常に出す旨で無効 (表示は固定)、内蔵なら選べて既定オン", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="public" driver="postgres" onClose={() => {}} />);
    const routines = screen.getByRole("switch", { name: t("dumpOptRoutines") });
    expect(routines).toBeDisabled();
    expect(routines).toBeChecked();
    expect(screen.getByText(t("dumpLockPgDumpRoutines"))).toBeInTheDocument();
    fireEvent.click(engine("native"));
    expect(screen.getByRole("switch", { name: t("dumpOptRoutines") })).toBeEnabled();
    expect(screen.getByRole("switch", { name: t("dumpOptRoutines") })).toBeChecked();
  });

  it("無効にしたスイッチの理由が画面に出て、実行時の値もそれに一致する (表示と実行の一致)", async () => {
    const dump = vi.spyOn(api, "dumpDatabase").mockResolvedValue(undefined as never);
    vi.spyOn(api, "dumpToolStatus").mockResolvedValue({
      tool: "mysqldump",
      path: "/x",
      install: null,
    } as never);
    renderWithProviders(<DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(t("dumpSavePath")), { target: { value: "/tmp/out.sql" } });
    // 単一トランザクション・GTID を ON にしてから内蔵へ切り替える。
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptGtidPurgedOff") }));
    fireEvent.click(engine("native"));
    fireEvent.click(screen.getByRole("button", { name: t("dumpExecute") }));
    await waitFor(() => expect(dump).toHaveBeenCalled());
    const sent = dump.mock.calls[0][0].options;
    expect(sent.native).toBe(true);
    expect(sent.singleTransaction).toBe(false);
    // 内蔵は GTID / テーブルスペース文 / 所有者などを常に出さない (= 常にその動作) ので true を送る。
    expect(sent.setGtidPurgedOff).toBe(true);
    expect(sent.noTablespaces).toBe(true);
    expect(sent.completeInsert).toBe(true);
    // 効くスイッチは保たれる。
    expect(sent.triggers).toBe(true);
  });
});

// 送信値の上書きは画面の無効判定と同じ関数を通る (#2094)。
describe("resolveDumpOptions (#2094)", () => {
  const base = {
    singleTransaction: true,
    routines: false,
    events: false,
    triggers: true,
    addDropTable: true,
    extendedInsert: true,
    completeInsert: true,
    noData: true,
    noCreateInfo: true,
    noOwner: true,
    noPrivileges: true,
    pgSchema: null,
    formatSql: true,
    gzip: false,
    noTablespaces: true,
    setGtidPurgedOff: true,
    writeChecksum: false,
    sqliteSnapshot: false,
    native: false,
  };
  const ctx = (o: Partial<DumpLockContext>): DumpLockContext => ({
    driver: "mysql",
    native: false,
    sqliteSnapshot: false,
    ...o,
  });

  it("外部ツールでは何も上書きしない (MySQL)", () => {
    expect(resolveDumpOptions(base, ctx({}))).toEqual(base);
  });

  it("内蔵生成では項目ごとの固定値に置き換える (一貫性 = false、常に出さない / 列名つき = true)", () => {
    const flipped = {
      ...base,
      singleTransaction: true,
      completeInsert: false,
      noOwner: false,
      noPrivileges: false,
      setGtidPurgedOff: false,
      noTablespaces: false,
    };
    const r = resolveDumpOptions(flipped, ctx({ native: true }));
    expect(r.singleTransaction).toBe(false);
    for (const k of [
      "completeInsert",
      "noOwner",
      "noPrivileges",
      "setGtidPurgedOff",
      "noTablespaces",
    ] as const) {
      expect(r[k]).toBe(true);
    }
    expect(dumpOptionLock("singleTransaction", ctx({ native: true }))?.reason).toBe(
      "dumpLockNativeConsistency",
    );
    expect(dumpOptionLock("noOwner", ctx({ native: true }))?.reason).toBe("dumpLockNativeAlways");
    expect(r.noData).toBe(true);
    expect(r.triggers).toBe(true);
  });

  it("SQLite スナップショットでは SQL 形式向けのオプションを false にする", () => {
    const r = resolveDumpOptions(base, ctx({ driver: "sqlite", sqliteSnapshot: true }));
    expect(r.addDropTable).toBe(false);
    expect(r.noData).toBe(false);
    expect(r.noCreateInfo).toBe(false);
    expect(r.formatSql).toBe(false);
    expect(r.gzip).toBe(false);
  });

  it("PostgreSQL の pg_dump ではルーチンを常に true、内蔵ではユーザの値のまま", () => {
    expect(resolveDumpOptions(base, ctx({ driver: "postgres" })).routines).toBe(true);
    expect(resolveDumpOptions(base, ctx({ driver: "postgres", native: true })).routines).toBe(false);
    expect(dumpOptionLock("routines", ctx({ driver: "postgres", native: true }))).toBeNull();
  });
});

describe("DumpModal 前回入力の記憶 (#1631)", () => {
  it("プロファイルに保存された gzip・保存先ディレクトリを初期値にする", () => {
    localStorage.clear();
    saveDumpPrefs("p1", { options: { gzip: true, noData: true }, dir: "/backups/db" });
    renderWithProviders(
      <DumpModal sessionId="s1" database="main" driver="sqlite" profileId="p1" onClose={() => {}} />,
    );
    const pathInput = screen.getByLabelText(t("dumpSavePath")) as HTMLInputElement;
    expect(pathInput.value.startsWith("/backups/db/")).toBe(true);
    expect(pathInput.value.endsWith(".sql.gz")).toBe(true);
    expect(screen.getByRole("switch", { name: t("dumpOptGzip") })).toBeChecked();
    expect(screen.getByRole("switch", { name: t("dumpOptNoData") })).toBeChecked();
  });

  it("別プロファイルや profileId なしでは復元しない", () => {
    localStorage.clear();
    saveDumpPrefs("p1", { options: { gzip: true }, dir: "/backups/db" });
    renderWithProviders(
      <DumpModal sessionId="s1" database="main" driver="sqlite" profileId="p2" onClose={() => {}} />,
    );
    expect((screen.getByLabelText(t("dumpSavePath")) as HTMLInputElement).value.startsWith("/")).toBe(false);
    expect(screen.getByRole("switch", { name: t("dumpOptGzip") })).not.toBeChecked();
  });
});
