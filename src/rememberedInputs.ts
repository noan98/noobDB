// 「前回入力」の記憶 (#1631)。ダンプ・取り込み・書き出し・テストデータ・値検索・スクリプト
// 実行・ルーチン引数など、同じ操作を繰り返すモーダルの前回値を、接続 (プロファイル) や
// テーブル単位で次回の初期値にする。
//
// - 保存先は localStorage (閲覧者ごとの便宜。読めなければ空で動く)。`profiles.json` や設定
//   ストアには書かない。**秘密情報 (パスワード・機微列の値など) は呼び出し側が渡さない**こと。
// - 機能 (feature) ごとに 1 キー。中身は `{ order, entries }` の LRU で、`MAX_ENTRIES` を超えた
//   古いスコープから捨てる。値の形は読み出し時に機能ごとの sanitize で検証する (壊れた JSON、
//   別バージョンの形は捨てて既定値で動く)。
// - スコープは「接続 × DB × テーブル」などを `rememberScope` で連結した文字列。

const PREFIX = "noobdb.remember.v1.";

/** 1 機能が保持するスコープ数の上限 (超えたら最後に使った順で古いものから捨てる)。 */
export const MAX_REMEMBERED_ENTRIES = 60;

interface Bucket {
  order: string[];
  entries: Record<string, unknown>;
}

/** スコープ文字列を作る (区切りは値に出現しない制御文字)。 */
export function rememberScope(...parts: (string | null | undefined)[]): string {
  return parts.map((p) => p ?? "").join("\u0001");
}

function readBucket(feature: string): Bucket {
  try {
    const raw = localStorage.getItem(PREFIX + feature);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const o = parsed as Record<string, unknown>;
        const entries =
          o.entries && typeof o.entries === "object" && !Array.isArray(o.entries)
            ? (o.entries as Record<string, unknown>)
            : {};
        const order = Array.isArray(o.order)
          ? o.order.filter((k): k is string => typeof k === "string" && k in entries)
          : [];
        return { order, entries };
      }
    }
  } catch {
    // 読めなければ空で動く。
  }
  return { order: [], entries: {} };
}

function writeBucket(feature: string, bucket: Bucket): void {
  try {
    localStorage.setItem(PREFIX + feature, JSON.stringify(bucket));
  } catch {
    // 容量超過・無効化: 記憶できないだけで操作は続ける。
  }
}

/**
 * 前回値を読む。`sanitize` が null を返す (形が壊れている) ときは「記憶なし」として null。
 * 読むだけでは LRU の順序を変えない。
 */
export function loadRemembered<T>(
  feature: string,
  scope: string,
  sanitize: (raw: unknown) => T | null,
): T | null {
  const bucket = readBucket(feature);
  if (!(scope in bucket.entries)) return null;
  try {
    return sanitize(bucket.entries[scope]);
  } catch {
    return null;
  }
}

/** 前回値を保存し、そのスコープを LRU の先頭へ。上限を超えた古いスコープは捨てる。 */
export function saveRemembered(feature: string, scope: string, value: unknown): void {
  const bucket = readBucket(feature);
  bucket.entries[scope] = value;
  bucket.order = [scope, ...bucket.order.filter((k) => k !== scope)];
  for (const dropped of bucket.order.splice(MAX_REMEMBERED_ENTRIES)) {
    delete bucket.entries[dropped];
  }
  writeBucket(feature, bucket);
}

/** 1 スコープの記憶を消す。 */
export function forgetRemembered(feature: string, scope: string): void {
  const bucket = readBucket(feature);
  if (!(scope in bucket.entries)) return;
  delete bucket.entries[scope];
  bucket.order = bucket.order.filter((k) => k !== scope);
  writeBucket(feature, bucket);
}

// ---------------------------------------------------------------------------
// sanitize 部品
// ---------------------------------------------------------------------------

/** プレーンオブジェクトか (配列・null は除く)。 */
export function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** 文字列ならそのまま、そうでなければ `fallback`。 */
export function pickString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** 真偽値ならそのまま、そうでなければ `fallback`。 */
export function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** 許可リストに含まれる文字列ならそのまま、そうでなければ `fallback`。 */
export function pickOneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** 有限の数値ならそのまま、そうでなければ `fallback`。 */
export function pickNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
