import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { setLocale, t } from "../i18n";
import type { PublicationInfo, TableReplicaIdentity } from "../api/tauri";

// 表をパブリケーションに追加 / から外すダイアログ (#2181)。

const publications: PublicationInfo[] = [
  {
    name: "pub_member",
    all_tables: false,
    publish: ["insert"],
    via_root: false,
    tables: [
      {
        schema: "public",
        table: "orders",
        columns: null,
        row_filter: null,
        replica_identity: "d",
        has_primary_key: true,
      },
    ],
    schemas: [],
  },
  { name: "pub_other", all_tables: false, publish: ["insert"], via_root: false, tables: [], schemas: [] },
  { name: "pub_all", all_tables: true, publish: ["insert"], via_root: false, tables: [], schemas: [] },
  {
    name: "pub_schema",
    all_tables: false,
    publish: ["insert"],
    via_root: false,
    tables: [],
    schemas: ["public"],
  },
];

const listPublications = vi.fn<() => Promise<PublicationInfo[]>>();
const getTableReplicaIdentity = vi.fn<() => Promise<TableReplicaIdentity | null>>();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listPublications: () => listPublications(),
      getTableReplicaIdentity: () => getTableReplicaIdentity(),
    },
  };
});

import { PublicationModal } from "../components/PublicationModal";

function setup(over: { readOnly?: boolean } = {}) {
  const onConfirm = vi.fn();
  renderWithProviders(
    <PublicationModal
      sessionId="s1"
      database="public"
      table="orders"
      readOnly={over.readOnly ?? false}
      onConfirm={onConfirm}
      onClose={() => {}}
    />,
  );
  return { onConfirm };
}

describe("PublicationModal", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
    listPublications.mockResolvedValue(publications);
    getTableReplicaIdentity.mockResolvedValue({
      replica_identity: "d",
      has_primary_key: true,
      is_partitioned: false,
    });
  });

  it("所属を示し、ALL TABLES / TABLES IN SCHEMA のものは選べない", async () => {
    setup();
    await screen.findByText("pub_member");
    expect(screen.getByText(t("publicationStateMember"))).toBeInTheDocument();
    expect(screen.getByText(t("publicationStateNone"))).toBeInTheDocument();
    expect(screen.getByText(t("publicationStateAll"))).toBeInTheDocument();
    expect(screen.getByText(t("publicationStateSchema"))).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    expect(boxes[0]).toBeEnabled();
    expect(boxes[1]).toBeEnabled();
    expect(boxes[2]).toBeDisabled();
    expect(boxes[3]).toBeDisabled();
  });

  it("選んだものを ADD / DROP でプレビューし、確定で文とパブリケーション名を渡す", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await screen.findByText("pub_member");
    const confirm = screen.getByRole("button", { name: t("publicationConfirm") });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(t("publicationPreviewEmpty"))).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    await user.click(boxes[0]);
    await user.click(boxes[1]);
    await waitFor(() =>
      expect(screen.getByTestId("sql-preview")).toHaveTextContent(
        'ALTER PUBLICATION "pub_member" DROP TABLE "public"."orders";',
      ),
    );
    expect(screen.getByTestId("sql-preview")).toHaveTextContent(
      'ALTER PUBLICATION "pub_other" ADD TABLE "public"."orders";',
    );
    // 外す操作があれば配信が止まる旨、変更があれば REFRESH PUBLICATION の旨を出す。
    expect(screen.getByText(t("publicationDropWarn"))).toBeInTheDocument();
    expect(screen.getByText(t("publicationRefreshNote"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("publicationConfirm") }));
    expect(onConfirm).toHaveBeenCalledWith(
      [
        'ALTER PUBLICATION "pub_member" DROP TABLE "public"."orders"',
        'ALTER PUBLICATION "pub_other" ADD TABLE "public"."orders"',
      ],
      ["pub_member", "pub_other"],
    );
  });

  it("外す操作を含むと破壊的レイアウト (実行が dangerOutline で左、キャンセルが primary) になり、追加だけなら通常のまま", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("pub_member");
    const boxes = screen.getAllByRole("checkbox");
    await user.click(boxes[1]);
    const buttons = () =>
      screen
        .getAllByRole("button")
        .filter((b) => [t("publicationConfirm"), t("publicationCancel")].includes(b.textContent ?? ""));
    // 追加だけ: キャンセル → 適用 の順。
    expect(buttons().map((b) => b.textContent)).toEqual([t("publicationCancel"), t("publicationConfirm")]);
    await user.click(boxes[0]);
    // 外す操作あり: 適用 → キャンセル の順。
    await waitFor(() =>
      expect(buttons().map((b) => b.textContent)).toEqual([t("publicationConfirm"), t("publicationCancel")]),
    );
  });

  it("追加だけなら配信停止の警告は出さない", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("pub_member");
    await user.click(screen.getAllByRole("checkbox")[1]);
    await waitFor(() =>
      expect(screen.getByTestId("sql-preview")).toHaveTextContent('ADD TABLE "public"."orders";'),
    );
    expect(screen.queryByText(t("publicationDropWarn"))).not.toBeInTheDocument();
  });

  it("read_only では警告を出して選べず、確定できない", async () => {
    setup({ readOnly: true });
    await screen.findByText(t("publicationReadOnly"));
    await screen.findByText("pub_member");
    for (const b of screen.getAllByRole("checkbox")) expect(b).toBeDisabled();
    expect(screen.getByRole("button", { name: t("publicationConfirm") })).toBeDisabled();
  });

  it("パブリケーションが無いときは案内する。取得に失敗したらエラーを出す", async () => {
    listPublications.mockResolvedValueOnce([]);
    setup();
    await screen.findByText(t("publicationNone"));
  });

  it("取得に失敗したらエラーを出す", async () => {
    listPublications.mockRejectedValueOnce(new Error("boom"));
    setup();
    await screen.findByText(/boom/);
    expect(screen.queryByText(t("publicationNone"))).not.toBeInTheDocument();
  });

  it("実行中は確定ボタンが無効になり、二重に押しても 1 回だけ渡す", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderWithProviders(
      <PublicationModal
        sessionId="s1"
        database="public"
        table="orders"
        readOnly={false}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await screen.findByText("pub_member");
    await user.click(screen.getAllByRole("checkbox")[1]);
    const confirm = screen.getByRole("button", { name: t("publicationConfirm") });
    await user.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(confirm).toBeEnabled());
  });

  describe("REPLICA IDENTITY の警告 (#2212)", () => {
    const updating: PublicationInfo[] = [
      {
        name: "pub_upd",
        all_tables: false,
        publish: ["insert", "update", "delete"],
        via_root: false,
        tables: [],
        schemas: [],
      },
      { name: "pub_ins", all_tables: false, publish: ["insert"], via_root: false, tables: [], schemas: [] },
    ];

    it("主キーの無い表を update / delete を公開するパブリケーションへ追加しようとすると、実行前に警告と対処を出す", async () => {
      const user = userEvent.setup();
      listPublications.mockResolvedValue(updating);
      getTableReplicaIdentity.mockResolvedValue({
        replica_identity: "d",
        has_primary_key: false,
        is_partitioned: false,
      });
      const { onConfirm } = setup();
      await screen.findByText("pub_upd");
      expect(screen.queryByText(t("publicationReplicaWarnBody"))).not.toBeInTheDocument();
      await user.click(screen.getAllByRole("checkbox")[0]);
      expect(await screen.findByText(t("publicationReplicaWarnBody"))).toBeInTheDocument();
      expect(screen.getByText(t("publicationReplicaFixPk"))).toBeInTheDocument();
      expect(screen.getByText(t("publicationReplicaFixInsertOnly"))).toBeInTheDocument();
      // REPLICA IDENTITY FULL はチェックするとプレビューと実行文に加わり、WAL 増加の注記が出る。
      expect(screen.getByTestId("sql-preview")).not.toHaveTextContent("REPLICA IDENTITY FULL");
      await user.click(screen.getByRole("checkbox", { name: t("publicationReplicaFullOption") }));
      await waitFor(() =>
        expect(screen.getByTestId("sql-preview")).toHaveTextContent(
          'ALTER TABLE "public"."orders" REPLICA IDENTITY FULL;',
        ),
      );
      expect(screen.getByText(t("publicationReplicaFullWalNote"))).toBeInTheDocument();
      // FULL にチェックすると、警告の見出しは「FULL を設定して追加します」に変わる。
      expect(screen.getByText(t("publicationReplicaFullTitle", { names: "pub_upd" }))).toBeInTheDocument();
      expect(
        screen.queryByText(t("publicationReplicaWarnTitle", { names: "pub_upd" })),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: t("publicationConfirm") }));
      expect(onConfirm).toHaveBeenCalledWith(
        [
          'ALTER TABLE "public"."orders" REPLICA IDENTITY FULL',
          'ALTER PUBLICATION "pub_upd" ADD TABLE "public"."orders"',
        ],
        ["pub_upd"],
      );
    });

    it("insert だけのパブリケーション・主キーがある表・identity 不明では警告しない", async () => {
      const user = userEvent.setup();
      listPublications.mockResolvedValue(updating);
      getTableReplicaIdentity.mockResolvedValue({
        replica_identity: "d",
        has_primary_key: false,
        is_partitioned: false,
      });
      const view = setup();
      await screen.findByText("pub_ins");
      await user.click(screen.getAllByRole("checkbox")[1]);
      await waitFor(() => expect(screen.getByTestId("sql-preview")).toHaveTextContent("pub_ins"));
      expect(screen.queryByText(t("publicationReplicaWarnBody"))).not.toBeInTheDocument();
      view.onConfirm.mockClear();
    });

    it("主キーがある表 / 取得失敗では警告しない", async () => {
      const user = userEvent.setup();
      listPublications.mockResolvedValue(updating);
      getTableReplicaIdentity.mockRejectedValue(new Error("x"));
      setup();
      await screen.findByText("pub_upd");
      await user.click(screen.getAllByRole("checkbox")[0]);
      await waitFor(() => expect(screen.getByTestId("sql-preview")).toHaveTextContent("pub_upd"));
      expect(screen.queryByText(t("publicationReplicaWarnBody"))).not.toBeInTheDocument();
    });

    it("パーティション親表は FULL のチェックを無効にし、パーティションごとの設定が要る注記を出す", async () => {
      const user = userEvent.setup();
      listPublications.mockResolvedValue(updating);
      getTableReplicaIdentity.mockResolvedValue({
        replica_identity: "n",
        has_primary_key: false,
        is_partitioned: true,
      });
      setup();
      await screen.findByText("pub_upd");
      await user.click(screen.getAllByRole("checkbox")[0]);
      expect(await screen.findByText(t("publicationReplicaWarnBody"))).toBeInTheDocument();
      expect(screen.getByText(t("publicationReplicaPartitionNote"))).toBeInTheDocument();
      const full = screen.getByRole("checkbox", { name: t("publicationReplicaFullOption") });
      expect(full).toBeDisabled();
      await user.click(full);
      expect(screen.getByTestId("sql-preview")).not.toHaveTextContent("REPLICA IDENTITY FULL");
    });

    it("表の replica identity を表示する", async () => {
      getTableReplicaIdentity.mockResolvedValue({
        replica_identity: "n",
        has_primary_key: true,
        is_partitioned: false,
      });
      setup();
      await screen.findByText("pub_member");
      expect(
        screen.getByText(`${t("publicationReplicaIdentityLabel")}: ${t("publicationReplicaNothing")}`),
      ).toBeInTheDocument();
    });
  });
});
