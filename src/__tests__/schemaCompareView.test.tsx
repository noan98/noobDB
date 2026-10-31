import { configure, getConfig } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
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
    const [sourceProfile] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(sourceProfile, { target: { value: "p-a" } });
    await waitFor(() => expect(api.connect).toHaveBeenCalled());
    fireEvent.change(sourceProfile, { target: { value: "" } });
    resolveConnect({ session_id: "s-a" });
    await new Promise((r) => setTimeout(r, 50));
    expect(sourceProfile.value).toBe("");
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
    const boxes = () => screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(boxes()[0], { target: { value: "p-a" } });
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    fireEvent.change(boxes()[2], { target: { value: "p-b" } });
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[1].value).toBe("db1"));
    await waitFor(() => expect(boxes()[3].value).toBe("db1"));
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
    const boxes = () => screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(boxes()[0], { target: { value: "p-a" } });
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    fireEvent.change(boxes()[2], { target: { value: "p-b" } });
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[3].value).toBe("db1"));
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));
    const sourceTable = (await screen.findByLabelText(
      t("schemaCompareDataSourceTable"),
    )) as HTMLSelectElement;
    const targetTable = screen.getByLabelText(t("schemaCompareDataTargetTable")) as HTMLSelectElement;
    fireEvent.change(sourceTable, { target: { value: "orders" } });
    fireEvent.change(targetTable, { target: { value: "orders_archive" } });
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
    const boxes = () => screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(boxes()[0], { target: { value: "p-a" } });
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    fireEvent.change(boxes()[2], { target: { value: "p-b" } });
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[3].value).toBe("db1"));
    fireEvent.click(screen.getByText(t("schemaCompareCompare")));
    const sourceTable = (await screen.findByLabelText(
      t("schemaCompareDataSourceTable"),
    )) as HTMLSelectElement;
    const targetTable = screen.getByLabelText(t("schemaCompareDataTargetTable")) as HTMLSelectElement;
    fireEvent.change(sourceTable, { target: { value: "orders" } });
    expect(await screen.findByText(t("schemaCompareDataSameTable"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("schemaCompareDataCompare") })).toBeDisabled();
    fireEvent.change(targetTable, { target: { value: "orders_archive" } });
    await waitFor(() => expect(screen.queryByText(t("schemaCompareDataSameTable"))).toBeNull());
    expect(screen.getByRole("button", { name: t("schemaCompareDataCompare") })).not.toBeDisabled();
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
    const boxes = () => screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(boxes()[0], { target: { value: "p-my" } });
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    fireEvent.change(boxes()[2], { target: { value: "p-pg" } });
    await waitFor(() => expect(boxes()[3]).not.toBeDisabled());
    await waitFor(() => expect(boxes()[3].value).toBe("db1"));

    // スキーマ比較は同一ドライバ必須のまま。
    expect(screen.getByRole("button", { name: t("schemaCompareCompare") })).toBeDisabled();
    expect(screen.getByText(t("schemaCompareDriverMismatch"))).toBeInTheDocument();
    // 検証専用の案内が出る。
    expect(await screen.findByText(t("schemaCompareCrossTitle"))).toBeInTheDocument();

    const sourceTable = (await screen.findByLabelText(
      t("schemaCompareDataSourceTable"),
    )) as HTMLSelectElement;
    fireEvent.change(sourceTable, { target: { value: "orders" } });
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
    const boxes = () => screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(boxes()[0], { target: { value: "p-my" } });
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    fireEvent.change(boxes()[2], { target: { value: "p-pg" } });
    await waitFor(() => expect(boxes()[3].value).toBe("db1"));
    const sourceTable = (await screen.findByLabelText(
      t("schemaCompareDataSourceTable"),
    )) as HTMLSelectElement;
    fireEvent.change(sourceTable, { target: { value: "orders" } });
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
    const boxes = () => screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(boxes()[0], { target: { value: "p-my" } });
    await waitFor(() => expect(boxes()[1]).not.toBeDisabled());
    fireEvent.change(boxes()[2], { target: { value: "p-pg" } });
    await waitFor(() => expect(boxes()[3].value).toBe("db1"));
    const sourceTable = (await screen.findByLabelText(
      t("schemaCompareDataSourceTable"),
    )) as HTMLSelectElement;
    fireEvent.change(sourceTable, { target: { value: "orders" } });
    fireEvent.click(screen.getByLabelText(t("schemaCompareDataAllRows")));
    fireEvent.click(screen.getByText(t("schemaCompareDataCompare")));
    expect(await screen.findByText(t("schemaCompareCrossErrorTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("schemaCompareCrossErrIntegerKey"))).toBeInTheDocument();
  });
});
