import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { RowInspector } from "../components/RowInspector";
import { setLocale, t } from "../i18n";

const copyToClipboard = vi.fn(async (_s: string) => true);
vi.mock("../components/clipboard", async (orig) => ({
  ...(await orig<typeof import("../components/clipboard")>()),
  copyToClipboard: (s: string) => copyToClipboard(s),
}));

// JSON 欄の表示は数値を丸めず、コピーは元の値 (raw) を使う。
const RAW = '{"id":12345678901234567890,"x":1.0}';

describe("RowInspector の JSON 欄", () => {
  beforeEach(() => {
    setLocale("en");
    copyToClipboard.mockClear();
  });

  it("表示で大きな整数・1.0 を保ち、コピーは元の文字列", () => {
    renderWithProviders(
      <RowInspector
        columns={[{ name: "doc", type_name: "JSON" }]}
        values={[RAW]}
        columnKinds={["string"]}
        rowNumber={1}
        hasPrev={false}
        hasNext={false}
        onClose={() => {}}
      />,
    );
    expect(document.body.textContent).toContain("12345678901234567890");
    expect(document.body.textContent).not.toContain("12345678901234567000");
    expect(document.body.textContent).toContain('"x": 1.0');
    fireEvent.click(screen.getByRole("button", { name: t("gridInspectorCopyField") }));
    expect(copyToClipboard).toHaveBeenCalledWith(RAW);
  });
});
