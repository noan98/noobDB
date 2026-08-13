import { describe, expect, it } from "vitest";
import { buildExportContent } from "../components/exportPreview";
import type { CellValue, Column, ExportFormat } from "../api/tauri";
import vectors from "./fixtures/exportFormatVectors.json";

// エクスポート書式のフロント↔バック共有ゴールデンテスト — フロント側 (#879)。
//
// `buildExportContent` は、エクスポートモーダルのプレビューと「全文コピー」のために
// バックエンド (`src-tauri/src/commands/export.rs`) の書き出しと**バイト一致**する
// よう独立に再実装されている。ここでは両者が参照する共有ベクタ
// (`fixtures/exportFormatVectors.json`) をフロント側で読み、5 書式の出力が期待値と
// 一致することを検証する。バック側は同じ JSON を
// `src-tauri/tests/export_format_golden.rs` が `include_str!` で読み込み、実ファイル
// 出力と同じ `write_export_to` を通して対になる検証を行う。
//
// 期待値 (`expected`) はバックエンド = 実ファイルの出力。フロントが原理的に一致
// させられない BLOB だけ `frontendExpected` で上書きする (フロントは JSON 化された
// 16 進文字列としてしか受け取れず、`Value::Bytes` を `Value::String` と区別できない)。

type FormatName = "csv" | "json" | "ndjson" | "markdown" | "sql";

const FORMATS: FormatName[] = ["csv", "json", "ndjson", "markdown", "sql"];

interface CellSpec {
  kind: "null" | "bool" | "int" | "uint" | "float" | "string" | "bytes";
  value?: string | number | boolean;
}

interface Case {
  name: string;
  note: string;
  columns: Column[];
  rows: CellSpec[][];
  query: string | null;
  sql: { driver: string; table: string; batchSize: number };
  expected: Record<FormatName, string>;
  frontendExpected?: Partial<Record<FormatName, string>>;
}

const cases = vectors.cases as unknown as Case[];

/**
 * ベクタのセルを、フロントが実際に受け取る `CellValue` へ変換する。`bytes` は
 * `Value` が `#[serde(untagged)]` のため JSON 上ではただの 16 進文字列として届く
 * — その現実をそのまま再現する (だから BLOB だけ出力が食い違う)。
 */
function toCellValue(c: CellSpec): CellValue {
  if (c.kind === "null") return null;
  return c.value as CellValue;
}

describe("エクスポート書式ゴールデン (フロント buildExportContent)", () => {
  it("ベクタが 5 書式すべてを覆う", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const c of cases) {
      for (const f of FORMATS) {
        expect(c.expected[f], `${c.name}/${f} の期待値が欠けています`).toBeTypeOf("string");
      }
    }
  });

  for (const c of cases) {
    const rows = c.rows.map((r) => r.map(toCellValue));
    for (const format of FORMATS) {
      const expected = c.frontendExpected?.[format] ?? c.expected[format];
      it(`${c.name} / ${format}: ${c.note}`, () => {
        const actual = buildExportContent(
          format as ExportFormat,
          c.columns,
          rows,
          c.query,
          { driver: c.sql.driver, table: c.sql.table, sqlBatchSize: c.sql.batchSize },
        );
        expect(actual).toBe(expected);
      });
    }
  }

  it("フロント/バックの既知の食い違い (BLOB) がベクタに明記されている", () => {
    // `frontendExpected` の上書きが 1 件も無くなったら、BLOB がフロントでは
    // ただの文字列になるという既知の差分が暗黙化している。
    expect(cases.some((c) => c.frontendExpected !== undefined)).toBe(true);
  });
});
