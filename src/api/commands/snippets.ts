// `src-tauri/src/commands/snippets.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type {
  Snippet,
  SaveSnippetRequest,
  SnippetImportPreview,
  SnippetImportResult,
  ProfileImportStrategy,
} from "../tauri";

export const snippetsCommands = {
  listSnippets: () =>
    invoke<Snippet[]>("list_snippets").then((r) => parseResponse(schemas.snippetArray, r, "list_snippets")),
  saveSnippet: (req: SaveSnippetRequest) =>
    invoke<Snippet>("save_snippet", { req }).then((r) => parseResponse(schemas.snippet, r, "save_snippet")),
  deleteSnippet: (id: string) => invoke<void>("delete_snippet", { id }),
  /**
   * スニペット (フォルダ・タグ・スコープ・本文) を JSON 文字列で返す (#1490)。`ids` が空/未指定なら
   * 全件。保存ダイアログで選んだパスへ `writeTextFile` で書く (新しい書き込み経路を増やさない)。
   */
  exportSnippets: (ids?: string[] | null) =>
    invoke<string>("export_snippets", { ids: ids ?? null }).then((r) =>
      parseResponse(schemas.stringResponse, r, "export_snippets"),
    ),
  /** 取り込み前のプレビュー (#1490)。件数・ID 衝突件数・スコープの付け替え件数を返し、書き込まない。 */
  previewImportSnippets: (json: string) =>
    invoke<SnippetImportPreview>("preview_import_snippets", { json }).then((r) =>
      parseResponse(schemas.snippetImportPreview, r, "preview_import_snippets"),
    ),
  /** `exportSnippets` の JSON を取り込む (#1490)。ID 衝突は `strategy` (採番 / スキップ / 上書き) で解決する。 */
  importSnippets: (json: string, strategy: ProfileImportStrategy) =>
    invoke<SnippetImportResult>("import_snippets", { json, strategy }).then((r) =>
      parseResponse(schemas.snippetImportResult, r, "import_snippets"),
    ),
};
