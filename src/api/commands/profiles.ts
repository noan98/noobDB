// `src-tauri/src/commands/profiles.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type {
  ConnectionProfile,
  ProfileSecretKind,
  SaveProfileRequest,
  ProfileImportStrategy,
  ProfileImportResult,
} from "../tauri";

export const profilesCommands = {

  listProfiles: () =>
    invoke<ConnectionProfile[]>("list_profiles").then((r) =>
      parseResponse(schemas.connectionProfileArray, r, "list_profiles"),
    ),
  /**
   * 保存済みの秘密を OS keyring から読み出して**平文のまま**返す (#938)。
   * `list_profiles` が返すのは `has_*` の真偽値だけで、値をフロントへ渡すのは
   * この IPC のみ (秘密分離ポリシーの意図的な例外 — 詳細は Rust 側の
   * `reveal_profile_secret` の doc コメントと CLAUDE.md を参照)。
   *
   * 未保存なら `null`。**呼び出し側は受け取った値を永続化しないこと** — 表示
   * バッファに載せるだけにして、非表示に戻すときは state から破棄する。
   */
  revealProfileSecret: (profileId: string, kind: ProfileSecretKind) =>
    invoke<string | null>("reveal_profile_secret", { profileId, kind }).then((r) => {
      // ここだけ `parseResponse` (zod 検証) を通さない。検証に失敗すると
      // `parseResponse` は DEV ビルドで**受信値そのもの**を `console.error` へ
      // 出すが、このコマンドの受信値は平文の秘密そのもので、開発者コンソールに
      // 残ってしまう。返り値が単純な `string | null` なので、値をログ経路へ
      // 一切渡さない形状チェックで代替する。
      if (r !== null && typeof r !== "string") {
        throw new Error(
          'IPC レスポンス "reveal_profile_secret" が期待した形式と一致しません: (root): expected string or null',
        );
      }
      return r;
    }),
  saveProfile: (req: SaveProfileRequest) =>
    invoke<ConnectionProfile>("save_profile", { req }).then((r) =>
      parseResponse(schemas.connectionProfile, r, "save_profile"),
    ),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  /**
   * 接続リストのドラッグ/キーボード並べ替え (#786)。`orderedIds` は既存プロファイル
   * 全件の真の順列でなければならない — 検証は `ConnectionList` / `App.tsx` の純
   * ロジック (`connectionOrder.ts`) が行い、バックエンドも同じ不変条件を強制する。
   * 並び順は `profiles.json` の配列順そのものなので、専用フィールドは無い。
   */
  reorderProfiles: (orderedIds: string[]) => invoke<void>("reorder_profiles", { orderedIds }),
  /**
   * 接続プロファイルを **秘密情報抜きで** `path` に JSON 出力する。`ids`
   * 省略時は全件。返り値は書き込んだバイト数。
   */
  exportProfiles: (path: string, ids?: string[]) =>
    invoke<number>("export_profiles", { path, ids: ids ?? null }).then((r) =>
      parseResponse(schemas.numberResponse, r, "export_profiles"),
    ),
  /**
   * `path` の JSON (`exportProfiles` 出力) を取り込む。`strategy` は ID 衝突時の
   * 解決方法。秘密情報は含まれないため、取り込んだプロファイルは接続時に資格情報の
   * 再入力が要る。
   */
  importProfiles: (path: string, strategy: ProfileImportStrategy) =>
    invoke<ProfileImportResult>("import_profiles", { path, strategy }).then((r) =>
      parseResponse(schemas.profileImportResult, r, "import_profiles"),
    ),
};
