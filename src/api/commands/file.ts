// `src-tauri/src/commands/file.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { SqlEncodingPreview, SqlFileContent, TextEncodingId } from "../tauri";

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
   * SQL ファイルを文字コード付きで読む (#1535)。`encoding` が `null` / 省略なら BOM →
   * UTF-8 の妥当性 → Shift_JIS / EUC-JP の順に自動判定し、指定があればその文字コードで
   * 読む。不正なバイトは置換せず reject する。戻り値の `encoding` を保存時に渡すと
   * 同じ文字コードで書き戻せる。
   */
  readSqlFile: (path: string, encoding?: TextEncodingId | null) =>
    invoke<SqlFileContent>("read_sql_file", { path, encoding: encoding ?? null }).then((r) =>
      parseResponse(schemas.sqlFileContent, r, "read_sql_file"),
    ),

  /**
   * SQL ファイルの文字コードの自動判定結果と、候補ごとに先頭数 KB を読んだプレビューを返す (#1627)。
   * 判定を誤ったときに、化けていない候補を目で見て選び直すための読み取り専用コマンド。
   * 判定に失敗しても reject せず `detectError` に載せる。
   */
  previewSqlFileEncodings: (path: string) =>
    invoke<SqlEncodingPreview>("preview_sql_file_encodings", { path }).then((r) =>
      parseResponse(schemas.sqlEncodingPreview, r, "preview_sql_file_encodings"),
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
   * テキスト (SQL・Markdown・JSON など) を `path` へ書き出す (#1258)。`encoding` を省略
   * すると BOM なし UTF-8。SQL ファイル (#1535) は `readSqlFile` が返した文字コードを渡して
   * Shift_JIS / EUC-JP / UTF-16 のまま書き戻す。その文字コードで表せない文字があれば
   * reject する。`writeBinaryFile` と同じ上限 (32 MiB)。書き込んだバイト数を返す。
   */
  writeTextFile: (path: string, content: string, encoding?: TextEncodingId | null) =>
    invoke<number>("write_text_file", { path, content, encoding: encoding ?? null }).then((r) =>
      parseResponse(schemas.numberResponse, r, "write_text_file"),
    ),

  /**
   * 書き出し・ダンプの保存先を OS のファイルマネージャで開く (#1631)。`path` はディレクトリ、
   * またはそこにあるファイル (親ディレクトリを開く)。存在しないパスは reject。シェルプラグインを
   * 直に叩かずバックエンド経由で起動する (capabilities を増やさない)。
   */
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),

  /**
   * About 面のリポジトリ / ドキュメントリンクを既定のブラウザで開く (#1770)。許可されるのは
   * プロジェクトのリポジトリ配下の URL だけで、それ以外は reject (バックエンドの許可リスト)。
   */
  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),
};
