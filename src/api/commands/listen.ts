// `src-tauri/src/commands/listen.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import { pgListenChannels } from "../streamChannels";

export const listenCommands = {
  /**
   * PostgreSQL の `LISTEN` / `NOTIFY` 監視 (#2019) を始める。専用接続を 1 本開いて `channels` を
   * `LISTEN` し、通知を {@link listenPgListenStream} の Channel へ流し続ける。停止は
   * `cancelStream(streamId)`。非対応ドライバは Channel に `unsupported` が届く。
   */
  startPgListen: (params: { sessionId: string; streamId: string; channels: string[] }) => {
    const channel = pgListenChannels.get(params.streamId);
    if (!channel) {
      return Promise.reject(
        new Error(
          `startPgListen: listenPgListenStream(streamId) must be awaited before invoking (streamId="${params.streamId}")`,
        ),
      );
    }
    return invoke<void>("start_pg_listen", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      channels: params.channels,
      onEvent: channel,
    });
  },
  /** 稼働中の監視にチャンネルを追加して `LISTEN` する。 */
  pgListenAddChannel: (streamId: string, channel: string) =>
    invoke<void>("pg_listen_add_channel", { streamId, channel }),
  /** 稼働中の監視からチャンネルを外して `UNLISTEN` する。 */
  pgListenRemoveChannel: (streamId: string, channel: string) =>
    invoke<void>("pg_listen_remove_channel", { streamId, channel }),
};
