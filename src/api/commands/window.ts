// `src-tauri/src/commands/window.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";

export const windowCommands = {
  /**
   * ウィンドウタイトルを設定する (#1631)。接続名と本番 / サンドボックスの区別を載せて、OS の
   * タスクバーや Alt+Tab で接続先を判別できるようにする。フロントが window の capability を
   * 増やさずに済むよう Rust コマンド経由で行う。
   */
  setWindowTitle: (title: string) => invoke<void>("set_window_title", { title }),
};
