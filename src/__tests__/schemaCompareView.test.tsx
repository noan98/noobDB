import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { SchemaCompareView } from "../components/SchemaCompareView";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import { api } from "../api/tauri";

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
const PROFILES = [
  makeProfile({ id: "p-a", name: "Alpha" }),
  makeProfile({ id: "p-b", name: "Beta" }),
];

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
    expect(
      await screen.findByText(t("schemaCompareApplyDone", { count: 1 })),
    ).toBeInTheDocument();
    expect(api.compareSchema).toHaveBeenCalledTimes(2);
    // 一瞬映るだけでなく、再比較が落ち着いた後も残る。
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText(t("schemaCompareApplyDone", { count: 1 }))).toBeInTheDocument();
  });
});
