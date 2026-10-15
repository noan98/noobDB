import { useEffect, useState } from "react";
import { api, type KeyringStatus } from "./api/tauri";

/**
 * OS keyring の疎通診断 (#1622) のキャッシュ。診断は一時エントリの書き込み・読み戻し・
 * 削除を行うため、アプリ起動時と接続フォームの両方から呼んでも 1 回だけ実行する。
 * 失敗 (IPC エラー) はキャッシュせず、次の呼び出しで再試行する。
 */
let cached: Promise<KeyringStatus | null> | null = null;

export function getKeyringStatus(): Promise<KeyringStatus | null> {
  if (!cached) {
    const p = Promise.resolve()
      .then(() => api.checkKeyring())
      .then(
        (s) => s,
        () => {
          cached = null;
          return null;
        },
      );
    cached = p;
  }
  return cached;
}

/** テスト用: キャッシュを捨てる。 */
export function resetKeyringStatusCache(): void {
  cached = null;
}

/**
 * 診断結果。`enabled` のときだけ確認する (パスワード欄を初めて描画したとき。起動時には確認しない)。
 * まだ・取得できないときは `null` (警告は出さない)。
 */
export function useKeyringStatus(enabled: boolean): KeyringStatus | null {
  const [status, setStatus] = useState<KeyringStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void getKeyringStatus().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return status;
}

/** 診断の理由コード → i18n キー。未知のコードは `other`。 */
export function keyringReasonKey(reason: string | null) {
  switch (reason) {
    case "storage_unavailable":
      return "keyringReasonStorageUnavailable" as const;
    case "platform_failure":
      return "keyringReasonPlatformFailure" as const;
    case "readback_missing":
    case "readback_mismatch":
      return "keyringReasonReadback" as const;
    default:
      return "keyringReasonOther" as const;
  }
}
