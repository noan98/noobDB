import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { DangerousQueryDialog } from "../components/DangerousQueryDialog";
import type { DangerFinding } from "../dangerousSql";
import { setLocale, t } from "../i18n";

// 危険クエリ確認ダイアログの「安全網」としての退行を検出するテスト。
// 確認フロー (実行 / キャンセルの結線、危険理由の表示、
// 本番接続の警告) が壊れていないことを保証する。
//
// 文言はロケールで変わるため、ハードコードせず i18n の `t()` から期待値を引く。
// これによりキー → ラベルの結線が正しいことを検証しつつ、文言変更に強くなる。
const runLookupQuery = vi.fn();
vi.mock("../api/tauri", async (orig) => {
  const mod = await orig<typeof import("../api/tauri")>();
  return { ...mod, api: { ...mod.api, runLookupQuery: (...a: unknown[]) => runLookupQuery(...a) } };
});

describe("DangerousQueryDialog", () => {
  beforeEach(() => {
    // ロケールを固定して描画される文言を決定的にする (jsdom 既定は en だが明示)。
    setLocale("en");
  });

  const findings: DangerFinding[] = [{ kind: "deleteNoWhere", target: "users" }];

  it("検出した危険理由と対象テーブルを一覧表示する", () => {
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(t("dangerousTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("dangerousKindDeleteNoWhere"))).toBeInTheDocument();
    expect(screen.getByText(t("dangerousTargetTable", { target: "users" }))).toBeInTheDocument();
  });

  it("主キーで絞る WHERE の提案を出し、押すと onInsert だけが呼ばれる (#1626)", async () => {
    const onInsert = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        pkSuggestion={{ template: "WHERE `id` = ", onInsert }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("WHERE `id` =")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("dangerousPkSuggestInsert") }));
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("「実行する」を押すと onConfirm が呼ばれ onCancel は呼ばれない", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: t("dangerousConfirm") }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("「キャンセル」を押すと onCancel が呼ばれ実行は中止される", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    // フッタの「キャンセル」ボタン。ヘッダの閉じる (X) ボタンも aria-label が
    // 同じ "Cancel" なので、可視テキストを持つフッタ側を指名する。
    await user.click(screen.getByText(t("dangerousCancel")));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("本番接続では専用の警告文を表示する", () => {
    const { rerender } = renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText(t("dangerousProductionNote"))).not.toBeInTheDocument();

    rerender(
      <DangerousQueryDialog
        findings={findings}
        isProduction={true}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(t("dangerousProductionNote"))).toBeInTheDocument();
  });

  it("検出理由がなく書き込み承認のみの場合は専用の説明文を表示する", () => {
    renderWithProviders(
      <DangerousQueryDialog
        findings={[]}
        isProduction={true}
        writeApproval
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(t("dangerousWriteApprovalIntro"))).toBeInTheDocument();
  });

  // #737: プリフライトの影響行数を確認ダイアログへ引き継ぐ。
  describe("影響行数の引き継ぎ (#737)", () => {
    it("WHERE なし DELETE は全行 + 件数を表示する", () => {
      renderWithProviders(
        <DangerousQueryDialog
          findings={findings}
          isProduction={false}
          impact={{ verb: "delete", count: 45000, allRows: true }}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(
        screen.getByText(t("dangerousImpactDelete", { count: (45000).toLocaleString() })),
      ).toBeInTheDocument();
      expect(screen.getByText(t("dangerousImpactAllRows"))).toBeInTheDocument();
      expect(screen.getByText(t("dangerousImpactNote"))).toBeInTheDocument();
    });

    it("WHERE 付き UPDATE は件数のみ表示し全行文言は出さない", () => {
      renderWithProviders(
        <DangerousQueryDialog
          findings={[]}
          isProduction={true}
          writeApproval
          impact={{ verb: "update", count: 12, allRows: false }}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(
        screen.getByText(t("dangerousImpactUpdate", { count: (12).toLocaleString() })),
      ).toBeInTheDocument();
      expect(screen.queryByText(t("dangerousImpactAllRows"))).not.toBeInTheDocument();
    });

    it("impact 未指定では影響行数の文言を出さない", () => {
      renderWithProviders(
        <DangerousQueryDialog
          findings={findings}
          isProduction={false}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(screen.queryByText(t("dangerousImpactNote"))).not.toBeInTheDocument();
    });
  });

  // #675: 本番接続の DROP/TRUNCATE には対象名タイプ入力の強確認ゲートを追加する。
  describe("タイプして確認ゲート (#675)", () => {
    const dropFindings: DangerFinding[] = [{ kind: "drop", target: "users" }];

    it("typedConfirmTarget 未指定 (非本番・DROP/TRUNCATE 以外) では従来通りボタンが有効", () => {
      renderWithProviders(
        <DangerousQueryDialog
          findings={dropFindings}
          isProduction={false}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(screen.getByRole("button", { name: t("dangerousConfirm") })).toBeEnabled();
      expect(screen.queryByText(t("typeToConfirmLabel", { target: "users" }))).not.toBeInTheDocument();
    });

    it("typedConfirmTarget 指定時は一致するまで実行ボタンが無効", async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <DangerousQueryDialog
          findings={dropFindings}
          isProduction={true}
          typedConfirmTarget="users"
          onConfirm={onConfirm}
          onCancel={() => {}}
        />,
      );

      const confirmButton = screen.getByRole("button", { name: t("dangerousConfirm") });
      expect(confirmButton).toBeDisabled();

      const input = screen.getByLabelText(t("typeToConfirmLabel", { target: "users" }));
      await user.type(input, "wrong-name");
      expect(confirmButton).toBeDisabled();

      await user.clear(input);
      await user.type(input, "users");
      expect(confirmButton).toBeEnabled();

      await user.click(confirmButton);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  describe("子テーブルへの影響 (#1767)", () => {
    const base = {
      findings,
      isProduction: false,
      onConfirm: () => {},
      onCancel: () => {},
    };

    it("CASCADE / RESTRICT / SET NULL を参照動作ごとの文言で出し、さらに連鎖があれば注記する", async () => {
      const load = vi.fn().mockResolvedValue({
        impacts: [
          {
            parentTable: "users",
            table: "orders",
            column: "user_id",
            referencedColumn: "id",
            onDelete: "CASCADE",
            count: 3,
          },
          {
            parentTable: "users",
            table: "logs",
            column: "user_id",
            referencedColumn: "id",
            onDelete: "RESTRICT",
            count: 2,
          },
          {
            parentTable: "users",
            table: "prefs",
            column: "user_id",
            referencedColumn: "id",
            onDelete: "SET NULL",
            count: 1,
          },
          {
            parentTable: "orders",
            table: "items",
            column: "order_id",
            referencedColumn: "id",
            onDelete: "CASCADE",
            count: 9,
            depth: 2,
          },
        ],
        moreCascade: true,
        unverified: [],
      });
      renderWithProviders(<DangerousQueryDialog {...base} fkImpact={{ driver: "mysql", load }} />);
      expect(screen.getByTestId("dangerous-fk-loading")).toBeInTheDocument();
      const rows = await screen.findAllByTestId("ref-impact-row");
      expect(load).toHaveBeenCalledTimes(1);
      expect(rows[0]).toHaveTextContent("3 rows will be cascade-deleted");
      expect(rows[1]).toHaveTextContent("delete is expected to fail");
      expect(rows[2]).toHaveTextContent("1 rows will be set to NULL");
      expect(rows[3]).toHaveTextContent("cascade level 2");
      expect(screen.getByTestId("ref-impact-more-cascade")).toBeInTheDocument();
    });

    it("集計に失敗しても実行ボタンは押せて、確認できなかった旨を出す", async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      const load = vi.fn().mockRejectedValue(new Error("timeout"));
      renderWithProviders(
        <DangerousQueryDialog {...base} onConfirm={onConfirm} fkImpact={{ driver: "mysql", load }} />,
      );
      expect(await screen.findByTestId("dangerous-fk-failed")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: t("dangerousConfirm") }));
      expect(onConfirm).toHaveBeenCalled();
    });
  });

  it("影響行のプレビューを表に出し、UPDATE の SET 対象列を強調する (#1881)", async () => {
    runLookupQuery.mockResolvedValue({
      columns: [{ name: "id" }, { name: "Name" }],
      rows: [
        [1, "a"],
        [2, "b"],
      ],
    });
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        rowPreview={{
          sessionId: "s1",
          database: null,
          sampleSql: "SELECT * FROM t WHERE x = 1 LIMIT 20",
          verb: "update",
          total: 2,
          setColumns: ["name"],
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await screen.findByRole("columnheader", { name: "Name" }, { timeout: 3000 });
    expect(runLookupQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        sql: "SELECT * FROM t WHERE x = 1 LIMIT 20",
        rowCap: 20,
        queryTimeoutSecs: 5,
      }),
    );
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("data-highlight", "true");
    expect(screen.getByRole("columnheader", { name: "id" })).not.toHaveAttribute("data-highlight");
  });

  it("rowPreview が無いときはプレビューを出さず問い合わせもしない (#1881)", () => {
    runLookupQuery.mockClear();
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByTestId("dangerous-row-preview")).not.toBeInTheDocument();
    expect(runLookupQuery).not.toHaveBeenCalled();
  });

  it("プレビュー取得が失敗してもエラーを表示し、実行ボタンは有効のまま (#1881)", async () => {
    runLookupQuery.mockRejectedValue(new Error("boom"));
    renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        rowPreview={{
          sessionId: "s1",
          database: null,
          sampleSql: "SELECT * FROM t LIMIT 20",
          verb: "delete",
          total: 3,
          setColumns: [],
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(await screen.findByText(/boom/, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("dangerousConfirm") })).toBeEnabled();
  });
});
