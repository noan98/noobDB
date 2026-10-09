// AI 機能の入口を出してよいか (#691): 設定で有効 かつ API キーが登録済み。
// キーは OS keyring にあり、有無は IPC (`hasAiApiKey`) でしか分からない。取得失敗は「無し」扱い。

import { useEffect, useState } from "react";
import { api } from "../api/tauri";
import { useSettings } from "../settings";

export function useAiAvailable(): boolean {
  const enabled = useSettings().ai.enabled;
  const [hasKey, setHasKey] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .hasAiApiKey()
      .then((v) => {
        if (alive) setHasKey(v);
      })
      .catch(() => {
        /* 取得できなければ入口は出さない */
      });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return enabled && hasKey;
}
