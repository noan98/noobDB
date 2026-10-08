// `src-tauri/src/commands/logs.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { LogView } from "../tauri";

export const logsCommands = {

  readLogs: () =>
    invoke<LogView>("read_logs").then((r) =>
      parseResponse(schemas.logView, r, "read_logs"),
    ),
  clearLogs: () => invoke<void>("clear_logs"),
};
