import { useMemo } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { CellValue, QueryResult } from "../api/tauri";

interface Props {
  result: QueryResult | null;
}

interface RowShape {
  [key: string]: CellValue;
}

export function ResultGrid({ result }: Props) {
  const columns = useMemo<ColumnDef<RowShape>[]>(() => {
    if (!result) return [];
    return result.columns.map((c, i) => ({
      id: String(i),
      header: `${c.name} (${c.type_name})`,
      accessorFn: (row) => row[String(i)],
      cell: (info) => {
        const v = info.getValue() as CellValue;
        if (v === null || v === undefined) {
          return <span className="null">NULL</span>;
        }
        if (typeof v === "string") return v;
        return String(v);
      },
    }));
  }, [result]);

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
    return <div className="results" style={{ padding: 16, color: "#6b7280" }}>No results yet. Run a query above.</div>;
  }
  if (result.columns.length === 0) {
    return (
      <div className="results" style={{ padding: 16, color: "#6b7280" }}>
        Statement executed. {result.rows_affected} rows affected ({result.elapsed_ms} ms).
      </div>
    );
  }
  return (
    <div className="results">
      <table>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} title={cell.getValue() == null ? "NULL" : String(cell.getValue())}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
