// `src-tauri/src/commands/logs.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { LogView, PerfStatus } from "../tauri";

export const logsCommands = {
  readLogs: () => invoke<LogView>("read_logs").then((r) => parseResponse(schemas.logView, r, "read_logs")),
  clearLogs: () => invoke<void>("clear_logs"),
  /** パフォーマンス計測の状態と直近値 (#1622)。 */
  getPerfStatus: () =>
    invoke<PerfStatus>("get_perf_status").then((r) =>
      parseResponse(schemas.perfStatus, r, "get_perf_status"),
    ),
  setPerfEnabled: (enabled: boolean) =>
    invoke<PerfStatus>("set_perf_enabled", { enabled }).then((r) =>
      parseResponse(schemas.perfStatus, r, "set_perf_enabled"),
    ),
  clearPerfSamples: () => invoke<void>("clear_perf_samples"),
  /** 匿名化した診断バンドル (プレーンテキスト) を作る (#1622)。 */
  buildDiagnosticBundle: () => invoke<string>("build_diagnostic_bundle"),
};
