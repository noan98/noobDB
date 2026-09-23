import { describe, expect, it } from "vitest";
import { exportFormatHasTextPreview, xlsxTruncationNotices } from "../components/exportXlsx";
import { buildExportContent } from "../components/exportPreview";
import { t } from "../i18n";

// Excel (xlsx) エクスポート (#711) のフロント側純ロジック。値 → セルの対応と
// Excel の上限の扱いはバックエンド (`commands/export_xlsx.rs` + 共有ゴールデンの
// `xlsxCells`) が固定しているので、ここはプレビュー可否と警告文の組み立てだけを見る。

describe("exportFormatHasTextPreview", () => {
  it("xlsx だけがプレビュー/コピー対象外", () => {
    expect(exportFormatHasTextPreview("xlsx")).toBe(false);
    for (const f of ["csv", "json", "ndjson", "markdown", "sql"] as const) {
      expect(exportFormatHasTextPreview(f)).toBe(true);
    }
  });

  it("buildExportContent は xlsx で JSON にフォールバックせず空を返す", () => {
    const out = buildExportContent("xlsx", [{ name: "id", type_name: "int" }], [[1]]);
    expect(out).toBe("");
  });
});

describe("xlsxTruncationNotices", () => {
  it("欠けが無ければ警告なし", () => {
    expect(xlsxTruncationNotices(null)).toEqual([]);
    expect(xlsxTruncationNotices(undefined)).toEqual([]);
    expect(
      xlsxTruncationNotices({ writtenRows: 10, droppedRows: 0, truncatedCells: 0 }),
    ).toEqual([]);
  });

  it("行の打ち切りは全行数・書いた行数・落とした行数を含む", () => {
    const notices = xlsxTruncationNotices({
      writtenRows: 1_048_575,
      droppedRows: 25,
      truncatedCells: 0,
    });
    expect(notices).toEqual([
      {
        key: "exportXlsxRowsDropped",
        params: { written: 1_048_575, dropped: 25, total: 1_048_600 },
      },
    ]);
    const text = t(notices[0].key, notices[0].params);
    expect(text).toContain("1048575");
    expect(text).toContain("1048600");
    expect(text).toContain("25");
  });

  it("セル切り詰めは別の警告として並べる", () => {
    const notices = xlsxTruncationNotices({
      writtenRows: 3,
      droppedRows: 1,
      truncatedCells: 2,
    });
    expect(notices.map((n) => n.key)).toEqual([
      "exportXlsxRowsDropped",
      "exportXlsxCellsTruncated",
    ]);
    expect(notices[1].params).toEqual({ cells: 2 });
  });
});
