// `src-tauri/src/commands/cell_blob.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke, parseBinaryResponse } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { CellValue, CellBlobProbe, BlobFolderSaveResult } from "../tauri";

export const cellBlobCommands = {

  /**
   * 主キーで 1 セルの生バイトを取得する (#1148)。グリッドの表示値ではなくサーバの値を
   * 引き直すので、画像プレビューは常に完全な内容になる。生バイト列をそのまま
   * 受け取る (16 進文字列や JSON 配列を経由しない、#1258)。NULL セルは reject
   * されるので、先に {@link api.probeCellBlob} で NULL / サイズ / 種別を確認すること。
   * 該当行が 1 行に定まらない場合も reject される。
   */
  fetchCellBytes: (
    sessionId: string,
    database: string | null,
    table: string,
    column: string,
    key: { column: string; value: CellValue }[],
  ) =>
    invoke<unknown>("fetch_cell_bytes", { sessionId, database, table, column, key }).then(
      (r) => parseBinaryResponse(r, "fetch_cell_bytes"),
    ),

  /**
   * BLOB セルの probe (#1258): 本体を転送せず、サーバ側の長さ関数と先頭 16 バイトから
   * サイズと種別 (MIME / 拡張子 / 画像か) だけを返す。NULL は null。
   */
  probeCellBlob: (
    sessionId: string,
    database: string | null,
    table: string,
    column: string,
    key: { column: string; value: CellValue }[],
  ) =>
    invoke<CellBlobProbe | null>("probe_cell_blob", {
      sessionId,
      database,
      table,
      column,
      key,
    }).then((r) => parseResponse(schemas.cellBlobProbe.nullable(), r, "probe_cell_blob")),

  /**
   * 主キーで 1 セルの生バイトを取得し、そのまま `path` のファイルへ書き出す (#1258)。
   * DB → ファイルが Rust 内で完結し、BLOB は IPC を通らない。書き込んだバイト数を返す。
   */
  saveCellToFile: (
    sessionId: string,
    database: string | null,
    table: string,
    column: string,
    key: { column: string; value: CellValue }[],
    path: string,
  ) =>
    invoke<number>("save_cell_to_file", {
      sessionId,
      database,
      table,
      column,
      key,
      path,
    }).then((r) => parseResponse(schemas.numberResponse, r, "save_cell_to_file")),

  /**
   * 複数行の BLOB 列を主キー由来のファイル名で `folder` へ一括保存する (#1539)。
   * `keys` は行ごとの主キー。DB → ファイルは Rust 内で完結し、NULL と上限超過の行は
   * 飛ばし、拡張子は種別から決め、既存ファイルは上書きしない。件数を集計して返す。
   */
  saveCellsToFolder: (
    sessionId: string,
    database: string | null,
    table: string,
    column: string,
    keys: { column: string; value: CellValue }[][],
    folder: string,
  ) =>
    invoke<BlobFolderSaveResult>("save_cells_to_folder", {
      sessionId,
      database,
      table,
      column,
      keys,
      folder,
    }).then((r) => parseResponse(schemas.blobFolderSaveResult, r, "save_cells_to_folder")),

  /**
   * ファイルをバイナリで読み、生バイト列を返す (#1148、BLOB への
   * 書き戻し用。#1258 で 16 進文字列から生バイトへ)。サイズ上限 (16 MiB) を超える
   * ファイルは reject される。
   */
  readBinaryFile: (path: string) =>
    invoke<unknown>("read_binary_file", { path }).then((r) =>
      parseBinaryResponse(r, "read_binary_file"),
    ),
};
