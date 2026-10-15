import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { Column } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, resultDuplicateKeys: vi.fn() } };
});

import { DuplicateKeysModal } from "../components/DuplicateKeysModal";
import { api } from "../api/tauri";

const columns: Column[] = [
  { name: "email", type_name: "TEXT" },
  { name: "plan", type_name: "TEXT" },
];
const rows = [
  ["a@x", "pro"],
  ["b@x", "pro"],
  ["a@x", "free"],
  [null, "pro"],
];

beforeEach(() => {
  vi.mocked(api.resultDuplicateKeys).mockReset();
});

function mount(overrides: Partial<React.ComponentProps<typeof DuplicateKeysModal>> = {}) {
  const props = {
    columns,
    rows,
    resultId: null,
    initialCols: [0],
    filterActive: false,
    onShowDuplicates: vi.fn(),
    onClearFilter: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<DuplicateKeysModal {...props} />);
  return props;
}

describe("DuplicateKeysModal (#1628)", () => {
  it("ハンドルが無ければ手元の行で検出し、NULL キーの行は対象外と明示する", async () => {
    mount();
    const summary = await screen.findByTestId("dup-keys-summary");
    expect(summary).toHaveTextContent(t("dupKeysSummary", { groups: "1", rows: "2", extra: "1" }));
    expect(screen.getByText(t("dupKeysNullSkipped", { count: "1" }))).toBeInTheDocument();
    expect(api.resultDuplicateKeys).not.toHaveBeenCalled();
  });

  it("列を足すと組み合わせで再検出し、一意なら重複なしと示す", async () => {
    mount();
    await screen.findByTestId("dup-keys-summary");
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    await waitFor(() =>
      expect(screen.getByTestId("dup-keys-summary")).toHaveTextContent(
        t("dupKeysNone", { columns: "email, plan", keys: "3" }),
      ),
    );
  });

  it("結果ハンドルがあればバックエンドで検出し、重複行だけ表示に添字を渡す", async () => {
    vi.mocked(api.resultDuplicateKeys).mockResolvedValue({
      rowCount: 4,
      nullKeyRows: 0,
      distinctKeys: 2,
      groupCount: 1,
      duplicateRows: 2,
      extraRows: 1,
      top: [{ values: ["a@x"], count: 2, firstRow: 0 }],
      rowIndices: [0, 2],
      indicesTruncated: false,
    });
    const props = mount({ resultId: "r1" });
    await screen.findByTestId("dup-keys-summary");
    expect(api.resultDuplicateKeys).toHaveBeenCalledWith("r1", [0]);
    fireEvent.click(screen.getByRole("button", { name: t("dupKeysShowOnly") }));
    expect(props.onShowDuplicates).toHaveBeenCalledWith([0, 2]);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("ハンドルが破棄済みのときは手元の行で検出し直す", async () => {
    vi.mocked(api.resultDuplicateKeys).mockResolvedValue(null);
    mount({ resultId: "gone" });
    expect(await screen.findByTestId("dup-keys-summary")).toHaveTextContent(
      t("dupKeysSummary", { groups: "1", rows: "2", extra: "1" }),
    );
  });

  it("絞り込み中は解除ボタンになる", async () => {
    const props = mount({ filterActive: true });
    await screen.findByTestId("dup-keys-summary");
    fireEvent.click(screen.getByRole("button", { name: t("dupKeysClearFilter") }));
    expect(props.onClearFilter).toHaveBeenCalled();
  });
});
