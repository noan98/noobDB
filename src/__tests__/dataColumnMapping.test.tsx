import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type TableColumnInfo } from "../api/tauri";
import type { ColumnMapping } from "../components/columnMapping";
import { DataColumnMapping } from "../components/DataColumnMapping";
import { t } from "../i18n";
import { chooseListboxOption, renderWithProviders, screen, waitFor } from "./testUtils";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, describeTable: vi.fn() } };
});

const col = (name: string): TableColumnInfo => ({
  name,
  data_type: "text",
  nullable: true,
  key: "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
});

function Harness({ onChange }: { onChange: (m: ColumnMapping) => void }) {
  const [mapping, setMapping] = useState<ColumnMapping>({});
  return (
    <DataColumnMapping
      sourceSessionId="s1"
      sourceDatabase="db"
      sourceTable="users_old"
      targetSessionId="s2"
      targetDatabase="db"
      targetTable="users_new"
      caseInsensitive={false}
      mapping={mapping}
      onChange={(m) => {
        setMapping(m);
        onChange(m);
      }}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// データ比較の列の対応付け (#2099)。同名の列は出さず、相手のいない列だけ割り当てを選ばせる。
describe("DataColumnMapping", () => {
  it("同名の列しかなければ何も出さない", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([col("id"), col("name")]);
    renderWithProviders(<Harness onChange={() => {}} />);
    await waitFor(() => expect(api.describeTable).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("group", { name: t("schemaCompareColMapTitle") })).toBeNull();
  });

  it("相手のいない列だけ並べ、選んだ割り当てを通知する", async () => {
    vi.mocked(api.describeTable).mockImplementation(async (_s, _d, table) =>
      table === "users_old" ? [col("id"), col("user_name")] : [col("id"), col("username")],
    );
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);
    const trigger = await screen.findByRole("combobox", {
      name: t("schemaCompareColMapTarget", { column: "user_name" }),
    });
    expect(
      screen.queryByRole("combobox", { name: t("schemaCompareColMapTarget", { column: "id" }) }),
    ).toBeNull();
    expect(screen.getByText("user_name")).toBeInTheDocument();
    chooseListboxOption(trigger, "username");
    expect(onChange).toHaveBeenLastCalledWith({ user_name: "username" });
    // 割り当てるとその列の「未割り当て」警告は消える。
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
