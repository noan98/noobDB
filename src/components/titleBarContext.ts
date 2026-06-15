/**
 * アクティブ接続コンテキストの純ロジック。TitleBar は Tauri の
 * `getCurrentWindow()` をモジュール読み込み時に呼ぶためテスト環境で import できない。
 * 副作用のないこの部分を分離し、`connectionContext.test.ts` で単体テストする。
 */

import type { ConnectionStatus } from "../reconnect";

export interface TitleBarConnection {
  name: string;
  /** プロファイルの色 (`null` ならアクセント既定)。 */
  color: string | null;
  isProduction: boolean;
  /**
   * ライブ接続の状態 (#600)。省略時は `connected` 扱い。`reconnecting` の間は
   * 帯を警告色にし、テキストバッジ (描画側) を併用して「再接続中」をアンビエントに示す。
   */
  status?: ConnectionStatus;
}

/**
 * タイトルバー下端のアクセント帯の色を決める。自動再接続中 (`reconnecting`) は
 * 警告色を最優先して状態を即座に伝え、それ以外は本番接続を危険色、通常接続は
 * プロファイル色 (未設定ならワークスペースアクセント)、未接続は透明 (帯なし) にする。
 * 色弱配慮のため色は補助で、本番・再接続中はテキストラベルを併用する (描画側)。
 */
export function connectionBandColor(connection: TitleBarConnection | null | undefined): string {
  if (connection?.status === "reconnecting") return "var(--status-warning)";
  if (connection?.isProduction) return "var(--status-error)";
  if (connection) return connection.color ?? "var(--ws-accent)";
  return "transparent";
}
