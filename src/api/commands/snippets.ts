// `src-tauri/src/commands/snippets.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { Snippet, SaveSnippetRequest } from "../tauri";

export const snippetsCommands = {

  listSnippets: () =>
    invoke<Snippet[]>("list_snippets").then((r) =>
      parseResponse(schemas.snippetArray, r, "list_snippets"),
    ),
  saveSnippet: (req: SaveSnippetRequest) =>
    invoke<Snippet>("save_snippet", { req }).then((r) =>
      parseResponse(schemas.snippet, r, "save_snippet"),
    ),
  deleteSnippet: (id: string) => invoke<void>("delete_snippet", { id }),
};
