import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { setLocale, t } from "../i18n";

// テーブル定義からの型定義生成モーダル (#2411)。

const DESCRIBED = [
  {
    name: "posts",
    columns: [
      { name: "id", data_type: "integer", nullable: false },
      { name: "tags", data_type: "ARRAY", nullable: true },
    ],
  },
  { name: "users", columns: [{ name: "name", data_type: "text", nullable: false }] },
];

let resolveLookup: (v: { rows: string[][] }) => void = () => {};
const runLookupQuery = vi.fn(
  () =>
    new Promise<{ rows: string[][] }>((resolve) => {
      resolveLookup = resolve;
    }),
);

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeDatabase: () => Promise.resolve(DESCRIBED),
      listTableComments: () => Promise.resolve([]),
      runLookupQuery: (...a: unknown[]) => (runLookupQuery as (...x: unknown[]) => unknown)(...a),
    },
  };
});

import { TypeDefModal } from "../components/TypeDefModal";

describe("TypeDefModal", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
  });

  it("読み込み → テーブル選択 → プレビュー、PG の配列 lookup 中はコピー不可", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TypeDefModal sessionId="s1" driver="postgres" database="public" tables={[]} onClose={() => {}} />,
    );
    // 読み込み後、テーブル未選択なのでコピー不可。
    const users = await screen.findByRole("checkbox", { name: /users/ });
    expect(screen.getByRole("button", { name: t("typeDefCopy") })).toBeDisabled();

    // 配列列を持たないテーブルはすぐプレビューされコピーできる。
    await user.click(users);
    expect(await screen.findByLabelText(t("typeDefPreview"))).toHaveTextContent("name: string;");
    expect(screen.getByRole("button", { name: t("typeDefCopy") })).toBeEnabled();

    // 配列列を持つテーブルを足すと lookup が走り、完了までコピー不可。
    await user.click(screen.getByRole("checkbox", { name: /posts/ }));
    await waitFor(() => expect(runLookupQuery).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: t("typeDefCopy") })).toBeDisabled();

    resolveLookup({
      rows: [
        ["id", "integer"],
        ["tags", "integer[]"],
      ],
    });
    await waitFor(() => expect(screen.getByRole("button", { name: t("typeDefCopy") })).toBeEnabled());
    expect(screen.getByLabelText(t("typeDefPreview"))).toHaveTextContent("tags: number[] | null;");
  });
});
