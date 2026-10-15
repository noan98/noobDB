// 背景接続の生存確認 (#1630)。アクティブでない接続が黙って切れても、その接続へ切り替えるまで
// 気付けなかった。低頻度の `pingSession` の結果から「切れている背景接続」の集合を更新する純関数と
// 間隔の定数。

/** 背景接続の生存確認の間隔 (ms)。サーバ・SSH 経路への負荷を避けて低頻度にする。 */
export const BACKGROUND_PING_INTERVAL_MS = 60_000;

export interface BackgroundPingResult {
  profileId: string;
  alive: boolean;
}

/**
 * 切れている背景接続の集合を更新する。
 * - 今回 `alive = false` だったものは加える、`alive = true` だったものは外す。
 * - 今回確認していないもの (アクティブになった・閉じた) は、`registryProfileIds` (いま開いている
 *   接続) に居なければ外し、居れば前回のまま残す。
 * 変化が無ければ `prev` をそのまま返す (不要な再描画を避ける)。
 */
export function nextStaleProfileIds(
  prev: ReadonlySet<string>,
  results: readonly BackgroundPingResult[],
  registryProfileIds: Iterable<string>,
): ReadonlySet<string> {
  const registry = new Set(registryProfileIds);
  const next = new Set<string>();
  for (const id of prev) if (registry.has(id)) next.add(id);
  for (const r of results) {
    if (!registry.has(r.profileId)) continue;
    if (r.alive) next.delete(r.profileId);
    else next.add(r.profileId);
  }
  if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
  return next;
}
