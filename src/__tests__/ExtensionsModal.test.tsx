import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { setLocale, t } from "../i18n";

// PostgreSQL の拡張機能ダイアログ (#2160)。

const OVERVIEW = {
  extensions: [
    {
      name: "pg_trgm",
      installed_version: "1.5",
      default_version: "1.6",
      schema: "public",
      comment: "trigram matching",
      updatable: true,
    },
    {
      name: "plpgsql",
      installed_version: "1.0",
      default_version: "1.0",
      schema: "pg_catalog",
      comment: "PL/pgSQL",
      updatable: false,
    },
    {
      name: "pg_stat_statements",
      installed_version: null,
      default_version: "1.10",
      schema: null,
      comment: "track planning and execution statistics",
      updatable: false,
    },
  ],
  shared_preload_libraries: [] as string[],
};

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, listExtensions: () => Promise.resolve(OVERVIEW) },
  };
});

import { ExtensionsModal } from "../components/ExtensionsModal";

function setup(over: { readOnly?: boolean; onExecute?: () => Promise<void | "cancelled"> } = {}) {
  const onExecute = vi.fn(over.onExecute ?? (() => Promise.resolve()));
  renderWithProviders(
    <ExtensionsModal
      sessionId="s1"
      readOnly={over.readOnly ?? false}
      onExecute={onExecute}
      onClose={() => {}}
    />,
  );
  return { onExecute };
}

describe("ExtensionsModal", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
  });

  it("導入済みと未導入を並べ、更新できるものに印を付ける。plpgsql は削除できない", async () => {
    setup();
    await screen.findByText("pg_trgm");
    expect(screen.getByText("1.5 → 1.6 · public")).toBeInTheDocument();
    expect(screen.getByText(t("extensionsUpdatable"))).toBeInTheDocument();
    // 削除ボタンは pg_trgm の 1 つだけ (plpgsql は出ない)。
    expect(screen.getAllByRole("button", { name: t("extensionsDrop") })).toHaveLength(1);
    // pg_stat_statements は事前読み込みの注記が出る。
    expect(screen.getByText(t("extensionsPreloadRowNote"))).toBeInTheDocument();
  });

  it("導入: SQL をプレビューして実行する", async () => {
    const user = userEvent.setup();
    const { onExecute } = setup();
    await screen.findByText("pg_stat_statements");
    await user.click(screen.getByRole("button", { name: t("extensionsInstall") }));
    expect(screen.getByText('CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";')).toBeInTheDocument();
    expect(screen.getByText(t("extensionsPreloadNote", { name: "pg_stat_statements" }))).toBeInTheDocument();
    await user.type(screen.getByLabelText(t("extensionsSchema")), "ext");
    expect(
      screen.getByText('CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" SCHEMA "ext";'),
    ).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: t("extensionsInstall") }).at(-1) as HTMLElement);
    expect(onExecute).toHaveBeenCalledWith(
      'CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" SCHEMA "ext"',
      "install",
      "pg_stat_statements",
    );
    // 実行後は一覧に戻る。
    await screen.findByPlaceholderText(t("extensionsSearchPlaceholder"));
  });

  it("更新は ALTER EXTENSION ... UPDATE TO 既定のバージョン", async () => {
    const user = userEvent.setup();
    const { onExecute } = setup();
    await screen.findByText("pg_trgm");
    await user.click(screen.getByRole("button", { name: t("extensionsUpdate") }));
    expect(screen.getByText("ALTER EXTENSION \"pg_trgm\" UPDATE TO '1.6';")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: t("extensionsUpdate") }).at(-1) as HTMLElement);
    expect(onExecute).toHaveBeenCalledWith(
      "ALTER EXTENSION \"pg_trgm\" UPDATE TO '1.6'",
      "update",
      "pg_trgm",
    );
  });

  it("削除は破壊的な配置 (実行が左、キャンセルが右) で、CASCADE を付けると警告が変わる", async () => {
    const user = userEvent.setup();
    const { onExecute } = setup();
    await screen.findByText("pg_trgm");
    await user.click(screen.getByRole("button", { name: t("extensionsDrop") }));
    expect(screen.getByText(t("extensionsDropWarning"))).toBeInTheDocument();
    await user.click(screen.getByLabelText(t("extensionsCascadeDrop")));
    expect(screen.getByText('DROP EXTENSION "pg_trgm" CASCADE;')).toBeInTheDocument();
    expect(screen.getByText(t("extensionsDropCascadeWarning"))).toBeInTheDocument();
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons.indexOf(t("extensionsDrop"))).toBeLessThan(buttons.indexOf(t("extensionsCancel")));
    await user.click(screen.getAllByRole("button", { name: t("extensionsDrop") }).at(-1) as HTMLElement);
    expect(onExecute).toHaveBeenCalledWith('DROP EXTENSION "pg_trgm" CASCADE', "drop", "pg_trgm");
  });

  it("削除の確認画面ではキャンセルにフォーカスが移り、Cmd/Ctrl+Enter では実行しない", async () => {
    const user = userEvent.setup();
    const { onExecute } = setup();
    await screen.findByText("pg_trgm");
    await user.click(screen.getByRole("button", { name: t("extensionsDrop") }));
    expect(screen.getByRole("button", { name: t("extensionsCancel") })).toHaveFocus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("実行前の確認がキャンセルされたら「実行していない」ことを示し、手順は閉じない (#2176)", async () => {
    const user = userEvent.setup();
    const { onExecute } = setup({ onExecute: () => Promise.resolve("cancelled") });
    await screen.findByText("pg_trgm");
    await user.click(screen.getByRole("button", { name: t("extensionsDrop") }));
    await user.click(screen.getAllByRole("button", { name: t("extensionsDrop") }).at(-1) as HTMLElement);
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(t("extensionsNotExecuted"))).toBeInTheDocument();
    expect(screen.getByText('DROP EXTENSION "pg_trgm";')).toBeInTheDocument();
  });

  it("実行に失敗したら理由と権限不足のヒントを出し、手順は閉じない", async () => {
    const user = userEvent.setup();
    setup({
      onExecute: () =>
        Promise.reject(new Error('permission denied to create extension "pg_stat_statements"')),
    });
    await screen.findByText("pg_stat_statements");
    await user.click(screen.getByRole("button", { name: t("extensionsInstall") }));
    await user.click(screen.getAllByRole("button", { name: t("extensionsInstall") }).at(-1) as HTMLElement);
    await screen.findByText(/permission denied to create extension/);
    expect(screen.getByText(t("errorHintInsufficientPrivilege"))).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: t("extensionsCancel") })).toBeEnabled());
  });

  it("read_only では警告を出し、導入・更新・削除のボタンが押せない", async () => {
    setup({ readOnly: true });
    await screen.findByText("pg_trgm");
    expect(screen.getByText(t("extensionsReadOnly"))).toBeInTheDocument();
    for (const name of [t("extensionsInstall"), t("extensionsUpdate"), t("extensionsDrop")]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });
});
