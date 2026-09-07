// Tauri IPC のフェイクランタイム (ブラウザモードのシナリオテスト用)。
//
// `setup.browser.ts` の最小スタブ (「呼ばれても落ちない」だけを保証) と違い、
// こちらは `window.__TAURI_INTERNALS__` を **本物の `@tauri-apps/api` が期待する
// プロトコル**で差し替える:
//
//   - `invoke(cmd, args)` はコマンド名ごとに登録されたハンドラへディスパッチする。
//     `src/api/tauri.ts` の型付きラッパと zod 検証は実コードのまま通るので、
//     モック応答の形が実 IPC とズレるとテストが落ちて気付ける。
//   - `plugin:event|listen` / `plugin:event|unlisten` を実装し、`emitTauriEvent`
//     でバックエンド発のイベント (`csv-import:*` 等、名前付きイベントのまま
//     残っているもの) を任意のタイミングで注入できる。
//   - Tauri の `Channel` (#1096 以降の query/preview ストリーム転送) もこの
//     `transformCallback` 経由で動く実装なので追加の配線は要らない。
//     `emitChannelMessage` で任意のタイミングでメッセージを注入できる。
//     `listenQueryStream`/`listenPreviewStream` の zod 検証・streamId ごとの
//     Channel レジストリも実コードが動く。
//
// これにより「ストリーミングの段階表示」「キャンセル後はイベントが届かない」の
// ような イベント順序依存のシナリオを、実 DB なしで決定的に再現できる (#564)。
type InvokeArgs = Record<string, unknown>;
type CommandHandler = (args: InvokeArgs) => unknown;

interface MockTauriInternals {
  invoke: (cmd: string, args?: InvokeArgs, options?: unknown) => Promise<unknown>;
  transformCallback: (cb?: (response: unknown) => void, once?: boolean) => number;
  unregisterCallback?: (id: number) => void;
  metadata?: { currentWindow: { label: string }; currentWebview: { label: string } };
}

// `__TAURI_EVENT_PLUGIN_INTERNALS__` (unlisten が同期参照する内部フック) は
// `@tauri-apps/api/event.d.ts` がグローバル宣言済みなので、ここでは宣言しない。
declare global {
  interface Window {
    __TAURI_INTERNALS__?: MockTauriInternals;
  }
}

// transformCallback で登録されたコールバック (id → fn)。イベント配送に使う。
const callbacks = new Map<number, (response: unknown) => void>();
// `plugin:event|listen` で購読されたイベント (callback id → イベント名)。
const listeners = new Map<number, string>();
// Channel ごとの次に送るべきメッセージ index (`emitChannelMessage` が使う)。
// `@tauri-apps/api/core.js` の `Channel` はメッセージに `{ index, message }` の
// 昇順 index を要求し (順序保証・並べ替えのため)、index を渡さない/揃わないと
// 内部のペンディングキューに滞留したまま `onmessage` へ届かない。
const channelIndices = new Map<number, number>();
// アプリコマンドのハンドラ (コマンド名 → ハンドラ)。
const commandHandlers = new Map<string, CommandHandler>();
// アプリコマンドの呼び出し履歴 (アサーション用)。イベントプラグインは含まない。
let invocations: { cmd: string; args: InvokeArgs }[] = [];
let nextCallbackId = 0;

function removeListener(eventId: number): void {
  listeners.delete(eventId);
  callbacks.delete(eventId);
}

/**
 * フェイク Tauri ランタイムをインストールし、内部状態をリセットする。各テストの
 * 冒頭 (beforeEach) で呼ぶ。`setup.browser.ts` の素朴なスタブを上書きする。
 */
export function installTauriMock(): void {
  callbacks.clear();
  listeners.clear();
  channelIndices.clear();
  commandHandlers.clear();
  invocations = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args = {}) => {
      if (cmd === "plugin:event|listen") {
        const id = args.handler as number;
        listeners.set(id, args.event as string);
        // listen はこの戻り値を eventId として unlisten に渡す。callback id を
        // そのまま使えば 1 つの Map で対応が取れる。
        return id;
      }
      if (cmd === "plugin:event|unlisten") {
        removeListener(args.eventId as number);
        return null;
      }
      invocations.push({ cmd, args });
      const handler = commandHandlers.get(cmd);
      if (handler) return handler(args);
      // Tauri 本体プラグイン (window / webview 等) の呼び出しは無害な null。
      if (cmd.startsWith("plugin:")) return null;
      // アプリコマンドのハンドラ漏れはテストの組み立てミスなので明確に落とす。
      throw new Error(`tauriMock: no handler registered for command "${cmd}"`);
    },
    transformCallback: (cb) => {
      nextCallbackId += 1;
      if (cb) callbacks.set(nextCallbackId, cb);
      return nextCallbackId;
    },
    unregisterCallback: (id) => {
      callbacks.delete(id);
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event, eventId) => removeListener(eventId),
  };
}

/** コマンドのハンドラを登録する (同名は上書き)。 */
export function onCommand(cmd: string, handler: CommandHandler): void {
  commandHandlers.set(cmd, handler);
}

/**
 * バックエンド発のイベントを購読中のリスナーへ配送する。ペイロードは
 * `listen` ハンドラに `{ event, id, payload }` として渡る (本物と同じ形)。
 */
export function emitTauriEvent(event: string, payload: unknown): void {
  // 配送中の unlisten (コールバック内で購読解除するパターン) に備えてスナップショット。
  for (const [id, name] of [...listeners]) {
    if (name === event) callbacks.get(id)?.({ event, id, payload });
  }
}

/** 指定コマンドの呼び出し引数一覧 (呼び出し順)。 */
export function invocationsOf(cmd: string): InvokeArgs[] {
  return invocations.filter((i) => i.cmd === cmd).map((i) => i.args);
}

/**
 * `Channel<T>` 引数の最小形。`@tauri-apps/api/core` の `invoke()` は引数を
 * 変換せずそのまま `window.__TAURI_INTERNALS__.invoke` へ渡すため (core.js
 * 参照)、`onCommand` ハンドラが受け取る `args.onEvent` は生の `Channel`
 * インスタンスそのもの — `.id` が `transformCallback` (このモックでは
 * `callbacks` map のキー) の登録 id になる。
 */
export interface ChannelLike {
  id: number;
}

/**
 * `run_query_stream` / `preview_query_stream` (#1096) など `Channel` 引数を
 * 取るコマンドに対して、その Channel へ直接メッセージを送る。`emitTauriEvent`
 * の Channel 版。`channel` は登録済みハンドラが受け取った `args.onEvent` を
 * そのまま渡す (`onCommand` のコールバック引数から取り出す)。
 *
 * `@tauri-apps/api/core.js` の `Channel` は `{ index, message }` の昇順
 * index を要求する (順序保証のための内部キュー) ので、ここで channel ごとに
 * 自動採番する — 呼び出し側は生のメッセージだけ渡せばよい。
 */
export function emitChannelMessage(channel: ChannelLike, message: unknown): void {
  const index = channelIndices.get(channel.id) ?? 0;
  channelIndices.set(channel.id, index + 1);
  callbacks.get(channel.id)?.({ index, message });
}
