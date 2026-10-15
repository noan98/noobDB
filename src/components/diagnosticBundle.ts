/**
 * 匿名化した診断バンドルの書き出し (#1622)。保存先の選択 → バックエンドで本文を作る →
 * 書き込み、の順。保存ダイアログをキャンセルしたら本文は作らない (ログの読み出しや
 * keyring の疎通診断を無駄に走らせない)。
 *
 * @returns 書き込んだパス。キャンセルなら null。
 */
export async function saveDiagnosticBundle(deps: {
  pickPath: () => Promise<string | null | undefined>;
  build: () => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
}): Promise<string | null> {
  const dest = await deps.pickPath();
  if (typeof dest !== "string" || !dest) return null;
  const text = await deps.build();
  await deps.write(dest, text);
  return dest;
}
