// `src-tauri/src/commands/window.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";

/** ウィンドウ背景の素材 (#2359)。Rust の `WindowMaterial` (kebab-case) と同じ値。 */
export type WindowMaterial = "none" | "mica" | "mica-alt";

export const windowCommands = {
  /**
   * ウィンドウタイトルを設定する (#1631)。接続名と本番 / サンドボックスの区別を載せて、OS の
   * タスクバーや Alt+Tab で接続先を判別できるようにする。フロントが window の capability を
   * 増やさずに済むよう Rust コマンド経由で行う。
   */
  setWindowTitle: (title: string) => invoke<void>("set_window_title", { title }),
  /**
   * ウィンドウ背景の素材 (Mica / Mica Alt) を適用・解除する (#2359)。`dark` はアプリの実効テーマが
   * 暗いか。効果が実際に敷かれたら true。Windows 11 以外では何もせず false (エラーにしない)。
   * フロントが window の capability を増やさずに済むよう Rust コマンド経由で行う。
   */
  setWindowMaterial: (material: WindowMaterial, dark: boolean) =>
    invoke<boolean>("set_window_material", { material, dark }),
  /** ウィンドウ素材を使える環境 (Windows 11) か。設定画面が項目の有効 / 無効を決めるのに使う。 */
  windowMaterialSupported: () => invoke<boolean>("window_material_supported"),
};
