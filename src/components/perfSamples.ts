import type { PerfSample } from "../api/tauri";

/** 診断タブ「パフォーマンス」(#1622) に出す 1 行。表示用の文字列は呼び出し側で整える。 */
export interface PerfRow {
  atMs: number;
  kind: string;
  sqlExecuteMs: number | null;
  emitMs: number | null;
  payloadBytes: number | null;
  rows: number;
  columns: number;
}

export function toPerfRows(samples: readonly PerfSample[]): PerfRow[] {
  return samples.map((s) => ({
    atMs: s.at_ms,
    kind: s.kind,
    sqlExecuteMs: s.sql_execute_ms,
    emitMs: s.emit_ms,
    payloadBytes: s.payload_bytes_approx,
    rows: s.rows,
    columns: s.columns,
  }));
}

/** ミリ秒を「12.5 ms」/「1.20 s」に。null は「–」。 */
export function formatPerfMs(ms: number | null): string {
  if (ms == null) return "–";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(1)} ms`;
}

/** 概算バイト数を「4.0 KiB」などに。null は「–」。 */
export function formatPerfBytes(bytes: number | null): string {
  if (bytes == null) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * 直近の計測値のうち最も遅い SQL 実行 (ms)。表の上に「いちばん遅かった実行」を
 * 添えて、ボトルネックの当たりを付けやすくする。計測値が無ければ null。
 */
export function slowestSqlExecuteMs(rows: readonly PerfRow[]): number | null {
  let max: number | null = null;
  for (const r of rows) {
    if (r.sqlExecuteMs != null && (max == null || r.sqlExecuteMs > max)) max = r.sqlExecuteMs;
  }
  return max;
}
