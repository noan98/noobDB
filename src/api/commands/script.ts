// `src-tauri/src/commands/script.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import { batchStreamChannels } from "../streamChannels";
import type { ScriptOptions } from "../tauri";

export const scriptCommands = {

  /**
   * `.sql` スクリプトファイルを文単位でストリーミング実行する (#973)。ファイルは
   * バックエンドが 64 KiB ずつ読むので全体をメモリに載せない。進捗・完了・エラーは
   * `sql-script:*` イベント ({@link listenScriptStream}) で届き、`cancelStream` で
   * 中断できる。読み取り専用ガードは文ごとにバックエンドで強制される。
   */
  runSqlScript: (params: {
    sessionId: string;
    streamId: string;
    database?: string | null;
    path: string;
    options: ScriptOptions;
  }) =>
    invoke<void>("run_sql_script", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      database: params.database ?? null,
      path: params.path,
      options: params.options,
    }),

  /**
   * エディタの複数文 SQL をまとめて実行する (#1256)。文の分割・読み取り専用ガード・
   * 実行・SELECT のプレビュー行 (`previewRows` 件で取得を打ち切り) までバックエンドが
   * 行い、結果は {@link listenBatchStream} の Channel へ 150ms 間引きでまとめて届く。
   * 明示トランザクション中は各文を同じ接続で実行する。`cancelStream` で中断できる。
   */
  runSqlBatch: (params: {
    sessionId: string;
    streamId: string;
    database?: string | null;
    sql: string;
    stopOnError: boolean;
    previewRows: number;
  }) => {
    const channel = batchStreamChannels.get(params.streamId);
    if (!channel) {
      throw new Error(
        `runSqlBatch: listenBatchStream(streamId) must be awaited before invoking (streamId="${params.streamId}")`,
      );
    }
    return invoke<void>("run_sql_batch", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      database: params.database ?? null,
      sql: params.sql,
      stopOnError: params.stopOnError,
      previewRows: params.previewRows,
      onEvent: channel,
    });
  },
};
