import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { renderWithProviders, screen } from "./testUtils";
import { setLocale, t } from "../i18n";

// 既存テーブルのパーティション付け直しダイアログ (#1929) の読み込み表示と初期フォーカス (#2214)。

const listTablesMock = vi.hoisted(() => vi.fn());

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, listTables: (...a: unknown[]) => listTablesMock(...a) } };
});

import { AttachPartitionModal } from "../components/AttachPartitionModal";

const INFO = { method: "range", key: "created_at", sub_method: null, sub_key: null, partitions: [] };

function setup() {
  renderWithProviders(
    <AttachPartitionModal
      sessionId="s1"
      database="public"
      table="events"
      info={INFO}
      kind="range"
      onConfirm={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("AttachPartitionModal", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
  });

  it("読み込みが終わったとき、まだ触れていなければセレクトへフォーカスを寄せる", async () => {
    let resolve: (v: string[]) => void = () => {};
    listTablesMock.mockReturnValue(new Promise<string[]>((r) => (resolve = r)));
    setup();
    await act(async () => resolve(["ev_legacy"]));
    expect(await screen.findByRole("combobox")).toHaveFocus();
  });

  it("読み込み中に境界値を入力し始めていたら、読み込みが終わってもフォーカスを奪わない", async () => {
    const user = userEvent.setup();
    let resolve: (v: string[]) => void = () => {};
    listTablesMock.mockReturnValue(new Promise<string[]>((r) => (resolve = r)));
    setup();
    const from = screen.getByLabelText(t("attachPartitionFrom", { column: "created_at" }));
    await user.click(from);
    await user.type(from, "2024");
    await act(async () => resolve(["ev_legacy"]));
    await screen.findByRole("combobox");
    expect(from).toHaveFocus();
  });

  it("読み込みに失敗したときは「候補なし」を出さず、エラーだけを出す", async () => {
    listTablesMock.mockRejectedValue(new Error("boom"));
    setup();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(
      screen.queryByText(t("attachPartitionNoCandidates", { schema: "public" })),
    ).not.toBeInTheDocument();
  });
});
