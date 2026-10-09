import type { Channel } from "@tauri-apps/api/core";

// Tauri Channel の受け渡しレジストリ (#1096)。`../tauri.ts` の `listen*` が Channel を
// 生成して `streamId` (broadcast は `runId`) ごとに登録し、`./commands/*.ts` の
// ラッパーが invoke 時に取り出して `onEvent` 引数として渡す。両者が別ファイルに
// 分かれたので、共有する Map だけをここに置く。

/** `streamId` → 生成済み Channel。`invoke` 呼び出し時に `onEvent` 引数として渡す
 *  ためだけの一時的な受け渡し場所で、`listenQueryStream` が書き込み、
 *  `api.runQueryStream` が読み出す。`unlisten` (detach) 時にエントリを消す。 */
export const queryStreamChannels = new Map<string, Channel<unknown>>();
export const previewStreamChannels = new Map<string, Channel<unknown>>();
export const batchStreamChannels = new Map<string, Channel<unknown>>();
export const whereUsedChannels = new Map<string, Channel<unknown>>();
export const dataSearchChannels = new Map<string, Channel<unknown>>();
/** `runId` → 環境横断実行 (broadcast) の Channel。 */
export const broadcastChannels = new Map<string, Channel<unknown>>();
