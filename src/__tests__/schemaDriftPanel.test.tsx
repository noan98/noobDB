import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import { makeProfile } from "./fixtures/componentFixtures";
import type { SchemaDriftGeneration } from "../api/tauri";

/**
 * スキーマドリフト・タイムライン (#736) の失敗表示統一 (#848)。2 世代間の
 * 差分計算 (`api.schemaDriftCompare`) が失敗した場合、裸の赤テキストではなく
 * compact な共有 `EmptyState` (タイトル + 再試行ボタン) で表示され、ボタンで
 * 再度呼ばれることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      schemaDriftCompare: vi.fn(),
    },
  };
});

import { SchemaDriftPanel } from "../components/SchemaDriftPanel";
import { api } from "../api/tauri";

function makeGeneration(id: string, capturedAt: string): SchemaDriftGeneration {
  return {
    id,
    capturedAt,
    driver: "mysql",
    database: "appdb",
    fingerprint: `fp-${id}`,
    tableCount: 1,
    omitted: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SchemaDriftPanel error state (#848)", () => {
  it("shows the shared EmptyState title on compare failure, and retries on click", async () => {
    vi.mocked(api.schemaDriftCompare).mockRejectedValueOnce(new Error("request failed"));

    const generations = [
      makeGeneration("g2", "2026-01-02T00:00:00Z"),
      makeGeneration("g1", "2026-01-01T00:00:00Z"),
    ];

    renderWithProviders(
      <SchemaDriftPanel
        profile={makeProfile()}
        generations={generations}
        canCapture={false}
        capturing={false}
        onCapture={() => {}}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Error: request failed")).toBeInTheDocument();
    });
    expect(api.schemaDriftCompare).toHaveBeenCalledTimes(1);

    vi.mocked(api.schemaDriftCompare).mockResolvedValueOnce({ tables: [] });
    fireEvent.click(screen.getByRole("button", { name: t("schemaDriftRetry") }));

    await waitFor(() => {
      expect(api.schemaDriftCompare).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(t("schemaDriftNoChanges"))).toBeInTheDocument();
    });
  });
});

describe("SchemaDriftPanel 構造/データへの導線と DDL の紐づけ (#1537)", () => {
  const generations = () => [
    { ...makeGeneration("g2", "2026-01-02T00:00:00Z"), triggerSql: "ALTER TABLE users ADD COLUMN age INT" },
    makeGeneration("g1", "2026-01-01T00:00:00Z"),
  ];
  const summary = {
    tables: [
      {
        table: "users",
        tableStatus: "changed" as const,
        columnsAdded: 1,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded: 0,
        indexesRemoved: 0,
        indexesChanged: 0,
      },
      {
        table: "legacy",
        tableStatus: "removed" as const,
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded: 0,
        indexesRemoved: 0,
        indexesChanged: 0,
      },
    ],
  };

  it("変化したテーブルから構造/データを開き、パネルを閉じる。削除済みテーブルには出さない", async () => {
    vi.mocked(api.schemaDriftCompare).mockResolvedValue(summary);
    const onOpenStructure = vi.fn();
    const onOpenData = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <SchemaDriftPanel
        profile={makeProfile()}
        generations={generations()}
        canCapture={false}
        capturing={false}
        onCapture={() => {}}
        onClose={onClose}
        onOpenStructure={onOpenStructure}
        onOpenData={onOpenData}
      />,
    );
    const structureBtn = await screen.findByRole("button", {
      name: t("schemaDriftOpenStructureAria", { table: "users" }),
    });
    fireEvent.click(structureBtn);
    expect(onOpenStructure).toHaveBeenCalledWith("appdb", "users");
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("schemaDriftOpenDataAria", { table: "users" }) }));
    expect(onOpenData).toHaveBeenCalledWith("appdb", "users");

    // 削除されたテーブルは開けない。
    expect(
      screen.queryByRole("button", { name: t("schemaDriftOpenStructureAria", { table: "legacy" }) }),
    ).not.toBeInTheDocument();
  });

  it("導線のコールバックが無ければボタンを出さず、DDL の SQL が世代に表示される", async () => {
    vi.mocked(api.schemaDriftCompare).mockResolvedValue(summary);
    renderWithProviders(
      <SchemaDriftPanel
        profile={makeProfile()}
        generations={generations()}
        canCapture={false}
        capturing={false}
        onCapture={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: t("schemaDriftOpenStructureAria", { table: "users" }) }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(t("schemaDriftTriggerSql", { sql: "ALTER TABLE users ADD COLUMN age INT" })),
    ).toBeInTheDocument();
  });

  it("対象 (DB / スキーマ) が異なる世代は比較せず、理由を表示する", async () => {
    vi.mocked(api.schemaDriftCompare).mockClear();
    renderWithProviders(
      <SchemaDriftPanel
        profile={makeProfile()}
        generations={[
          { ...makeGeneration("g2", "2026-01-02T00:00:00Z"), database: "public" },
          { ...makeGeneration("g1", "2026-01-01T00:00:00Z"), database: "appdb" },
        ]}
        canCapture={false}
        capturing={false}
        onCapture={() => {}}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(t("schemaDriftDifferentTarget"))).toBeInTheDocument();
    expect(api.schemaDriftCompare).not.toHaveBeenCalled();
  });
});

describe("SchemaDriftPanel タイムラインの操作 (#1612)", () => {
  const gens = () => [
    makeGeneration("g3", "2026-01-03T00:00:00Z"),
    makeGeneration("g2", "2026-01-02T00:00:00Z"),
    makeGeneration("g1", "2026-01-01T00:00:00Z"),
  ];

  it("行のクリックで比較先、Shift+クリックで比較元を設定する", async () => {
    vi.mocked(api.schemaDriftCompare).mockResolvedValue({ tables: [] });
    const profile = makeProfile();
    const { container } = renderWithProviders(
      <SchemaDriftPanel
        profile={profile}
        generations={gens()}
        canCapture={false}
        capturing={false}
        onCapture={() => {}}
        onClose={() => {}}
      />,
    );
    // 既定: 比較元 = g2、比較先 = g3 (最新)。
    await waitFor(() => expect(api.schemaDriftCompare).toHaveBeenCalledWith(profile.id, "g2", "g3"));
    const items = () =>
      Array.from(container.ownerDocument.querySelectorAll<HTMLElement>("[data-generation-item]"));
    expect(items()).toHaveLength(3);

    fireEvent.click(items()[2]);
    await waitFor(() => expect(api.schemaDriftCompare).toHaveBeenCalledWith(profile.id, "g2", "g1"));

    fireEvent.click(items()[0], { shiftKey: true });
    await waitFor(() => expect(api.schemaDriftCompare).toHaveBeenCalledWith(profile.id, "g3", "g1"));
  });
});
