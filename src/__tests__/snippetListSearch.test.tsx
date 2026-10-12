import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
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
      <SnippetList snippets={SNIPPETS} activeProfile={null} onInsert={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );
    const folder = screen.getByRole("treeitem", { name: /reports/ });
    expect(folder).toHaveAttribute("aria-expanded", "false");

    await user.type(screen.getByPlaceholderText(t("snippetSearchPlaceholder")), "report");
    expect(screen.getByRole("treeitem", { name: /reports/ })).toHaveAttribute("aria-expanded", "true");

    // 検索を消せば、保存している開閉状態 (閉じている) に戻る。
    await user.clear(screen.getByPlaceholderText(t("snippetSearchPlaceholder")));
    expect(screen.getByRole("treeitem", { name: /reports/ })).toHaveAttribute("aria-expanded", "false");
  });
});
