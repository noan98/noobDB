import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listDatabases: vi.fn().mockResolvedValue(["appdb"]),
      describeDatabase: vi.fn().mockResolvedValue([
        { name: "customers", columns: [{ name: "id", data_type: "int", nullable: false, key: "PRI" }] },
        { name: "orders", columns: [{ name: "id", data_type: "int", nullable: false, key: "PRI" }] },
      ]),
      foreignKeys: vi.fn().mockResolvedValue([]),
    },
  };
});

import { ERDiagramView } from "../components/ERDiagramView";

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom には ResizeObserver が無い (React Flow が使う)。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function ui(onGenerateDoc?: (db: string, tables: string[]) => void) {
  return (
    <ERDiagramView
      sessionId="s1"
      driver="mysql"
      initialDatabase="appdb"
      onOpenTable={() => {}}
      onGenerateDoc={onGenerateDoc}
      onClose={() => {}}
    />
  );
}

describe("ER 図の AI ドキュメント生成ボタン (#696)", () => {
  it("onGenerateDoc 未指定ならボタンを出さない", async () => {
    renderWithProviders(ui());
    await screen.findByText(t("erDiagramSummary", { tables: 2, relationships: 0 }));
    expect(screen.queryByRole("button", { name: t("erDiagramAiDoc") })).toBeNull();
  });

  it("押すと DB 名と、選択中ノードのテーブル名を渡す", async () => {
    const onGenerateDoc = vi.fn();
    const { container } = renderWithProviders(ui(onGenerateDoc));
    const btn = await screen.findByRole("button", { name: t("erDiagramAiDoc") });
    // 選択なし → 空配列 (= モーダル側は DB 全体が初期値)。
    fireEvent.click(btn);
    expect(onGenerateDoc).toHaveBeenLastCalledWith("appdb", []);
    // React Flow のノードをクリックして選択する。
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    const orders = Array.from(container.querySelectorAll<HTMLElement>(".react-flow__node")).find((n) =>
      n.textContent?.includes("orders"),
    );
    expect(orders).toBeTruthy();
    fireEvent.click(orders as HTMLElement);
    await waitFor(() => {
      fireEvent.click(btn);
      expect(onGenerateDoc).toHaveBeenLastCalledWith("appdb", ["orders"]);
    });
  });
});
