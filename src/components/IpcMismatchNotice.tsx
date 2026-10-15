import { useEffect, useState, useSyncExternalStore } from "react";

import {
  buildIpcMismatchDiagnosticText,
  dismissIpcMismatch,
  getIpcMismatchState,
  subscribeIpcMismatch,
} from "../api/ipcDiagnostics";
import { useT } from "../i18n";
import { getCurrentAppVersion } from "../updater";
import { Callout } from "./Callout";
import { useCopyFeedback } from "./useCopyFeedback";
import { Button } from "./ui";

/**
 * IPC レスポンスの検証失敗が複数のコマンドで続いたときの警告 (#1622)。アプリ本体と
 * バックエンドの版がずれている可能性を知らせ、診断テキストをコピーできるようにする。
 * 同じセッションで 1 回だけ出し、閉じたら再表示しない。何も起きていなければ描画しない。
 */
export function IpcMismatchNotice() {
  const t = useT();
  const state = useSyncExternalStore(subscribeIpcMismatch, getIpcMismatchState, getIpcMismatchState);
  const { copied, copy } = useCopyFeedback();
  const [version, setVersion] = useState<string | null>(null);
  const active = state.active;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void getCurrentAppVersion().then((v) => {
      if (alive) setVersion(v);
    });
    return () => {
      alive = false;
    };
  }, [active]);
  if (!active) return null;
  const text = buildIpcMismatchDiagnosticText(state.failures, version);
  return (
    <Callout
      tone="warning"
      role="status"
      title={t("ipcMismatchTitle")}
      data-testid="ipc-mismatch-notice"
      m="2"
      action={
        <>
          <Button type="button" size="sm" variant="secondary" onClick={() => void copy(text)}>
            {copied ? t("ipcMismatchCopied") : t("ipcMismatchCopy")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={dismissIpcMismatch}>
            {t("ipcMismatchDismiss")}
          </Button>
        </>
      }
    >
      {t("ipcMismatchBody", { count: state.failures.length })}
    </Callout>
  );
}
