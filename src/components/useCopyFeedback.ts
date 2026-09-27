import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { copyToClipboard } from "./clipboard";
import { useToast } from "./Toast";

/**
 * コピー確認表示を出しておく既定時間 (ms)。「コピー → 1500ms だけチェック表示 →
 * 自動で戻る」という挙動の単一ソース (#1158)。
 */
export const COPY_FEEDBACK_DURATION_MS = 1500;

export interface CopyFeedback {
  /**
   * 直近のコピーが成功し、確認表示中かどうか。`COPY_FEEDBACK_DURATION_MS` 経過後
   * 自動で `false` に戻る。
   */
  copied: boolean;
  /**
   * テキストをクリップボードへコピーする。成功したら `copied` を一定時間 `true`
   * にし、失敗したらトースト (`clipboardCopyFailed`) を出す (`copied` は変化
   * しない)。戻り値は成否。
   */
  copy: (text: string) => Promise<boolean>;
}

/**
 * 「クリップボードへコピー → 1500ms だけ確認表示 → 自動で戻る」を管理する共通
 * フック (#1158)。unmount 時のタイマー cleanup と失敗時のトースト表示を内包する。
 *
 * `ResultGrid` / `SchemaExportModal` / `ExportModal` / `ConnectionForm` /
 * `CellValueViewer` / `QueryBuilder` の単一ターゲットのコピー確認に使う。一覧の
 * 行単位 (`HistoryList` の `copiedId`) には `useKeyedCopyFeedback` を使う。
 * 見た目は `CopyButton` と組み合わせる (コピー対象の構築ロジックは呼び出し側の
 * ままでよく、`copy()` にはコピーしたい文字列を渡すだけでよい)。
 */
export function useCopyFeedback(durationMs: number = COPY_FEEDBACK_DURATION_MS): CopyFeedback {
  const t = useT();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyToClipboard(text);
      if (!ok) {
        toast.error(t("clipboardCopyFailed"));
        return false;
      }
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), durationMs);
      return true;
    },
    [durationMs, t, toast],
  );

  return { copied, copy };
}

export interface KeyedCopyFeedback<K> {
  /** 直近コピーに成功した項目のキー。確認表示中のみ非 `null`。 */
  copiedKey: K | null;
  /** 指定したキーの項目をコピーする (一覧の行単位コピーなど)。 */
  copy: (key: K, text: string) => Promise<boolean>;
}

/**
 * `useCopyFeedback` の複数項目版。一覧の行など「同時に確認表示できるのは 1 件
 * だけ」のケース (`HistoryList` の `copiedId`) に使う。
 */
export function useKeyedCopyFeedback<K>(
  durationMs: number = COPY_FEEDBACK_DURATION_MS,
): KeyedCopyFeedback<K> {
  const t = useT();
  const toast = useToast();
  const [copiedKey, setCopiedKey] = useState<K | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(
    async (key: K, text: string) => {
      const ok = await copyToClipboard(text);
      if (!ok) {
        toast.error(t("clipboardCopyFailed"));
        return false;
      }
      setCopiedKey(key);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopiedKey(null), durationMs);
      return true;
    },
    [durationMs, t, toast],
  );

  return { copiedKey, copy };
}
