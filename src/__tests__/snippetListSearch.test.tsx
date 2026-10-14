import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { t } from "../i18n";
import type { Snippet } from "../api/tauri";
import { SnippetList } from "../components/SnippetList";

const snippet = (over: Partial<Snippet>): Snippet => ({
  id: "s1",
  name: "snippet",
  folder: null,
  tags: [],
  sql: "SELECT 1",
  driver: null,
  scope: { kind: "any" },
  ...over,
});

const SNIPPETS: Snippet[] = [
  snippet({ id: "a", name: "report query", folder: "reports", sql: "SELECT 1" }),
  snippet({ id: "b", name: "cleanup job", folder: "ops", sql: "DELETE FROM t" }),
];

beforeEach(() => {
  // 全フォルダを閉じた状態から始める。
  localStorage.setItem("noobdb.snippetlist.collapsedFolders", JSON.stringify(["reports", "ops"]));
});

describe("SnippetList 検索中のフォルダ展開 (#1534)", () => {
  it("閉じたフォルダの中の一致は、検索中だけ強制的に開いて見せる", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SnippetList
        snippets={SNIPPETS}
        activeProfile={null}
        onInsert={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const folder = screen.getByRole("treeitem", { name: /reports/ });
    expect(folder).toHaveAttribute("aria-expanded", "false");

    await user.type(screen.getByPlaceholderText(t("snippetSearchPlaceholder")), "report");
    expect(screen.getByRole("treeitem", { name: /reports/ })).toHaveAttribute("aria-expanded", "true");

    // 検索中は見出しを押しても閉じない (保存状態も変わらない)。
    await user.click(screen.getByRole("treeitem", { name: /reports/ }));
    expect(screen.getByRole("treeitem", { name: /reports/ })).toHaveAttribute("aria-expanded", "true");

    // 検索を消せば、保存している開閉状態 (閉じている) に戻る。
    await user.clear(screen.getByPlaceholderText(t("snippetSearchPlaceholder")));
    expect(screen.getByRole("treeitem", { name: /reports/ })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("SnippetList 行アクション (#1595)", () => {
  function setup() {
    const fns = { onInsert: vi.fn(), onRun: vi.fn(), onToggleFavorite: vi.fn() };
    renderWithProviders(
      <SnippetList
        snippets={[snippet({ id: "a", name: "report query", folder: null })]}
        activeProfile={null}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        favoriteIds={[]}
        {...fns}
      />,
    );
    return fns;
  }

  it("▶ をダブルクリックしても実行は 1 回だけで、挿入も走らない", async () => {
    const fns = setup();
    // 操作ボタンは行のホバー / フォーカスまで pointer-events: none なので、直接 click を 2 回送る。
    const run = screen.getByRole("button", { name: t("snippetMenuRun") });
    fireEvent.click(run, { detail: 1 });
    fireEvent.click(run, { detail: 2 });
    fireEvent.doubleClick(run);
    expect(fns.onRun).toHaveBeenCalledTimes(1);
    expect(fns.onInsert).not.toHaveBeenCalled();
  });

  it("▶ / ★ にフォーカスして Enter を押すと挿入ではなくそのボタンが働く", async () => {
    const user = userEvent.setup();
    const fns = setup();
    screen.getByRole("button", { name: t("snippetMenuRun") }).focus();
    await user.keyboard("{Enter}");
    expect(fns.onRun).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: t("snippetMenuFavorite") }).focus();
    await user.keyboard("{Enter}");
    expect(fns.onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(fns.onInsert).not.toHaveBeenCalled();
  });

  it("行自身で Enter を押せば挿入される", async () => {
    const user = userEvent.setup();
    const fns = setup();
    screen.getByRole("treeitem", { name: /report query/ }).focus();
    await user.keyboard("{Enter}");
    expect(fns.onInsert).toHaveBeenCalledTimes(1);
  });
});
