/**
 * アクティブ接続コンテキスト (#466) の純ロジック。TitleBar は Tauri の
 * `getCurrentWindow()` をモジュール読み込み時に呼ぶためテスト環境で import できない。
 * 副作用のないこの部分を分離し、`connectionContext.test.ts` で単体テストする。
 */

export interface TitleBarConnection {
  name: string;
  /** プロファイルの色 (`null` ならアクセント既定)。 */
  color: string | null;
  isProduction: boolean;
}

/**
 * タイトルバー下端のアクセント帯の色を決める。本番接続は危険色を最優先し、通常接続は
 * プロファイル色 (未設定ならワークスペースアクセント)、未接続は透明 (帯なし)。色弱配慮の
 * ため色は補助で、本番はテキストラベルを併用する (描画側)。
 */
export function connectionBandColor(connection: TitleBarConnection | null | undefined): string {
  if (connection?.isProduction) return "var(--status-error)";
  if (connection) return connection.color ?? "var(--ws-accent)";
  return "transparent";
}
