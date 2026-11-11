import { describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import type { TablePartitions } from "../api/tauri";
import { AddPartitionModal } from "../components/AddPartitionModal";

const listInfo: TablePartitions = {
  method: "LIST",
  key: "region",
  sub_method: null,
  sub_key: null,
  partitions: [
    {
      name: "p_jp",
      schema: null,
      parent: null,
      parent_schema: null,
      depth: 0,
      bound: "FOR VALUES IN ('jp')",
      size_bytes: 10,
      row_estimate: 1,
      is_default: false,
      is_partitioned: false,
      sub_partition_key: null,
    },
  ],
};

function open() {
  renderWithProviders(
    <AddPartitionModal
      database="public"
      table="orders"
      driver="postgres"
      info={listInfo}
      kind="list"
      onConfirm={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("AddPartitionModal (#2238)", () => {
  it("LIST は入力に触れる前に未入力のエラーを出さず、触れた後 (空) は出す", () => {
    open();
    expect(screen.queryByText(t("attachPartitionErrList"))).not.toBeInTheDocument();
    const input = screen.getByLabelText(t("attachPartitionValues"));
    fireEvent.change(input, { target: { value: "us" } });
    expect(screen.queryByText(t("attachPartitionErrList"))).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText(t("attachPartitionErrList"))).toBeInTheDocument();
  });

  it("帯に既存のパーティションとゴーストが出て、入力に追従する", () => {
    open();
    expect(screen.getByTestId("partition-ribbon")).toBeInTheDocument();
    expect(screen.getAllByTestId("partition-ribbon-ghost")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(t("attachPartitionValues")), { target: { value: "us" } });
    expect(screen.getByTestId("partition-ribbon-ghost")).toHaveTextContent("us");
  });

  it("未入力のまま Cmd/Ctrl+Enter で実行しようとすると、理由のエラーを出す", () => {
    open();
    expect(screen.queryByText(t("attachPartitionErrList"))).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText(t("attachPartitionValues")), { key: "Enter", ctrlKey: true });
    expect(screen.getByText(t("attachPartitionErrList"))).toBeInTheDocument();
  });
});
