// `src-tauri/src/commands/schema_drift.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { SchemaDriftGeneration, SchemaDriftSummary, SchemaDriftCapture } from "../tauri";

export const schemaDriftCommands = {

  // --- スキーマドリフト (#736 / #1260) ---

  /**
   * `database` のスキーマ (テーブル・列・インデックス) を Rust 内で一括取得して世代として
   * 記録し、前世代からの変化サマリだけを返す。メタデータの読み取りのみ。
   */
  schemaDriftCapture: (sessionId: string, profileId: string, database: string) =>
    invoke<SchemaDriftCapture>("schema_drift_capture", { sessionId, profileId, database }).then(
      (r) => parseResponse(schemas.schemaDriftCapture, r, "schema_drift_capture"),
    ),

  /** プロファイルの保存済み世代 (新しい順)。セッション不要。 */
  schemaDriftList: (profileId: string) =>
    invoke<SchemaDriftGeneration[]>("schema_drift_list", { profileId }).then((r) =>
      parseResponse(schemas.schemaDriftGenerationArray, r, "schema_drift_list"),
    ),

  /** 2 世代間の変化サマリ。どちらかが省略済み / 存在しないときは null。セッション不要。 */
  schemaDriftCompare: (profileId: string, fromId: string, toId: string) =>
    invoke<SchemaDriftSummary | null>("schema_drift_compare", { profileId, fromId, toId }).then(
      (r) => parseResponse(schemas.schemaDriftSummaryOrNull, r, "schema_drift_compare"),
    ),

  /** 旧 localStorage の世代 (新しい順) をストアへ一度だけ取り込む。取り込んだ件数を返す。 */
  schemaDriftImportLegacy: (profileId: string, generations: unknown[]) =>
    invoke<number>("schema_drift_import_legacy", { profileId, generations }).then((r) =>
      parseResponse(schemas.numberResponse, r, "schema_drift_import_legacy"),
    ),
};
