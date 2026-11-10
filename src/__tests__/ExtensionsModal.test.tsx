import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { MotionConfig } from "motion/react";
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

const dependentsMock = vi.hoisted(() => vi.fn());
const overviewMock = vi.hoisted(() => vi.fn());

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listExtensions: () => overviewMock(),
      listExtensionDependents: (...a: unknown[]) => dependentsMock(...a),
    },
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
    dependentsMock.mockResolvedValue([]);
    overviewMock.mockResolvedValue(OVERVIEW);
  });

  it("読み込み中は行の形のスケルトンを出す (素のスピナーだけにしない)", async () => {
    overviewMock.mockReturnValue(new Promise(() => {}));
    setup();
    expect((await screen.findAllByTestId("search-skeleton-row")).length).toBeGreaterThan(0);
  });

  it("絞り込みで 0 件のときは「条件を解除」を出し、押すと一覧が戻る。本当に 0 件なら出さない", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("pg_trgm");
    await user.type(screen.getByPlaceholderText(t("extensionsSearchPlaceholder")), "zzz");
    expect(await screen.findByText(t("extensionsEmpty"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("extensionsClearFilters") }));
    expect(await screen.findByText("pg_trgm")).toBeInTheDocument();
    expect(screen.queryByText(t("extensionsEmpty"))).not.toBeInTheDocument();
  });

  it("拡張機能がそもそも無いときは、条件解除ではなく別の文言を出す", async () => {
    overviewMock.mockResolvedValue({ extensions: [], shared_preload_libraries: [] });
    setup();
    expect(await screen.findByText(t("extensionsNone"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("extensionsClearFilters") })).not.toBeInTheDocument();
  });

  it("reduced-motion でも、確認画面への切替と、戻ったときのフォーカス復帰が通る", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MotionConfig reducedMotion="always">
        <ExtensionsModal sessionId="s1" readOnly={false} onExecute={vi.fn()} onClose={() => {}} />
      </MotionConfig>,
    );
    await screen.findByText("pg_trgm");
    await user.click(screen.getByRole("button", { name: t("extensionsUpdate") }));
    expect(await screen.findByTestId("sql-preview")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("extensionsCancel") }));
    const back = await screen.findByRole("button", { name: t("extensionsUpdate") });
    await waitFor(() => expect(back).toHaveFocus());
  });

  it("確認から戻ると、操作を始めた行のボタンへフォーカスが戻る", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("pg_trgm");
    await user.click(screen.getByRole("button", { name: t("extensionsUpdate") }));
    await user.click(screen.getByRole("button", { name: t("extensionsCancel") }));
    const back = await screen.findByRole("button", { name: t("extensionsUpdate") });
    await waitFor(() => expect(back).toHaveFocus());
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
    // 確認画面は一覧の退場を待ってから入る。
    expect(await screen.findByTestId("sql-preview")).toHaveTextContent(
      'CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";',
    );
    expect(screen.getByText(t("extensionsPreloadNote", { name: "pg_stat_statements" }))).toBeInTheDocument();
    await user.type(screen.getByLabelText(t("extensionsSchema")), "ext");
    expect(screen.getByTestId("sql-preview")).toHaveTextContent(
      'CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" SCHEMA "ext";',
    );
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
    expect(await screen.findByTestId("sql-preview")).toHaveTextContent(
      "ALTER EXTENSION \"pg_trgm\" UPDATE TO '1.6';",
    );
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
    expect(await screen.findByText(t("extensionsDropWarning"))).toBeInTheDocument();
    await user.click(screen.getByLabelText(t("extensionsCascadeDrop")));
    expect(screen.getByTestId("sql-preview")).toHaveTextContent('DROP EXTENSION "pg_trgm" CASCADE;');
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
    expect(screen.getByTestId("sql-preview")).toHaveTextContent('DROP EXTENSION "pg_trgm";');
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

  describe("削除の確認で依存オブジェクトを出す (#2177)", () => {
    const DEPS = [
      { kind: "column", schema: "public", name: "geom", table: "places" },
      { kind: "column", schema: "public", name: "loc", table: "shops" },
      { kind: "function", schema: "public", name: "near(geometry)", table: null },
      { kind: "view", schema: "public", name: "v_places", table: null },
    ];

    async function openDrop() {
      const user = userEvent.setup();
      const out = setup();
      await screen.findByText("pg_trgm");
      await user.click(screen.getByRole("button", { name: t("extensionsDrop") }));
      return { user, ...out };
    }

    it("拡張機能の名前で取得し、CASCADE を付けると種別ごとの件数見出しを出す。列が先頭で最初から開く", async () => {
      dependentsMock.mockResolvedValue(DEPS);
      const { user } = await openDrop();
      expect(dependentsMock).toHaveBeenCalledWith("s1", "pg_trgm");
      await screen.findByText(t("extensionsDepsWillFail", { count: 4 }));
      await user.click(screen.getByLabelText(t("extensionsCascadeDrop")));
      expect(screen.getByText(t("extensionsDepsCascadeTitle", { count: 4 }))).toBeInTheDocument();
      const headings = screen
        .getAllByRole("button")
        .filter((b) => b.hasAttribute("aria-expanded"))
        .map((b) => b.textContent);
      expect(headings[0]).toContain(`${t("extensionsDepsKind_column")} (2)`);
      expect(headings[1]).toContain(`${t("extensionsDepsKind_view")} (1)`);
      expect(headings[2]).toContain(`${t("extensionsDepsKind_function")} (1)`);
      // 列は開いていて、表と列が見える。関数は閉じている。
      expect(screen.getByText("public.places.geom")).toBeInTheDocument();
      expect(screen.queryByText("public.near(geometry)")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: new RegExp(t("extensionsDepsKind_function")) }));
      expect(await screen.findByText("public.near(geometry)")).toBeInTheDocument();
    });

    it("CASCADE なしで依存があれば「このままでは失敗します」を実行前に出す", async () => {
      dependentsMock.mockResolvedValue(DEPS);
      await openDrop();
      expect(await screen.findByText(t("extensionsDepsWillFail", { count: 4 }))).toBeInTheDocument();
    });

    it("依存が 0 件なら「依存するオブジェクトはありません」", async () => {
      await openDrop();
      expect(await screen.findByText(t("extensionsDepsNone"))).toBeInTheDocument();
    });

    it("取得に失敗したらエラーを出すが、削除は実行できる", async () => {
      dependentsMock.mockRejectedValue(new Error("boom"));
      const { user, onExecute } = await openDrop();
      expect(await screen.findByText(/boom/)).toBeInTheDocument();
      await user.click(screen.getAllByRole("button", { name: t("extensionsDrop") }).at(-1) as HTMLElement);
      expect(onExecute).toHaveBeenCalledWith('DROP EXTENSION "pg_trgm"', "drop", "pg_trgm");
    });

    it("確認を開き直したとき、前の取得の遅い応答は捨てる", async () => {
      let resolveFirst: (v: typeof DEPS) => void = () => {};
      dependentsMock.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r;
          }),
      );
      const { user } = await openDrop();
      await user.click(screen.getByRole("button", { name: t("extensionsCancel") }));
      await user.click(screen.getByRole("button", { name: t("extensionsDrop") }));
      expect(await screen.findByText(t("extensionsDepsNone"))).toBeInTheDocument();
      resolveFirst(DEPS);
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByText(t("extensionsDepsNone"))).toBeInTheDocument();
      expect(screen.queryByText(t("extensionsDepsWillFail", { count: 4 }))).not.toBeInTheDocument();
    });

    it("CASCADE なしで依存があるときは、危険帯を 1 つにまとめる", async () => {
      dependentsMock.mockResolvedValue(DEPS);
      await openDrop();
      await screen.findByText(t("extensionsDepsWillFail", { count: 4 }));
      expect(screen.queryByText(t("extensionsDropWarning"))).not.toBeInTheDocument();
    });

    it("導入・更新では依存を取得しない", async () => {
      const user = userEvent.setup();
      setup();
      await screen.findByText("pg_trgm");
      await user.click(screen.getByRole("button", { name: t("extensionsUpdate") }));
      expect(dependentsMock).not.toHaveBeenCalled();
    });
  });
});
