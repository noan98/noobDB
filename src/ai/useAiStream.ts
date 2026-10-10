// AI ストリーミング要求の共通フック (#1470)。
// 画面ごとにコピーされていた「購読 → 要求 → 中止 → 登録前に中止されたときの取り直し →
// アンマウント時の後始末 → 完了時のパース」をここに集約する。受信中の本文と経過秒数も
// 返すので、画面は `AiStreamProgress` に渡すだけで途中経過を出せる。
//
// 後続の拡張を見越した形にしてある:
// - `start` はリクエスト引数 (task / system / prompt / settings / format) をそのまま受け取る。
//   会話の追い質問など、呼び出し側が組み立てた引数をそのまま流せる。
// - 完了イベント (`ai-stream:done`) は加工せずに `done` として保持して返す
//   (応答モデル・フォールバック有無・トークン使用量)。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { recordAiUsage } from "./aiUsageStore";
import { api, listenAiStream, type AiDoneEvent } from "../api/tauri";

/** `run_ai_request` に渡す引数 (ストリーム ID はフックが採番する)。 */
export type AiStreamRequest = Omit<Parameters<typeof api.runAiRequest>[0], "streamId">;

export interface AiStreamDone<T> {
  /** 受信した本文の全文。 */
  text: string;
  /** `parse` を渡したときのパース結果。渡していなければ `undefined`。 */
  parsed: T;
  /** 完了イベント (モデル・フォールバック・使用量)。 */
  event: AiDoneEvent;
}

export interface AiStreamFailure {
  message: string;
  /** `AppError.kind`。IPC 自体が失敗したときは `"invoke"`。 */
  kind: string;
  /** 拒否 (`aiRefused`)。画面は警告表示に切り替える。 */
  refused: boolean;
}

export interface AiStreamHandlers<T> {
  /** 完了時に本文をパースする。省略すると `parsed` は `undefined`。 */
  parse?: (text: string) => T;
  onDone: (result: AiStreamDone<T>) => void;
  onError: (failure: AiStreamFailure) => void;
  /** 中止された (登録前に中止されて要求を送らなかった場合を含む)。 */
  onCancelled: () => void;
}

export interface UseAiStreamOptions {
  /** ストリーム ID の接頭辞 (ログでどの画面か分かるようにする)。 */
  idPrefix: string;
}

export interface UseAiStream {
  /**
   * 二重実行を同期的に弾く。true なら確保できた (以降 `start` / `release` で必ず解放する)。
   * 確認ダイアログやスキーマ取得など、`start` 前の待ち時間も含めて守るために分けてある。
   */
  acquire: () => boolean;
  /** `start` に進まず取りやめるときに `acquire` を戻す。 */
  release: () => void;
  /** コンポーネントがマウント中か (非同期の準備処理の後で確認する)。 */
  isMounted: () => boolean;
  /** 購読 → 要求を行う。結果は `handlers` に届く。`acquire` 済みであること。 */
  start: <T = undefined>(request: AiStreamRequest, handlers: AiStreamHandlers<T>) => Promise<void>;
  /** 中止する。登録前の中止は登録後に取り直す。 */
  cancel: () => void;
  /**
   * 実行中の要求を中止して結果を捨てる (入力が差し替わったときなど)。購読を外すので
   * `handlers` はもう呼ばれず、実行権も解放される。
   */
  reset: () => void;
  /** 受信中か。 */
  running: boolean;
  /** 受信済みの本文 (構造化出力のときは途中までの JSON)。 */
  text: string;
  /** 開始からの経過秒数 (受信中のみ進む)。 */
  elapsedSec: number;
  /** 直近の完了イベント。次の `start` で消える。 */
  done: AiDoneEvent | null;
}

let seq = 0;
function makeStreamId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function useAiStream(options: UseAiStreamOptions): UseAiStream {
  const { idPrefix } = options;
  const [running, setRunning] = useState(false);
  const [text, setText] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [done, setDone] = useState<AiDoneEvent | null>(null);
  const busyRef = useRef(false);
  const streamRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  // 中止が押されたか。ストリーム登録前の中止は cancel_stream が空振りするため、登録後に取り直す。
  const abortRef = useRef(false);
  const startedAtRef = useRef(0);
  // `reset` のたびに進める。進行中の `start` が自分が破棄されたかを判定する。
  const genRef = useRef(0);

  const cancelRemote = useCallback((streamId: string) => {
    void api.cancelStream(streamId).catch(() => {
      /* すでに完了 */
    });
  }, []);

  // 別のストリームに置き換わっている場合は触らない (ID が一致するときだけ解除する)。
  const stopListener = useCallback((streamId: string): boolean => {
    if (streamRef.current !== streamId) return false;
    unlistenRef.current?.();
    unlistenRef.current = null;
    streamRef.current = null;
    busyRef.current = false;
    if (mountedRef.current) setRunning(false);
    return true;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const sid = streamRef.current;
      if (sid) cancelRemote(sid);
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [cancelRemote]);

  // 受信中だけ経過秒数を進める。
  useEffect(() => {
    if (!running) return;
    const tick = () => setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);

  const acquire = useCallback(() => {
    if (busyRef.current) return false;
    busyRef.current = true;
    // 中止フラグは実行権を取った時点で下ろす。start より前 (確認ダイアログ・スキーマ取得中) に
    // 押された中止を start が打ち消さないよう、start ではリセットしない。
    abortRef.current = false;
    // 前回の本文 / 経過秒数 / 完了イベントを持ち越さない (準備中に古い内容が「受信中」に出ない)。
    setText("");
    setElapsedSec(0);
    setDone(null);
    return true;
  }, []);

  const release = useCallback(() => {
    busyRef.current = false;
  }, []);

  const isMounted = useCallback(() => mountedRef.current, []);

  const cancel = useCallback(() => {
    abortRef.current = true;
    const sid = streamRef.current;
    if (sid) cancelRemote(sid);
  }, [cancelRemote]);

  const reset = useCallback(() => {
    genRef.current += 1;
    abortRef.current = true;
    const sid = streamRef.current;
    if (sid) cancelRemote(sid);
    unlistenRef.current?.();
    unlistenRef.current = null;
    streamRef.current = null;
    busyRef.current = false;
    setRunning(false);
    setDone(null);
  }, [cancelRemote]);

  const start = useCallback(
    async <T = undefined>(request: AiStreamRequest, handlers: AiStreamHandlers<T>): Promise<void> => {
      const streamId = makeStreamId(idPrefix);
      const gen = genRef.current;
      streamRef.current = streamId;
      startedAtRef.current = Date.now();
      let body = "";
      setText("");
      setDone(null);
      setElapsedSec(0);
      setRunning(true);
      const fail = (message: string, kind: string) => {
        if (!stopListener(streamId)) return;
        handlers.onError({ message, kind, refused: kind === "aiRefused" });
      };
      try {
        const unlisten = await listenAiStream(streamId, {
          onDelta: (e) => {
            if (streamRef.current !== streamId) return;
            body += e.text;
            if (mountedRef.current) setText(body);
          },
          onDone: (e) => {
            if (!stopListener(streamId)) return;
            // 使用量の累計 (#1474) はここ 1 か所で加算する。画面側では加算しない。
            recordAiUsage(e);
            setDone(e);
            handlers.onDone({
              text: body,
              parsed: (handlers.parse ? handlers.parse(body) : undefined) as T,
              event: e,
            });
          },
          onError: (e) => fail(e.error, e.kind),
          onCancelled: () => {
            if (!stopListener(streamId)) return;
            handlers.onCancelled();
          },
        });
        if (!mountedRef.current || genRef.current !== gen) {
          unlisten();
          if (mountedRef.current) return;
          streamRef.current = null;
          busyRef.current = false;
          return;
        }
        unlistenRef.current = unlisten;
        // 購読を待つ間に中止された場合は、リクエストを送らずに終える。
        if (abortRef.current) {
          stopListener(streamId);
          handlers.onCancelled();
          return;
        }
        await api.runAiRequest({ ...request, streamId });
        // 登録前の中止 / アンマウントは cancel_stream が空振りするので、登録が済んだ今あらためて取り消す。
        if (abortRef.current || !mountedRef.current || genRef.current !== gen) cancelRemote(streamId);
      } catch (e) {
        // AppError (`kind` を持つ) ならそれを引き継ぎ、無ければ IPC 失敗として扱う。
        const kind = (e as { kind?: unknown } | null)?.kind;
        fail(String(e), typeof kind === "string" ? kind : "invoke");
      }
    },
    [idPrefix, stopListener, cancelRemote],
  );

  return useMemo(
    () => ({ acquire, release, isMounted, start, cancel, reset, running, text, elapsedSec, done }),
    [acquire, release, isMounted, start, cancel, reset, running, text, elapsedSec, done],
  );
}
