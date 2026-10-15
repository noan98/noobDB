// 起動時の更新通知の「見送り」(#1631)。起動時チェックで「後で」を選んだバージョンを覚え、同じ (または
// より古い) バージョンは次回以降の起動時には出さない。より新しいバージョンが出たら再び通知する。
// 設定画面の手動チェックは見送りを無視する (自分で確認しに行ったので必ず見せる)。
// バージョン文字列は秘密ではない。閲覧者ごとの便宜なので localStorage (読めなければ何も覚えない)。

const KEY = "noobdb.skippedUpdateVersion";

/** `v1.2.3-beta.1+build` → [1, 2, 3]。数値として読めない版は null。 */
function versionParts(v: string): number[] | null {
  const core = v.trim().replace(/^v/i, "").split(/[-+]/)[0];
  if (!core) return null;
  const parts = core.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
  return parts.some(Number.isNaN) ? null : parts;
}

/** a が b 以下か。比べられない (数値版でない) ときは文字列の完全一致だけを「以下」とみなす。 */
export function isVersionAtMost(a: string, b: string): boolean {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa || !pb) return a.trim() === b.trim();
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return true;
}

export function loadSkippedUpdateVersion(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function saveSkippedUpdateVersion(version: string): void {
  try {
    localStorage.setItem(KEY, version);
  } catch {
    // ignore
  }
}

/** この版を起動時の通知から外すべきか (見送り済みの版か、それより古い版)。 */
export function shouldSkipStartupNotice(offered: string, skipped: string | null): boolean {
  return skipped !== null && isVersionAtMost(offered, skipped);
}
