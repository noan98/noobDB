import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { Snippet } from "../api/tauri";

/**
 * スニペット一覧のエクスポート / インポート (#1490) の画面配線。IPC (`api`) とファイル
 * ダイアログはモックし、メニュー → ダイアログ → 確定の流れだけを固定する (衝突解決の規則
 * そのものは Rust 側の単体テストが固定している)。
 */
const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: () => Promise.resolve("/dl"),
  join: (...p: string[]) => Promise.resolve(p.join("/")),
}));
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      exportSnippets: vi.fn(),
      previewImportSnippets: vi.fn(),
      importSnippets: vi.fn(),
      writeTextFile: vi.fn(),
      readTextFile: vi.fn(),
    },
  };
});

import { SnippetList } from "../components/SnippetList";
import { api } from "../api/tauri";

const snip: Snippet = {
  id: "a",
  name: "report",
  folder: null,
  tags: [],
  sql: "SELECT 1",
  driver: null,
  scope: { kind: "any" },
};

function renderList(snippets: Snippet[], onChanged = vi.fn()) {
  renderWithProviders(
    <SnippetList
      snippets={snippets}
      activeProfile={null}
      onInsert={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onChanged={onChanged}
    />,
  );
  return onChanged;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, item: string) {
  await user.click(screen.getByRole("button", { name: t("snippetTransferMenu") }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SnippetList エクスポート / インポート (#1490)", () => {
  it("エクスポートは保存ダイアログで選んだパスへ全件の JSON を書く", async () => {
    const user = userEvent.setup();
    mocks.save.mockResolvedValue("/out/snippets.json");
    vi.mocked(api.exportSnippets).mockResolvedValue('{"snippets":[]}');
    vi.mocked(api.writeTextFile).mockResolvedValue(undefined as never);
    renderList([snip]);
    await openMenu(user, t("snippetExport"));
    await waitFor(() =>
      expect(api.writeTextFile).toHaveBeenCalledWith("/out/snippets.json", '{"snippets":[]}'),
    );
    expect(api.exportSnippets).toHaveBeenCalledWith(null);
  });

  it("スニペットが無いときはエクスポートせずダイアログも開かない", async () => {
    const user = userEvent.setup();
    renderList([]);
    await openMenu(user, t("snippetExport"));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(api.exportSnippets).not.toHaveBeenCalled();
  });

  it("インポートはプレビューを出し、選んだ戦略で確定して一覧を取得し直す", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue("/in/snippets.json");
    vi.mocked(api.readTextFile).mockResolvedValue("{json}" as never);
    vi.mocked(api.previewImportSnippets).mockResolvedValue({
      total: 3,
      new_count: 2,
      conflict_count: 1,
      scope_reset_count: 1,
      rejected: [],
    });
    vi.mocked(api.importSnippets).mockResolvedValue({
      imported: 2,
      skipped: 0,
      overwritten: 1,
      scope_reset: 1,
      rejected: [],
    });
    const onChanged = renderList([snip]);
    await openMenu(user, t("snippetImport"));
    expect(
      await screen.findByText(t("snippetImportSummary", { total: 3, fresh: 2, conflicts: 1 })),
    ).toBeInTheDocument();
    expect(screen.getByText(t("snippetImportScopeReset", { count: 1 }))).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: new RegExp(t("snippetImportOverwrite")) }));
    await user.click(screen.getByRole("button", { name: t("snippetImportConfirm") }));
    await waitFor(() => expect(api.importSnippets).toHaveBeenCalledWith("{json}", "overwrite"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("取り込めるものが無いときは確定できない", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue("/in/empty.json");
    vi.mocked(api.readTextFile).mockResolvedValue("[]" as never);
    vi.mocked(api.previewImportSnippets).mockResolvedValue({
      total: 0,
      new_count: 0,
      conflict_count: 0,
      scope_reset_count: 0,
      rejected: [],
    });
    renderList([snip]);
    await openMenu(user, t("snippetImport"));
    expect(await screen.findByText(t("snippetImportNothing"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("snippetImportConfirm") })).toBeDisabled();
  });
});
