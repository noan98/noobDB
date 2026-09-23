import { describe, expect, it } from "vitest";
import {
  BACKUP_FILE_EXTENSION,
  MIN_BACKUP_PASSPHRASE_LENGTH,
  defaultBackupFileName,
  passphraseStrength,
  validateBackupPassphrase,
} from "../components/profileBackup";

// #710: 暗号化プロファイルバックアップのパスフレーズ検証。最小文字数はバックエンド
// (`profiles::backup::MIN_PASSPHRASE_CHARS`) と一致させる — 片方だけ変えると
// 「UI では通るのに IPC で弾かれる」ズレになる。
describe("validateBackupPassphrase (#710)", () => {
  it("最小文字数はバックエンドと同じ 8", () => {
    expect(MIN_BACKUP_PASSPHRASE_LENGTH).toBe(8);
  });

  it("短すぎるパスフレーズを先に報告する", () => {
    expect(validateBackupPassphrase("", "")).toBe("tooShort");
    expect(validateBackupPassphrase("1234567", "1234567")).toBe("tooShort");
    expect(validateBackupPassphrase("1234567", "different")).toBe("tooShort");
  });

  it("確認欄と一致しなければ mismatch", () => {
    expect(validateBackupPassphrase("12345678", "12345679")).toBe("mismatch");
    expect(validateBackupPassphrase("12345678", "")).toBe("mismatch");
  });

  it("条件を満たせば null", () => {
    expect(validateBackupPassphrase("12345678", "12345678")).toBeNull();
  });

  it("文字数はコードポイントで数える (Rust の chars().count() と一致)", () => {
    // 絵文字 (サロゲートペア) 8 個 = 16 UTF-16 単位だが 8 文字。
    const emoji = "🔑".repeat(8);
    expect(validateBackupPassphrase(emoji, emoji)).toBeNull();
    const seven = "🔑".repeat(7);
    expect(validateBackupPassphrase(seven, seven)).toBe("tooShort");
    const ja = "パスフレーズ八文字";
    expect(validateBackupPassphrase(ja, ja)).toBeNull();
  });
});

describe("passphraseStrength (#710)", () => {
  it("最小未満は weak", () => {
    expect(passphraseStrength("Ab1!")).toBe("weak");
  });
  it("1 種類の文字種だけの短いものは weak", () => {
    expect(passphraseStrength("abcdefgh")).toBe("weak");
    expect(passphraseStrength("12345678901")).toBe("weak");
  });
  it("中程度は fair", () => {
    expect(passphraseStrength("abcd1234")).toBe("fair");
    expect(passphraseStrength("abcdefghijkl")).toBe("fair");
  });
  it("16 文字以上、または 12 文字以上で 3 種類以上の文字種は strong", () => {
    expect(passphraseStrength("abcdefghijklmnop")).toBe("strong");
    expect(passphraseStrength("Abcdefgh123!")).toBe("strong");
  });
});

describe("defaultBackupFileName (#710)", () => {
  it("日付入りで専用拡張子", () => {
    expect(defaultBackupFileName(new Date(2026, 0, 5))).toBe(
      `noobdb-profiles-20260105.${BACKUP_FILE_EXTENSION}`,
    );
    expect(BACKUP_FILE_EXTENSION).toBe("noobdb-backup");
  });
});
