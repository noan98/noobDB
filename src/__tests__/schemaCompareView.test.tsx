import { configure, getConfig, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, chooseListboxOption } from "./testUtils";
import { SchemaCompareView } from "../components/SchemaCompareView";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import { api } from "../api/tauri";

// 比較結果の描画 (2 接続 + 比較 + データ比較フォーム) は CI の混んだ shard で既定の
// 1 秒を超えることがあり、findBy* が時々落ちていた。このファイルだけ待ちを延ばす。
let prevAsyncTimeout = 1000;
beforeAll(() => {
  prevAsyncTimeout = getConfig().asyncUtilTimeout;
  configure({ asyncUtilTimeout: 5000 });
});
afterAll(() => {
  configure({ asyncUtilTimeout: prevAsyncTimeout });
});

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      connect: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      listDatabases: vi.fn().mockResolvedValue(["db1"]),
      compareSchema: vi.fn(),
      generateSyncSql: vi.fn(),
      applySyncSql: vi.fn().mockResolvedValue(1),
      releaseDataDiffs: vi.fn().mockResolvedValue(undefined),
      compareTableData: vi.fn(),
      listTables: vi.fn(),
      describeTable: vi.fn().mockResolvedValue([]),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listDatabases).mockResolvedValue(["db1"]);
  vi.mocked(api.applySyncSql).mockResolvedValue(1);
});

/**
 * スキーマ / データ比較ビュー (#604)。マウント時に Tauri 呼び出しを持たない
 * (接続 / 比較はユーザ操作時のみ)。プロファイル一覧を与えて例外なくマウントでき、
 * タイトルが可視であること・閉じるボタンで `onClose` が呼ばれることを固定する。
 */
const PROFILES = [makeProfile({ id: "p-a", name: "Alpha" }), makeProfile({ id: "p-b", name: "Beta" })];

describe("SchemaCompareView render smoke (#604)", () => {
  it("mounts with a profile list and shows the compare title", () => {
    renderWithProviders(<SchemaCompareView profiles={PROFILES} onClose={() => {}} />);
    expect(screen.getByText(t("schemaCompareTitle"))).toBeInTheDocument();
  });

  it("mounts with an empty profile list without throwing", () => {
    renderWithProviders(<SchemaCompareView profiles={[]} onClose={() => {}} />);
    expect(screen.getByText(t("schemaCompareTitle"))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(<SchemaCompareView profiles={PROFILES} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t("schemaCompareClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/** 接続選択の競合と適用成功の表示 (#1599)。 */
describe("SchemaCompareView の非同期整合 (#1599)", () => {
  it("遅れて届いた古い接続結果で、外した選択を巻き戻さない", async () => {
    let resolveConnect: (v: { session_id: string }) => void = () => {};
    vi.mocked(api.connect).mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve as typeof resolveConnect;
      }) as never,
    );
    renderWithProviders(<SchemaCompareView profiles={PROFILES} onClose={() => {}} />);
    const [sourceProfile] = screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(sourceProfile, "p-a");
    await waitFor(() => expect(api.connect).toHaveBeenCalled());
    chooseListboxOption(sourceProfile, "");
    resolveConnect({ session_id: "s-a" });
    await new Promise((r) => setTimeout(r, 50));
    expect(sourceProfile).toHaveTextContent(t("schemaCompareSelectProfile"));
  });

  it("適用成功の文言が直後の再比較で消えずに表示される", async () => {
    vi.mocked(api.connect).mockResolvedValue({ session_id: "s1" } as never);
    const diff = {
      source_driver: "mysql",
      target_driver: "mysql",
      tables: [
        {
          name: "users",
          status: "source_only",
          columns: [],
          foreign_keys: [],
        },
      ],
    };
    vi.mocked(api.compareSchema).mockImplementation(async () => structuredClone(diff) as never);
    vi.mocked(api.generateSyncSql).mockResolvedValue({
      statements: [
        { sql: "CREATE TABLE users (id int)", table: "users", kind: "create_table", destructive: false },
      ],
      warnings: [],
    } as never);
    renderWithProviders(<SchemaCompareView profiles={PROFILES} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-a");
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    chooseListboxOption(boxes()[2], "p-b");
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[1]).toHaveTextContent("db1"));
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));
    fireEvent.click(await screen.findByText(t("schemaCompareGenerate")));
    fireEvent.click(await screen.findByText(t("schemaCompareApply", { count: 1 })));
    fireEvent.click(await screen.findByText(t("confirmDefaultOk")));
    expect(await screen.findByText(t("schemaCompareApplyDone", { count: 1 }))).toBeInTheDocument();
    expect(api.compareSchema).toHaveBeenCalledTimes(2);
    // 一瞬映るだけでなく、再比較が落ち着いた後も残る。
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText(t("schemaCompareApplyDone", { count: 1 }))).toBeInTheDocument();
  });
});

describe("SchemaCompareView: アタッチした SQLite がターゲットのとき適用できない (#2129)", () => {
  const profiles = [
    makeProfile({ id: "p-a", name: "Alpha", driver: "sqlite" }),
    makeProfile({ id: "p-b", name: "Beta", driver: "sqlite" }),
  ];

  async function openPlan(targetDb: string) {
    vi.mocked(api.connect).mockResolvedValue({ session_id: "s1" } as never);
    vi.mocked(api.listDatabases).mockResolvedValue(["main", "ext"]);
    vi.mocked(api.compareSchema).mockResolvedValue({
      source_driver: "sqlite",
      target_driver: "sqlite",
      tables: [{ name: "users", status: "source_only", columns: [], foreign_keys: [] }],
    } as never);
    vi.mocked(api.generateSyncSql).mockResolvedValue({
      statements: [
        { sql: "CREATE TABLE users (id int)", table: "users", kind: "create_table", destructive: false },
      ],
      warnings: [],
    } as never);
    renderWithProviders(<SchemaCompareView profiles={profiles} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-a");
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    chooseListboxOption(boxes()[2], "p-b");
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("main"));
    chooseListboxOption(boxes()[3], targetDb);
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));
    fireEvent.click(await screen.findByText(t("schemaCompareGenerate")));
    return screen.findByText(t("schemaCompareApply", { count: 1 }));
  }

  it("別名がターゲットなら「適用」を無効にして理由を出す", async () => {
    const apply = await openPlan("ext");
    expect(apply.closest("button")).toBeDisabled();
    expect(screen.getByText(t("schemaCompareApplyAttachedUnsupported"))).toBeInTheDocument();
  });

  it("main がターゲットなら従来どおり適用できる", async () => {
    const apply = await openPlan("main");
    expect(apply.closest("button")).not.toBeDisabled();
    expect(screen.queryByText(t("schemaCompareApplyAttachedUnsupported"))).not.toBeInTheDocument();
  });
});

/** 異名の 2 表のデータ比較 (#1880)。 */
describe("SchemaCompareView の異名テーブル比較 (#1880)", () => {
  it("ターゲットの表を選ぶと targetTable を付けて比較し、既定は同名 (null)", async () => {
    vi.mocked(api.connect).mockResolvedValue({ session_id: "s1" } as never);
    const tbl = (name: string, status: string) => ({ name, status, columns: [], foreign_keys: [] });
    vi.mocked(api.compareSchema).mockResolvedValue({
      source_driver: "mysql",
      target_driver: "mysql",
      tables: [tbl("orders", "same"), tbl("orders_archive", "target_only")],
    } as never);
    vi.mocked(api.compareTableData).mockResolvedValue({
      diff_id: "d1",
      diff: {
        target_driver: "mysql",
        table: "orders_archive",
        columns: ["id"],
        column_types: ["int"],
        primary_key: ["id"],
        key_kind: "primary_key",
        rows: [],
        truncated: false,
        source_count: 0,
        target_count: 0,
      },
    } as never);
    renderWithProviders(<SchemaCompareView profiles={PROFILES} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-a");
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    chooseListboxOption(boxes()[2], "p-b");
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));
    const sourceTable = await screen.findByLabelText(t("schemaCompareDataSourceTable"));
    const targetTable = screen.getByLabelText(t("schemaCompareDataTargetTable"));
    chooseListboxOption(sourceTable, "orders");
    chooseListboxOption(targetTable, "orders_archive");
    // 全行比較は進捗イベントの購読を伴うので、テストでは上限つき比較にする。
    fireEvent.click(screen.getByLabelText(t("schemaCompareDataAllRows")));
    fireEvent.click(screen.getByText(t("schemaCompareDataCompare")));
    await waitFor(() => expect(api.compareTableData).toHaveBeenCalled());
    expect(vi.mocked(api.compareTableData).mock.calls[0][0]).toMatchObject({
      table: "orders",
      targetTable: "orders_archive",
    });
    expect(
      await screen.findByText(
        t("schemaCompareDataComparedPair", { source: "orders", target: "orders_archive" }),
      ),
    ).toBeInTheDocument();
  });

  it("同じ接続・同じ DB で同じ表を指すと比較を無効にして案内を出す", async () => {
    vi.mocked(api.connect).mockResolvedValue({ session_id: "s1" } as never);
    const tbl = (name: string, status: string) => ({ name, status, columns: [], foreign_keys: [] });
    vi.mocked(api.compareSchema).mockResolvedValue({
      source_driver: "mysql",
      target_driver: "mysql",
      tables: [tbl("orders", "same"), tbl("orders_archive", "same")],
    } as never);
    renderWithProviders(<SchemaCompareView profiles={PROFILES} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-a");
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    chooseListboxOption(boxes()[2], "p-b");
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));
    const sourceTable = await screen.findByLabelText(t("schemaCompareDataSourceTable"));
    const targetTable = screen.getByLabelText(t("schemaCompareDataTargetTable"));
    chooseListboxOption(sourceTable, "orders");
    expect(await screen.findByText(t("schemaCompareDataSameTable"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("schemaCompareDataCompare") })).toBeDisabled();
    chooseListboxOption(targetTable, "orders_archive");
    await waitFor(() => expect(screen.queryByText(t("schemaCompareDataSameTable"))).toBeNull());
    expect(screen.getByRole("button", { name: t("schemaCompareDataCompare") })).not.toBeDisabled();
  });
});

/** 列の対応付け (#2099)。 */
describe("SchemaCompareView の列の対応付け (#2099)", () => {
  const colInfo = (name: string) => ({
    name,
    data_type: "text",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  });

  it("未割り当ての列があると比較できず、表を変えると対応表を破棄する", async () => {
    vi.mocked(api.connect).mockResolvedValue({ session_id: "s1" } as never);
    const tbl = (name: string, status: string) => ({ name, status, columns: [], foreign_keys: [] });
    vi.mocked(api.compareSchema).mockResolvedValue({
      source_driver: "mysql",
      target_driver: "mysql",
      tables: [tbl("users_old", "same"), tbl("users_new", "same"), tbl("users_x", "same")],
    } as never);
    vi.mocked(api.describeTable).mockImplementation((async (_s: string, _d: string, table: string) =>
      table === "users_old"
        ? [colInfo("id"), colInfo("user_name")]
        : table === "users_new"
          ? [colInfo("id"), colInfo("username")]
          : [colInfo("id"), colInfo("user_name")]) as never);
    renderWithProviders(<SchemaCompareView profiles={PROFILES} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-a");
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    chooseListboxOption(boxes()[2], "p-b");
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));
    const sourceTable = await screen.findByLabelText(t("schemaCompareDataSourceTable"));
    const targetTable = screen.getByLabelText(t("schemaCompareDataTargetTable"));
    chooseListboxOption(sourceTable, "users_old");
    chooseListboxOption(targetTable, "users_new");
    const mapTrigger = await screen.findByRole("combobox", {
      name: t("schemaCompareColMapTarget", { column: "user_name" }),
    });
    const compareBtn = () => screen.getByRole("button", { name: t("schemaCompareDataCompare") });
    await waitFor(() => expect(compareBtn()).toBeDisabled());
    chooseListboxOption(mapTrigger, "username");
    await waitFor(() => expect(compareBtn()).not.toBeDisabled());
    // ターゲット表を変えると前の対応付けは破棄され、新しい表で再び未割り当てになる。
    chooseListboxOption(targetTable, "users_x");
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: t("schemaCompareColMapTitle") })).toBeNull(),
    );
    expect(compareBtn()).not.toBeDisabled();
    chooseListboxOption(targetTable, "users_new");
    const again = await screen.findByRole("combobox", {
      name: t("schemaCompareColMapTarget", { column: "user_name" }),
    });
    expect(again).toHaveTextContent(t("schemaCompareColMapNone"));
    await waitFor(() => expect(compareBtn()).toBeDisabled());
  });
});

/** ドライバをまたぐデータ検証 (検証専用, #1869)。 */
describe("SchemaCompareView のクロスドライバ検証 (#1869)", () => {
  const MIXED = [
    makeProfile({ id: "p-my", name: "MySQL", driver: "mysql" }),
    makeProfile({ id: "p-pg", name: "Postgres", driver: "postgres" }),
  ];

  it("スキーマ比較は止めたままデータ比較を出し、検証専用の案内と同一視した列を示す", async () => {
    vi.mocked(api.connect)
      .mockResolvedValueOnce({ session_id: "s-my" } as never)
      .mockResolvedValueOnce({ session_id: "s-pg" } as never);
    vi.mocked(api.listTables).mockResolvedValue(["orders"]);
    vi.mocked(api.compareTableData).mockResolvedValue({
      diff_id: "d1",
      cross_driver: true,
      normalized_columns: [
        { column: "flag", kind: "boolean", source_type: "tinyint(1)", target_type: "boolean" },
      ],
      diff: {
        target_driver: "postgres",
        table: "orders",
        columns: ["id", "flag"],
        column_types: ["bigint", "tinyint(1)"],
        primary_key: ["id"],
        key_kind: "primary_key",
        rows: [],
        truncated: false,
        source_count: 3,
        target_count: 3,
      },
    } as never);
    renderWithProviders(<SchemaCompareView profiles={MIXED} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-my");
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    chooseListboxOption(boxes()[2], "p-pg");
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));

    // スキーマ比較は同一ドライバ必須のまま。
    expect(screen.getByRole("button", { name: t("schemaCompareCompare") })).toBeDisabled();
    expect(screen.getByText(t("schemaCompareDriverMismatch"))).toBeInTheDocument();
    // 検証専用の案内が出る。
    expect(await screen.findByText(t("schemaCompareCrossTitle"))).toBeInTheDocument();

    const sourceTable = await screen.findByLabelText(t("schemaCompareDataSourceTable"));
    chooseListboxOption(sourceTable, "orders");
    fireEvent.click(screen.getByLabelText(t("schemaCompareDataAllRows")));
    fireEvent.click(screen.getByText(t("schemaCompareDataCompare")));
    await waitFor(() => expect(api.compareTableData).toHaveBeenCalled());

    // 一致の通知と、同一視した列の Callout。
    expect(await screen.findByText(t("schemaCompareCrossMatchTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("schemaCompareCrossNormalizedTitle"))).toBeInTheDocument();
    expect(
      screen.getByText(
        t("schemaCompareCrossNormBoolean", { column: "flag", source: "tinyint(1)", target: "boolean" }),
      ),
    ).toBeInTheDocument();
    // 同期操作は出さない。
    expect(screen.queryByText(t("schemaCompareDataGenerate"))).toBeNull();
    expect(screen.queryByText(t("schemaCompareAllowDelete"))).toBeNull();
  });

  it("差分があれば行を一覧し、それでも同期 SQL の操作は出さない", async () => {
    vi.mocked(api.connect)
      .mockResolvedValueOnce({ session_id: "s-my" } as never)
      .mockResolvedValueOnce({ session_id: "s-pg" } as never);
    vi.mocked(api.listTables).mockResolvedValue(["orders"]);
    vi.mocked(api.compareTableData).mockResolvedValue({
      diff_id: "d1",
      cross_driver: true,
      normalized_columns: [],
      diff: {
        target_driver: "postgres",
        table: "orders",
        columns: ["id", "price"],
        column_types: ["bigint", "decimal(10,2)"],
        primary_key: ["id"],
        key_kind: "primary_key",
        rows: [
          {
            status: "different",
            key: [2],
            source: [2, "2.50"],
            target: [2, "2.51"],
            changed_columns: ["price"],
          },
          { status: "source_only", key: [4], source: [4, "4.00"], target: null, changed_columns: [] },
        ],
        truncated: false,
        source_count: 3,
        target_count: 3,
      },
    } as never);
    renderWithProviders(<SchemaCompareView profiles={MIXED} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-my");
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    chooseListboxOption(boxes()[2], "p-pg");
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
    const sourceTable = await screen.findByLabelText(t("schemaCompareDataSourceTable"));
    chooseListboxOption(sourceTable, "orders");
    fireEvent.click(screen.getByLabelText(t("schemaCompareDataAllRows")));
    fireEvent.click(screen.getByText(t("schemaCompareDataCompare")));
    expect(await screen.findByText(t("schemaCompareCrossDiffTitle"))).toBeInTheDocument();
    expect(screen.getByText(/price: "2\.50" → "2\.51"/)).toBeInTheDocument();
    expect(screen.queryByText(t("schemaCompareDataGenerate"))).toBeNull();
  });

  it("整数でない主キーを拒否されたとき、案内の文言を画面に出す", async () => {
    vi.mocked(api.connect)
      .mockResolvedValueOnce({ session_id: "s-my" } as never)
      .mockResolvedValueOnce({ session_id: "s-pg" } as never);
    vi.mocked(api.listTables).mockResolvedValue(["orders"]);
    vi.mocked(api.compareTableData).mockRejectedValue(
      "Invalid input: cross-driver comparison supports integer primary keys only (column 'code' is varchar(10) on the source and character varying(10) on the target)",
    );
    renderWithProviders(<SchemaCompareView profiles={MIXED} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-my");
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    chooseListboxOption(boxes()[2], "p-pg");
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
    const sourceTable = await screen.findByLabelText(t("schemaCompareDataSourceTable"));
    chooseListboxOption(sourceTable, "orders");
    fireEvent.click(screen.getByLabelText(t("schemaCompareDataAllRows")));
    fireEvent.click(screen.getByText(t("schemaCompareDataCompare")));
    expect(await screen.findByText(t("schemaCompareCrossErrorTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("schemaCompareCrossErrIntegerKey"))).toBeInTheDocument();
  });
});

/** 基準 1 つ vs 比較先 複数 (最大 4) の比較。 */
describe("SchemaCompareView の複数比較先", () => {
  const THREE = [...PROFILES, makeProfile({ id: "p-c", name: "Gamma" })];
  const diffFor = (status: string) => ({
    source_driver: "mysql",
    target_driver: "mysql",
    tables: [{ name: "users", status, columns: [], foreign_keys: [] }],
  });

  it("比較先ごとに 2 者比較を呼んで表に並べ、マスを押すとその比較先の詳細に切り替える", async () => {
    vi.mocked(api.connect).mockImplementation(
      async (req) => ({ session_id: `s-${req.profile_id}` }) as never,
    );
    vi.mocked(api.compareSchema).mockImplementation(
      async (p) => diffFor(p.targetSessionId === "s-p-b" ? "same" : "different") as never,
    );
    renderWithProviders(<SchemaCompareView profiles={THREE} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-a");
    await waitFor(() => expect(boxes()[1]).toHaveTextContent("db1"));
    chooseListboxOption(boxes()[2], "p-b");
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByRole("button", { name: t("schemaCompareAddTarget", { count: 1, max: 4 }) }));
    chooseListboxOption(boxes()[4], "p-c");
    await waitFor(() => expect(boxes()[5]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));

    const matrix = await screen.findByTestId("schema-compare-matrix");
    expect(api.compareSchema).toHaveBeenCalledTimes(2);
    expect(within(matrix).getByText(t("schemaCompareMatrixDiffCount", { count: 1 }))).toBeInTheDocument();
    expect(within(matrix).getByText(t("schemaCompareMatrixNoDiff"))).toBeInTheDocument();

    // 2 つ目の比較先 (Gamma) のマスを押すと、それが「下に表示中」になる。
    fireEvent.click(
      screen.getByRole("button", { name: `users / Gamma / db1: ${t("schemaCompareOpChange")}` }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Gamma \/ db1/, pressed: true })).toBeInTheDocument(),
    );
  });

  it("マスを押すと、アクティブ列と反映先バッジが移り、詳細一覧の該当行が見える位置へ送られて光る (#2292)", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      vi.mocked(api.connect).mockImplementation(
        async (req) => ({ session_id: `s-${req.profile_id}` }) as never,
      );
      vi.mocked(api.compareSchema).mockImplementation(
        async (p) => diffFor(p.targetSessionId === "s-p-b" ? "same" : "different") as never,
      );
      renderWithProviders(<SchemaCompareView profiles={THREE} onClose={() => {}} />);
      const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
      chooseListboxOption(boxes()[0], "p-a");
      await waitFor(() => expect(boxes()[1]).toHaveTextContent("db1"));
      chooseListboxOption(boxes()[2], "p-b");
      await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
      fireEvent.click(
        screen.getByRole("button", { name: t("schemaCompareAddTarget", { count: 1, max: 4 }) }),
      );
      chooseListboxOption(boxes()[4], "p-c");
      await waitFor(() => expect(boxes()[5]).toHaveTextContent("db1"));
      fireEvent.click(screen.getByText(t("schemaCompareCompare")));
      const matrix = await screen.findByTestId("schema-compare-matrix");

      // 反映先は 1 つ目の比較先 (Beta)。ハイライトとバッジは 1 つずつ。
      // 列見出しのボタンは aria-pressed を持つ (マスのボタンは持たない)。
      const header = (name: RegExp) =>
        within(matrix)
          .getAllByRole("button", { name })
          .find((b) => b.hasAttribute("aria-pressed")) as HTMLElement;
      expect(within(header(/Beta \/ db1/)).getByTestId("matrix-active-col")).toBeInTheDocument();
      expect(screen.getAllByTestId("schema-compare-active-badge")).toHaveLength(1);

      fireEvent.click(
        screen.getByRole("button", { name: `users / Gamma / db1: ${t("schemaCompareOpChange")}` }),
      );
      await waitFor(() =>
        expect(within(header(/Gamma \/ db1/)).getByTestId("matrix-active-col")).toBeInTheDocument(),
      );
      expect(within(header(/Beta \/ db1/)).queryByTestId("matrix-active-col")).toBeNull();
      expect(screen.getAllByTestId("matrix-active-col")).toHaveLength(1);
      expect(screen.getAllByTestId("schema-compare-active-badge")).toHaveLength(1);
      // 後ろの比較先へ移ったので、詳細は右から入る。
      await waitFor(() =>
        expect(screen.getByTestId("schema-compare-detail-pane")).toHaveAttribute("data-slide-dir", "1"),
      );
      // 該当テーブルの行を見える位置へ送り、1 回光らせる (行の状態色 + CSS アニメ)。
      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "nearest" })),
      );
      const row = document.querySelector('[data-table-name="users"]');
      expect(row).toHaveClass("table-diff-flash");
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("比較先を外すとカードが折りたたまれて消える (#2292)", async () => {
    renderWithProviders(<SchemaCompareView profiles={THREE} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: t("schemaCompareAddTarget", { count: 1, max: 4 }) }));
    expect(screen.getAllByTestId("schema-compare-target-card")).toHaveLength(2);
    fireEvent.click(
      screen.getAllByRole("button", { name: t("schemaCompareRemoveTarget") })[0] as HTMLElement,
    );
    await waitFor(() => expect(screen.getAllByTestId("schema-compare-target-card")).toHaveLength(1));
  });

  it("列見出しの内訳ストリップの件数を押すと、その比較先をその状態だけに絞り込み、行にドリフト度が出る", async () => {
    vi.mocked(api.connect).mockImplementation(
      async (req) => ({ session_id: `s-${req.profile_id}` }) as never,
    );
    vi.mocked(api.compareSchema).mockImplementation(
      async () =>
        ({
          source_driver: "mysql",
          target_driver: "mysql",
          tables: [
            { name: "users", status: "different", columns: [], foreign_keys: [] },
            { name: "logs", status: "target_only", columns: [], foreign_keys: [] },
          ],
        }) as never,
    );
    renderWithProviders(<SchemaCompareView profiles={THREE} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-a");
    await waitFor(() => expect(boxes()[1]).toHaveTextContent("db1"));
    chooseListboxOption(boxes()[2], "p-b");
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByRole("button", { name: t("schemaCompareAddTarget", { count: 1, max: 4 }) }));
    chooseListboxOption(boxes()[4], "p-c");
    await waitFor(() => expect(boxes()[5]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));

    const matrix = await screen.findByTestId("schema-compare-matrix");
    expect(within(matrix).getAllByTestId("matrix-drift")[0]).toHaveTextContent("2/2");
    fireEvent.click(
      within(matrix).getByRole("button", {
        name: t("schemaCompareMatrixStripLabel", {
          target: "Gamma / db1",
          status: t("schemaCompareOpDrop"),
          count: 1,
        }),
      }),
    );
    const change = await screen.findByRole("button", {
      name: new RegExp(t("schemaCompareOpChange")),
      pressed: false,
    });
    expect(change).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: new RegExp(t("schemaCompareOpDrop")), pressed: true }),
    ).toBeInTheDocument();
  });

  it("反映先のドライバが違っても、他の比較先は比較してその列だけ失敗にする", async () => {
    const MIXED = [...PROFILES, makeProfile({ id: "p-pg", name: "Pg", driver: "postgres" })];
    vi.mocked(api.connect).mockImplementation(
      async (req) => ({ session_id: `s-${req.profile_id}` }) as never,
    );
    vi.mocked(api.compareSchema).mockImplementation(async () => diffFor("different") as never);
    renderWithProviders(<SchemaCompareView profiles={MIXED} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    chooseListboxOption(boxes()[0], "p-a");
    await waitFor(() => expect(boxes()[1]).toHaveTextContent("db1"));
    chooseListboxOption(boxes()[2], "p-pg");
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByRole("button", { name: t("schemaCompareAddTarget", { count: 1, max: 4 }) }));
    chooseListboxOption(boxes()[4], "p-b");
    await waitFor(() => expect(boxes()[5]).toHaveTextContent("db1"));
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));
    const matrix = await screen.findByTestId("schema-compare-matrix");
    expect(api.compareSchema).toHaveBeenCalledTimes(1);
    expect(within(matrix).getByText(t("schemaCompareMatrixError"))).toBeInTheDocument();
    expect(within(matrix).getByText(t("schemaCompareMatrixDiffCount", { count: 1 }))).toBeInTheDocument();
  });

  it("比較先を外しても、残る比較先の接続中の応答は届く", async () => {
    let resolveC: (v: { session_id: string }) => void = () => {};
    vi.mocked(api.connect).mockImplementation(async (req) => {
      if (req.profile_id === "p-c") {
        return new Promise((r) => {
          resolveC = r as typeof resolveC;
        }) as never;
      }
      return { session_id: `s-${req.profile_id}` } as never;
    });
    renderWithProviders(<SchemaCompareView profiles={THREE} onClose={() => {}} />);
    const boxes = () => screen.getAllByRole("combobox") as HTMLElement[];
    fireEvent.click(screen.getByRole("button", { name: t("schemaCompareAddTarget", { count: 1, max: 4 }) }));
    chooseListboxOption(boxes()[4], "p-c");
    await waitFor(() => expect(api.connect).toHaveBeenCalled());
    // 1 つ目の比較先を外すと、接続中の比較先 (p-c) が 1 番目に繰り上がる。
    fireEvent.click(
      screen.getAllByRole("button", { name: t("schemaCompareRemoveTarget") })[0] as HTMLElement,
    );
    resolveC({ session_id: "s-p-c" });
    await waitFor(() => expect(boxes()[3]).toHaveTextContent("db1"));
  });

  it("比較先は 4 つまでしか追加できない", () => {
    renderWithProviders(<SchemaCompareView profiles={THREE} onClose={() => {}} />);
    for (let n = 1; n < 4; n++) {
      fireEvent.click(
        screen.getByRole("button", { name: t("schemaCompareAddTarget", { count: n, max: 4 }) }),
      );
    }
    expect(
      screen.getByRole("button", { name: t("schemaCompareAddTarget", { count: 4, max: 4 }) }),
    ).toBeDisabled();
  });
});
