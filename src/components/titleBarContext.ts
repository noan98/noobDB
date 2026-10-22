/**
 * アクティブ接続コンテキストの純ロジック。TitleBar は Tauri の
 * `getCurrentWindow()` をモジュール読み込み時に呼ぶためテスト環境で import できない。
 * 副作用のないこの部分を分離し、`connectionContext.test.ts` で単体テストする。
 */

import type { ConnectionStatus } from "../reconnect";
import { SANDBOX_BAND_COLOR } from "../sandbox";
import { semanticColorVar } from "../semanticColors";

export interface TitleBarConnection {
  name: string;
  /** プロファイルの色 (`null` ならアクセント既定)。 */
  color: string | null;
  isProduction: boolean;
  /**
   * DB エンジン (`mysql` / `postgres` / `sqlite`、#1769)。プロファイルの `driver` をそのまま渡す。
   * 省略または未知のドライバならエンジングリフは出さない。
   */
  driver?: string;
  /**
   * サンドボックス (壊せる砂場、#747) のセッションかどうか。true の間は帯・
   * バッジを専用色 (`SANDBOX_BAND_COLOR`) にして「接続先へは何の影響も無い
   * ローカルコピーである」ことを常時明示する。
   */
  isSandbox?: boolean;
  /**
   * ライブ接続の状態 (#600)。省略時は `connected` 扱い。`reconnecting` の間は
   * 帯を警告色にし、テキストバッジ (描画側) を併用して「再接続中」をアンビエントに示す。
   */
  status?: ConnectionStatus;
}

/**
 * タイトルバー下端のアクセント帯の色を決める。自動再接続中 (`reconnecting`) は
 * 警告色を最優先して状態を即座に伝え、本番接続は危険色、サンドボックスは専用の
 * violet 色、それ以外の通常接続はプロファイル色 (未設定ならワークスペース
 * アクセント)、未接続は透明 (帯なし) にする。色弱配慮のため色は補助で、本番・
 * 再接続中・サンドボックスはテキストラベルを併用する (描画側)。
 */
export function connectionBandColor(connection: TitleBarConnection | null | undefined): string {
  if (connection?.status === "reconnecting") return semanticColorVar("warning", "solid");
  if (connection?.isProduction) return semanticColorVar("danger", "solid");
  if (connection?.isSandbox) return SANDBOX_BAND_COLOR;
  if (connection) return connection.color ?? "var(--ws-accent)";
  return "transparent";
}

/** アプリ名 (未接続時のウィンドウタイトル、接続中の末尾)。 */
const APP_WINDOW_TITLE = "noobDB";

/** ウィンドウタイトルの先頭に付ける状態ラベル (i18n 済みの文字列を呼び出し側が渡す)。 */
export interface WindowTitleLabels {
  production: string;
  sandbox: string;
  reconnecting: string;
}

/**
 * OS のタスクバー / Alt+Tab に出るウィンドウタイトル (#1631)。未接続は `noobDB` のみ。接続中は
 * `[本番] 接続名 — noobDB` のように、本番・サンドボックス・再接続中を角括弧で前置して、別ウィンドウと
 * 取り違えやすい本番接続を一目で見分けられるようにする。
 */
export function windowTitleFor(
  connection: Pick<TitleBarConnection, "name" | "isProduction" | "isSandbox" | "status"> | null | undefined,
  labels: WindowTitleLabels,
): string {
  if (!connection) return APP_WINDOW_TITLE;
  const tags: string[] = [];
  if (connection.isProduction) tags.push(labels.production);
  if (connection.isSandbox) tags.push(labels.sandbox);
  if (connection.status === "reconnecting") tags.push(labels.reconnecting);
  const prefix = tags.map((t) => `[${t}] `).join("");
  return `${prefix}${connection.name} — ${APP_WINDOW_TITLE}`;
}
