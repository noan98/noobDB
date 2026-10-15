// 起動時の更新通知の「見送り」(#1631)。起動時チェックで「後で」を選んだバージョンを覚え、同じ (または
// より古い) バージョンは次回以降の起動時には出さない。より新しいバージョンが出たら再び通知する。
// 設定画面の手動チェックは見送りを無視する (自分で確認しに行ったので必ず見せる)。
// バージョン文字列は秘密ではない。閲覧者ごとの便宜なので localStorage (読めなければ何も覚えない)。

const KEY = "noobdb.skippedUpdateVersion";

interface ParsedVersion {
  core: number[];
  pre: string[];
}

/** `v1.2.3-beta.1+build` → { core: [1,2,3], pre: ["beta","1"] } (ビルドメタデータは無視)。数値版でなければ null。 */
function parseVersion(v: string): ParsedVersion | null {
  const noBuild = v.trim().replace(/^v/i, "").split("+")[0];
  const dash = noBuild.indexOf("-");
  const coreStr = dash < 0 ? noBuild : noBuild.slice(0, dash);
  const preStr = dash < 0 ? "" : noBuild.slice(dash + 1);
  if (!coreStr) return null;
  const core = coreStr.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
  if (core.some(Number.isNaN)) return null;
  return { core, pre: preStr ? preStr.split(".") : [] };
}

/** semver の優先順位比較。a < b なら負、等しければ 0、a > b なら正。 */
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  const n = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // プレリリース付きは同じ core の正式版より低い。
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const m = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < m; i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1; // 識別子が少ない方が低い
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数値の識別子は英数字より低い
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** a が b 以下か (プレリリースを含む semver 比較)。比べられない (数値版でない) ときは完全一致だけを「以下」とみなす。 */
export function isVersionAtMost(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a.trim() === b.trim();
  return compareParsed(pa, pb) <= 0;
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
