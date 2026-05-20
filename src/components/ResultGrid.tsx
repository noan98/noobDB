import { useMemo } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { CellValue, Column, QueryResult } from "../api/tauri";
import { useT } from "../i18n";

interface Props {
  result: QueryResult | null;
}

interface RowShape {
  [key: string]: CellValue;
}

type CellKind = "number" | "decimal" | "bool" | "date" | "time" | "json" | "binary" | "string";

const NUMERIC_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "INT",
  "INTEGER",
  "BIGINT",
  "YEAR",
  "FLOAT",
  "DOUBLE",
  "REAL",
  "TINYINT UNSIGNED",
  "SMALLINT UNSIGNED",
  "MEDIUMINT UNSIGNED",
  "INT UNSIGNED",
  "BIGINT UNSIGNED",
]);

const DECIMAL_TYPES = new Set(["DECIMAL", "NEWDECIMAL", "NUMERIC"]);
const DATE_TYPES = new Set(["DATE", "DATETIME", "TIMESTAMP"]);
const TIME_TYPES = new Set(["TIME"]);
const BINARY_TYPES = new Set([
  "BLOB",
  "TINYBLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "BINARY",
  "VARBINARY",
]);

function classifyColumn(col: Column): CellKind {
  const t = col.type_name.toUpperCase();
  if (NUMERIC_TYPES.has(t)) return "number";
  if (DECIMAL_TYPES.has(t)) return "decimal";
  if (t === "BOOLEAN" || t === "BOOL") return "bool";
  if (DATE_TYPES.has(t)) return "date";
  if (TIME_TYPES.has(t)) return "time";
  if (t === "JSON") return "json";
  if (BINARY_TYPES.has(t)) return "binary";
  return "string";
}

function classifyByValue(v: CellValue): CellKind | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "bool";
  return null;
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toString();
}

export function ResultGrid({ result }: Props) {
  const t = useT();

  const columnKinds = useMemo<CellKind[]>(() => {
    if (!result) return [];
    return result.columns.map(classifyColumn);
  }, [result]);

  const columns = useMemo<ColumnDef<RowShape>[]>(() => {
    if (!result) return [];
    return result.columns.map((c, i) => {
      const kind = columnKinds[i];
      return {
        id: String(i),
        header: () => (
          <span className="th-content" title={c.type_name}>
            <span className="th-name">{c.name}</span>
            <span className="th-type">{c.type_name}</span>
          </span>
        ),
        accessorFn: (row) => row[String(i)],
        cell: (info) => {
          const v = info.getValue() as CellValue;
          if (v === null || v === undefined) {
            return <span className="cell-null">{t("resultNull")}</span>;
          }
          const effectiveKind = classifyByValue(v) ?? kind;
          if (effectiveKind === "number") {
            const num = typeof v === "number" ? v : Number(v);
            const display = Number.isFinite(num) ? formatNumber(num) : String(v);
            return <span className="cell-number">{display}</span>;
          }
          if (effectiveKind === "decimal") {
            return <span className="cell-number cell-decimal">{String(v)}</span>;
          }
          if (effectiveKind === "bool") {
            const truthy = v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
            return (
              <span className={`cell-bool ${truthy ? "is-true" : "is-false"}`}>
                {truthy ? "true" : "false"}
              </span>
            );
          }
          if (effectiveKind === "date" || effectiveKind === "time") {
            return <span className="cell-date">{String(v)}</span>;
          }
          if (effectiveKind === "json") {
            return <span className="cell-json">{String(v)}</span>;
          }
          if (effectiveKind === "binary") {
            const s = String(v);
            const preview = s.length > 64 ? `${s.slice(0, 64)}…` : s;
            return <span className="cell-binary" title={s}>0x{preview}</span>;
          }
          return <span className="cell-string">{String(v)}</span>;
        },
      };
    });
  }, [result, columnKinds, t]);

  const data = useMemo<RowShape[]>(() => {
    if (!result) return [];
    return result.rows.map((r) => {
      const o: RowShape = {};
      r.forEach((v, i) => (o[String(i)] = v));
      return o;
    });
  }, [result]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (!result) {
    return <div className="results empty">{t("resultEmpty")}</div>;
  }
  if (result.columns.length === 0) {
    return (
      <div className="results empty">
        {t("resultExecuted", { rows: result.rows_affected, ms: result.elapsed_ms })}
      </div>
    );
  }

  const isNumericKind = (k: CellKind) => k === "number" || k === "decimal";

  return (
    <div className="results">
      <table>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              <th className="row-index" aria-hidden />
              {hg.headers.map((h, idx) => {
                const kind = columnKinds[idx] ?? "string";
                return (
                  <th key={h.id} className={`col-${kind} ${isNumericKind(kind) ? "align-right" : ""}`}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row, rowIdx) => (
            <tr key={row.id}>
              <td className="row-index">{rowIdx + 1}</td>
              {row.getVisibleCells().map((cell, idx) => {
                const v = cell.getValue() as CellValue;
                const kind = columnKinds[idx] ?? "string";
                const isNull = v === null || v === undefined;
                return (
                  <td
                    key={cell.id}
                    className={`col-${kind} ${isNumericKind(kind) ? "align-right" : ""} ${isNull ? "is-null" : ""}`}
                    title={isNull ? t("resultNull") : String(v)}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
