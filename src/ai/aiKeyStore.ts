// API キーの有無を持つ小さな共有ストア (#691)。キー本体は持たない (OS keyring のみ)。
// 設定画面での保存 / 削除をアプリ全体の入口 (`useAiAvailable`) へ即時に伝えるために使う。

import { useSyncExternalStore } from "react";
import { api } from "../api/tauri";

let hasKey = false;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** キーの有無を更新する (保存 / 削除の成功後に呼ぶ)。 */
export function setAiKeyPresent(v: boolean): void {
  loaded = true;
  if (hasKey === v) return;
  hasKey = v;
  emit();
}

/** IPC で現在の有無を読み直す。取得失敗は現状維持。 */
export async function refreshAiKeyPresent(): Promise<void> {
  try {
    setAiKeyPresent(await api.hasAiApiKey());
  } catch {
    /* 取得できなければ現状維持 */
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  // 初回の購読時に一度だけ読み込む。
  if (!loaded) {
    loaded = true;
    void refreshAiKeyPresent();
  }
  return () => {
    listeners.delete(l);
  };
}

export function useAiKeyPresent(): boolean {
  return useSyncExternalStore(subscribe, () => hasKey, () => false);
}

/** テスト用: ストアを初期状態へ戻す。 */
export function resetAiKeyStoreForTest(): void {
  hasKey = false;
  loaded = false;
  listeners.clear();
}
