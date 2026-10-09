// AI 機能の入口を出してよいか (#691): 設定で有効 かつ API キーが登録済み。
// キーの有無は共有ストア (`aiKeyStore`) が持ち、設定画面の保存 / 削除で即時に更新される。

import { useSettings } from "../settings";
import { useAiKeyPresent } from "./aiKeyStore";

export function useAiAvailable(): boolean {
  const enabled = useSettings().ai.enabled;
  const hasKey = useAiKeyPresent();
  return enabled && hasKey;
}
