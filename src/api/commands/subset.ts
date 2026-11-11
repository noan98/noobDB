// `src-tauri/src/commands/subset.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { SubsetColumnMask, SubsetOutput, SubsetPreview, SubsetRequest } from "../tauri";

export const subsetCommands = {
  /**
   * サブセット抽出 (#2241) の実行前プレビュー。起点の行から外部キーを行単位で辿り、
   * 表ごとの抽出件数・循環・上限超過を返す (親の方向は常に最後まで、子の方向は段数と
   * 件数の上限つき)。取得はすべて読み取り専用で、何も書かない。
   */
  previewSubset: (request: SubsetRequest) =>
    invoke<SubsetPreview>("preview_subset", { request }).then((r) =>
      parseResponse(schemas.subsetPreview, r, "preview_subset"),
    ),

  /**
   * サブセットを抽出して出力する (#2241)。出力先は別の接続 (`transfer`。転送先の表は存在すること。
   * 読み取り専用の転送先はバックエンドが拒否する) か、INSERT スクリプトのファイル (`script`)。
   * 進捗は `subset-stream:*` イベント ({@link listenSubsetStream}) で届き、`cancelStream` で中断できる。
   */
  runSubset: (streamId: string, request: SubsetRequest, output: SubsetOutput, masks: SubsetColumnMask[]) =>
    invoke<void>("run_subset", { streamId, request, output, masks }),
};
