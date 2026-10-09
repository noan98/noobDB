// `src-tauri/src/commands/file.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";

export const fileCommands = {

  /**
   * ドロップされた `.sql` / `.txt` ファイルの内容を読む。フロントが fs API を
   * 直に叩かずバックエンド経由で読む (capabilities を最小に保つ)。サイズ上限を超える
   * ファイルは reject される。
   */
  readTextFile: (path: string) =>
    invoke<string>("read_text_file", { path }).then((r) =>
      parseResponse(schemas.stringResponse, r, "read_text_file"),
    ),

  /**
   * フロントで生成したバイト列 (チャート/ER 図の PNG・SVG など) を、保存ダイアログで
   * 選んだパスへバックエンド経由で書き出す (capabilities を最小に保つため。#643)。
   * 書き込んだバイト数を返す。バイト列は Tauri の raw ボディでそのまま送る (JSON の
   * 数値配列は約 4 倍に膨らむため。#1258)。パスはヘッダで運ぶので、ヘッダに載せられる
   * よう URL エンコードする (日本語や Windows パスを Rust 側で復元する)。
   */
  writeBinaryFile: (path: string, data: Uint8Array) =>
    invoke<number>("write_binary_file", data, {
      headers: { "x-noobdb-path": encodeURIComponent(path) },
    }).then((r) => parseResponse(schemas.numberResponse, r, "write_binary_file")),

  /**
   * テキスト (SQL・Markdown・JSON など) を UTF-8 で `path` へ書き出す (#1258)。
   * `writeBinaryFile` と同じ上限 (32 MiB)。書き込んだバイト数を返す。
   */
  writeTextFile: (path: string, content: string) =>
    invoke<number>("write_text_file", { path, content }).then((r) =>
      parseResponse(schemas.numberResponse, r, "write_text_file"),
    ),
};
