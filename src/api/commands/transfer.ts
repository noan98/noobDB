// `src-tauri/src/commands/transfer.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import type { TransferRequest } from "../tauri";

export const transferCommands = {

  /**
   * 接続間データ転送 (#986)。ソース接続のテーブル全件 (`sourceTable`) か単一の
   * 読み取り専用クエリ (`sourceSql`) を、ターゲット接続のテーブルへスキーマ +
   * データごとコピーする。進捗は `transfer-stream:*` イベント
   * ({@link listenTransferStream}) で届き、`cancelStream` で中断できる。
   * ターゲットが読み取り専用プロファイルならバックエンドが拒否する。
   */
  transferData: (streamId: string, request: TransferRequest) =>
    invoke<void>("transfer_data", { streamId, request }),
};
