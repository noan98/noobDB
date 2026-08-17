/**
 * 接続切替時のアクセント/環境ウォッシュ (#978) の純ロジック。`AccentWash.tsx`
 * の副作用 (portal 描画・アニメーション) から分離し、発火判定と色・強度の
 * 決定を単体テストできるようにする。
 */

import { connectionBandColor, type TitleBarConnection } from "./titleBarContext";

/**
 * ウォッシュを発火すべきかどうか。接続の同一性キー (推奨: セッション id) が
 * **実際に変化し、かつ新しい値が非 null** (= 何らかの接続がアクティブになった)
 * ときだけ true を返す。同一キーのままの再描画 (自動再接続でのステータス変化
 * 等、`Session.reconnect` は同じ session id のまま張り直すため #712) では
 * 発火せず、切断 (非 null → null) への遷移も「体感させたい新しい環境」が
 * 無いため発火しない。
 */
export function shouldFireAccentWash(
  prevKey: string | null,
  nextKey: string | null,
): boolean {
  return prevKey !== nextKey && nextKey !== null;
}

/**
 * ウォッシュの不透明度 (初期値。そこから 0 へフェードアウトする)。本番接続
 * (`is_production`) への切替はより強く体感させ、「別の DB を触っている」
 * ことに気づかせる誤操作防止の安全キューとして機能させる。
 */
export function accentWashOpacity(
  connection: TitleBarConnection | null | undefined,
): number {
  return connection?.isProduction ? 0.45 : 0.22;
}

export interface AccentWashSpec {
  /** ウォッシュの塗り色。`titleBarContext.connectionBandColor` と同じ優先順位
   *  (本番=危険色 / サンドボックス=専用 violet / 通常=プロファイル色 or
   *  ワークスペースアクセント) で決まるため、安全網の識別性を弱めない。 */
  color: string;
  /** 初期不透明度 (`accentWashOpacity` 参照)。 */
  opacity: number;
}

/**
 * ウォッシュに使う色と不透明度をまとめて返す。接続が無い (`connectionBandColor`
 * が `"transparent"` を返す) ときは `null` を返し、ウォッシュを出さないことを
 * 示す。
 */
export function accentWashSpec(
  connection: TitleBarConnection | null | undefined,
): AccentWashSpec | null {
  const color = connectionBandColor(connection);
  if (color === "transparent") return null;
  return { color, opacity: accentWashOpacity(connection) };
}
