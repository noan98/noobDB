import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { setLocale, t } from "../i18n";
import type { PublicationInfo } from "../api/tauri";

// 表をパブリケーションに追加 / から外すダイアログ (#2181)。

const publications: PublicationInfo[] = [
  {
    name: "pub_member",
    all_tables: false,
    publish: ["insert"],
    via_root: false,
    tables: [{ schema: "public", table: "orders", columns: null, row_filter: null }],
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

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, listPublications: () => listPublications() } };
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
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(
      [
        'ALTER PUBLICATION "pub_member" DROP TABLE "public"."orders"',
        'ALTER PUBLICATION "pub_other" ADD TABLE "public"."orders"',
      ],
      ["pub_member", "pub_other"],
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
});
