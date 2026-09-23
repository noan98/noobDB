/**
 * 暗号化プロファイルバックアップ (#710) の純ロジック。ダイアログ
 * (`ProfileBackupExportDialog` / `ProfileImportDialog`) から副作用なしで呼べるよう、
 * パスフレーズの検証と強度判定をここに置く。
 *
 * パスフレーズはダイアログの state にだけ保持し、ここでは保存も記録もしない。
 */

/**
 * エクスポート時のパスフレーズの最小文字数。バックエンドの
 * `profiles::backup::MIN_PASSPHRASE_CHARS` と揃える (Unicode のコードポイント数)。
 */
export const MIN_BACKUP_PASSPHRASE_LENGTH = 8;

/** 強い (推奨) とみなす文字数の目安。 */
const STRONG_PASSPHRASE_LENGTH = 16;

/** 暗号化バックアップのファイル拡張子 (ドットなし)。 */
export const BACKUP_FILE_EXTENSION = "noobdb-backup";

/** 保存ダイアログの既定ファイル名。 */
export function defaultBackupFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `noobdb-profiles-${y}${m}${d}.${BACKUP_FILE_EXTENSION}`;
}

/** コードポイント単位の文字数 (サロゲートペアを 1 文字と数える。Rust の `chars().count()` と一致)。 */
function charCount(s: string): number {
  return Array.from(s).length;
}

export type BackupPassphraseError = "tooShort" | "mismatch";

/**
 * エクスポート用パスフレーズ (2 回入力) を検証する。問題なければ `null`。
 * 長さ不足を先に報告する (確認欄を打つ前から「短い」と分かるように)。
 */
export function validateBackupPassphrase(
  passphrase: string,
  confirmation: string,
): BackupPassphraseError | null {
  if (charCount(passphrase) < MIN_BACKUP_PASSPHRASE_LENGTH) return "tooShort";
  if (passphrase !== confirmation) return "mismatch";
  return null;
}

export type PassphraseStrength = "weak" | "fair" | "strong";

/**
 * パスフレーズのおおまかな強度。総当たりへの耐性は主に長さで決まるので、長さと
 * 文字種の多さだけで判定する (辞書照合などはしない目安表示)。
 *
 * - `weak`: 最小文字数未満、または 1 種類の文字種だけで 12 文字未満
 * - `strong`: 16 文字以上、または 12 文字以上かつ 3 種類以上の文字種
 * - それ以外は `fair`
 */
export function passphraseStrength(passphrase: string): PassphraseStrength {
  const len = charCount(passphrase);
  if (len < MIN_BACKUP_PASSPHRASE_LENGTH) return "weak";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(passphrase),
  ).length;
  if (len >= STRONG_PASSPHRASE_LENGTH || (len >= 12 && classes >= 3)) return "strong";
  if (classes <= 1 && len < 12) return "weak";
  return "fair";
}
