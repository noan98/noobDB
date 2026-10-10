// AI 設定画面を開く要求 (#1475)。深い階層の案内リンク (AiSetupHint) から App の
// openFullView("settings") を呼ぶための橋渡しで、window イベントで疎結合にする。

export const OPEN_AI_SETTINGS_EVENT = "noobdb:open-ai-settings";

/** 設定画面を開いて AI セクションへスクロールする。何も送信しない。 */
export function requestOpenAiSettings(): void {
  window.dispatchEvent(new Event(OPEN_AI_SETTINGS_EVENT));
}
