// jsdom コンポーネントレンダリングテスト (#604) 共通のフィクスチャ。
// props 起点のマウント検証で使う最小構成の値を組み立てる。バックエンド依存は
// 各テスト側で `../api/tauri` を `vi.mock` して差し替える方針で、ここでは
// 純粋なデータ (プロファイル / カラム / 行) の生成のみを担う。
import type { CellValue, Column, ConnectionProfile } from "../../api/tauri";

/**
 * テスト用の接続プロファイルを組み立てる。全必須フィールドを埋め、任意の
 * フィールドを `overrides` で差し替えられる。既定は SQLite 以外 (MySQL) の
 * TCP 接続を想定した無害な値。
 */
export function makeProfile(
  overrides: Partial<ConnectionProfile> = {},
): ConnectionProfile {
  return {
    id: "p-test",
    name: "Test DB",
    driver: "mysql",
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    database: "appdb",
    ssh: null,
    group: null,
    color: null,
    is_production: false,
    confirm_writes: false,
    read_only: false,
    skip_history: false,
    file_path: null,
    ...overrides,
  };
}

/** テスト用のカラム定義を組み立てる。 */
export function makeColumn(name: string, type_name = "int"): Column {
  return { name, type_name };
}

/** 代表的な 2 カラム構成。 */
export const SAMPLE_COLUMNS: Column[] = [
  makeColumn("id", "int"),
  makeColumn("name", "varchar"),
];

/** `SAMPLE_COLUMNS` に対応する 2 行分のセル値。 */
export const SAMPLE_ROWS: CellValue[][] = [
  [1, "alice"],
  [2, "bob"],
];
