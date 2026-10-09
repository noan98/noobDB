// `src-tauri/src/commands/profile_backup.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type {
  ProfileImportStrategy,
  EncryptedProfileImportResult,
  EncryptedProfileExportResult,
} from "../tauri";

export const profileBackupCommands = {
  /**
   * 接続プロファイルを **keyring の秘密込みで** パスフレーズ暗号化し、`path` に
   * 書き出す (#710。Argon2id + AES-256-GCM)。`ids` 省略時は全件。パスフレーズは
   * IPC に載せるだけでバックエンドも保存しない。戻り値は件数のみ。
   */
  exportProfilesEncrypted: (path: string, passphrase: string, ids?: string[]) =>
    invoke<EncryptedProfileExportResult>("export_profiles_encrypted", {
      req: { path, passphrase, ids: ids ?? null },
    }).then((r) =>
      parseResponse(schemas.encryptedProfileExportResult, r, "export_profiles_encrypted"),
    ),
  /**
   * `exportProfilesEncrypted` で作った暗号化バックアップをパスフレーズで開封して
   * 取り込む (#710)。ID 衝突は平文インポートと同じ `strategy` で解決し、秘密は
   * 取り込み先の keyring へ書き戻す。パスフレーズ誤り / 改ざんは `invalid_input`
   * のエラーになる。keyring への書き込みが失敗した場合は取り込み前の状態に戻る。
   */
  importProfilesEncrypted: (path: string, passphrase: string, strategy: ProfileImportStrategy) =>
    invoke<EncryptedProfileImportResult>("import_profiles_encrypted", {
      req: { path, passphrase, strategy },
    }).then((r) =>
      parseResponse(schemas.encryptedProfileImportResult, r, "import_profiles_encrypted"),
    ),
};
