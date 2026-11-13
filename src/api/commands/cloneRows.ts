// `src-tauri/src/commands/clone_rows.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { CloneColumnRule, CloneRowsOutcome, CloneRowsPreview, SubsetRequest } from "../tauri";

export const cloneRowsCommands = {
  /**
   * 行の子レコードごとの複製 (#2304) の実行前プレビュー。起点の行から子の方向だけ (段数と件数の上限つき)
   * 行を集め、挿入順の表ごとの件数・主キーの決まり方・UNIQUE の衝突を返す。何も書かない。
   */
  previewCloneRows: (request: SubsetRequest, rules: CloneColumnRule[]) =>
    invoke<CloneRowsPreview>("preview_clone_rows", { request, rules }).then((r) =>
      parseResponse(schemas.cloneRowsPreview, r, "preview_clone_rows"),
    ),

  /**
   * 行を子レコードごと同じ DB 内に複製する (#2304)。1 トランザクションで、失敗したら全部ロールバック。
   * 読み取り専用の接続はバックエンドが拒否する。旧キー → 新キーの対応表を返し、新しい行は
   * `batchId` のバッチとしてフライトレコーダーから取り消せる。
   */
  cloneRows: (request: SubsetRequest, rules: CloneColumnRule[]) =>
    invoke<CloneRowsOutcome>("clone_rows", { request, rules }).then((r) =>
      parseResponse(schemas.cloneRowsOutcome, r, "clone_rows"),
    ),
};
