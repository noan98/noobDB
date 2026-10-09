// `src-tauri/src/commands/dump.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import type { DumpOptions } from "../tauri";

export const dumpCommands = {

  /**
   * Start a streaming, cancelable database dump (#686). Returns once the dump
   * has been kicked off; progress + completion arrive via `dump-stream:*` events
   * (subscribe with {@link listenDumpStream}) keyed by `streamId`. Cancel via
   * {@link api.cancelStream}.
   */
  dumpDatabase: (params: {
    sessionId: string;
    streamId: string;
    database: string;
    path: string;
    options: DumpOptions;
  }) =>
    invoke<void>("dump_database", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      database: params.database,
      path: params.path,
      options: params.options,
    }),
};
