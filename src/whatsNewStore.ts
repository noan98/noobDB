// 更新「適用後」の新機能ハイライト (#1864)。承認直後 (再起動の前) に版とリリースノートを保存し、
// 次の起動で実行中の版と一致したときだけ一度表示して `lastWhatsNew` へ移す (About から再表示できる)。
// 版とリリースノートは秘密ではない。閲覧者ごとの便宜なので localStorage (読めなければ何も覚えない)。
import { isVersionAtMost } from "./updateSkip";
import { truncateReleaseNotes } from "./updaterFormat";

const PENDING_KEY = "noobdb.pendingWhatsNew";
const LAST_KEY = "noobdb.lastWhatsNew";
const MAX_NOTES = 2000;

export interface WhatsNewEntry {
  version: string;
  currentVersion: string;
  body: string;
}

function parseEntry(raw: string | null): WhatsNewEntry | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.version !== "string" || !o.version) return null;
    return {
      version: o.version,
      currentVersion: typeof o.currentVersion === "string" ? o.currentVersion : "",
      body: typeof o.body === "string" ? o.body : "",
    };
  } catch {
    return null;
  }
}

function read(key: string): WhatsNewEntry | null {
  try {
    return parseEntry(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function write(key: string, entry: WhatsNewEntry): void {
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // ignore
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** 更新の承認直後に呼ぶ。ノートは 2000 文字に切り詰めて保存する。 */
export function savePendingWhatsNew(update: {
  version: string;
  currentVersion: string;
  body?: string;
}): void {
  write(PENDING_KEY, {
    version: update.version,
    currentVersion: update.currentVersion,
    body: truncateReleaseNotes(update.body, MAX_NOTES),
  });
}

/** 適用に失敗したときなど、保存した pending を捨てる。 */
export function clearPendingWhatsNew(): void {
  remove(PENDING_KEY);
}

export function loadLastWhatsNew(): WhatsNewEntry | null {
  return read(LAST_KEY);
}

/**
 * 起動時の判定。pending があり、実行中の版と一致すれば `lastWhatsNew` へ移して返す (= 表示する)。
 * 実行中の版が保存版より古い (適用に失敗した) か、新しい (別経路で更新済み) ときは破棄して null。
 * 実行中の版が取れないとき (null) は何もしない (次回に持ち越す)。
 */
export function consumePendingWhatsNew(runningVersion: string | null): WhatsNewEntry | null {
  const pending = read(PENDING_KEY);
  if (!pending) return null;
  if (!runningVersion) return null;
  const sameOrOlder = isVersionAtMost(runningVersion, pending.version);
  const sameOrNewer = isVersionAtMost(pending.version, runningVersion);
  remove(PENDING_KEY);
  if (sameOrOlder && sameOrNewer) {
    write(LAST_KEY, pending);
    return pending;
  }
  return null;
}
