// スキーマドリフト・タイムライン (#736) のフロント側ロジック。
//
// 世代の取得・正規化・フィンガープリント・保存・ローテーション・差分計算は Rust の
// `schema_drift` モジュールに移した (#1260: 旧実装は listTables → テーブルごとの
// describeTable + listIndexes の直列 2N IPC と、1 世代 200KB × 20 世代の localStorage
// 同期読み書きだった)。ここに残るのは、(1) 結果サマリをトースト用の短い表記へ整形する
// 純関数と、(2) 旧 localStorage 世代を Rust ストアへ一度だけ移す移行コードのみ。

import type {
  DriverKind,
  SchemaDriftGeneration,
  SchemaDriftSummary,
  SchemaDriftTableChange,
} from "./api/tauri";

const STORAGE_PREFIX = "noobdb.schemadrift.";

/** 旧ストアが 1 プロファイルあたり保持していた世代の上限 (移行時のクランプ用)。 */
export const MAX_LEGACY_GENERATIONS = 20;

/** この世代が (省略されていないので) 他世代との差分計算に使えるか。 */
export function canDiff(gen: SchemaDriftGeneration): boolean {
  return !gen.omitted;
}

// --- 変化サマリ (トースト/タイムラインパネル共有の整形ロジック) ---

/**
 * 1 テーブル分の変化を言語非依存の短い表記に整形する (純粋・テスト対象)。
 * 記号のみを使うことで日英どちらの文脈にも自然に埋め込める:
 * `+table` = テーブル追加、`-table` = テーブル削除、
 * `table(+2,-1,~1)` = 列の追加/削除/変更件数、`idx` プレフィックスはインデックス側。
 */
export function formatTableChangeFragment(c: SchemaDriftTableChange): string {
  if (c.tableStatus === "added") return `+${c.table}`;
  if (c.tableStatus === "removed") return `-${c.table}`;
  const bits: string[] = [];
  if (c.columnsAdded > 0) bits.push(`+${c.columnsAdded}`);
  if (c.columnsRemoved > 0) bits.push(`-${c.columnsRemoved}`);
  if (c.columnsChanged > 0) bits.push(`~${c.columnsChanged}`);
  if (c.indexesAdded > 0 || c.indexesRemoved > 0 || c.indexesChanged > 0) {
    const idxBits: string[] = [];
    if (c.indexesAdded > 0) idxBits.push(`+${c.indexesAdded}`);
    if (c.indexesRemoved > 0) idxBits.push(`-${c.indexesRemoved}`);
    if (c.indexesChanged > 0) idxBits.push(`~${c.indexesChanged}`);
    bits.push(`idx${idxBits.join("")}`);
  }
  return `${c.table}(${bits.join(",")})`;
}

/**
 * トースト通知に埋め込む短い詳細文字列を組み立てる (純粋)。先頭 `maxTables`
 * 件だけを表示し、超過分があれば `…` を付ける。空サマリなら空文字列。
 */
export function buildDriftDetail(summary: SchemaDriftSummary, maxTables = 3): string {
  if (summary.tables.length === 0) return "";
  const shown = summary.tables.slice(0, maxTables).map(formatTableChangeFragment);
  const more = summary.tables.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, …` : shown.join(", ");
}

// --- DDL 成功時の自動取得 (#1537) ---

/** 最後の DDL からこの時間 (ms) 静かになったら 1 回だけ取得する。連続する DDL をまとめる。 */
export const DDL_CAPTURE_QUIET_MS = 3_000;
/** DDL が途切れず続いても、最初の DDL からこの時間 (ms) を超えて待たずに取得する。 */
export const DDL_CAPTURE_MAX_WAIT_MS = 15_000;
/** 1 回の取得に紐づける SQL 文の最大数 (超過分は捨てる)。 */
export const DDL_CAPTURE_MAX_STATEMENTS = 20;

/**
 * まとめた DDL 文を、世代に紐づける 1 つの文字列にする (純粋)。空白だけの文は捨て、
 * 先頭 `DDL_CAPTURE_MAX_STATEMENTS` 文だけを改行で連結する。何も無ければ null。
 */
export function joinTriggerSql(statements: readonly string[]): string | null {
  const kept = statements
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, DDL_CAPTURE_MAX_STATEMENTS);
  return kept.length > 0 ? kept.join("\n") : null;
}

/**
 * DDL 成功をきっかけにしたスキーマ取得を間引く (連続実行時に取得が走り続けて重くならない
 * ようにする)。同じキー (プロファイル + データベース) の DDL を `quietMs` の間まとめ、
 * 静かになった時点 (または最初の DDL から `maxWaitMs` 経過した時点) で `onFlush` を 1 回だけ
 * 呼ぶ。タイマーは注入できるのでテストでフェイクタイマーを使える。
 */
export function createDdlCaptureCoalescer(opts: {
  onFlush: (key: string, triggerSql: string | null) => void;
  quietMs?: number;
  maxWaitMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}): { push: (key: string, sql: string) => void; dispose: () => void } {
  const quietMs = opts.quietMs ?? DDL_CAPTURE_QUIET_MS;
  const maxWaitMs = opts.maxWaitMs ?? DDL_CAPTURE_MAX_WAIT_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = opts.now ?? (() => Date.now());
  const pending = new Map<string, { statements: string[]; firstAt: number; timer: unknown }>();

  const flush = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    clearTimer(entry.timer);
    opts.onFlush(key, joinTriggerSql(entry.statements));
  };

  return {
    push(key, sql) {
      const t = now();
      const entry = pending.get(key);
      if (entry) clearTimer(entry.timer);
      const firstAt = entry?.firstAt ?? t;
      const statements = entry?.statements ?? [];
      // 上限を超えた分は捨てる (取得自体は走る)。
      if (statements.length < DDL_CAPTURE_MAX_STATEMENTS) statements.push(sql);
      const wait = Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - t));
      pending.set(key, { statements, firstAt, timer: setTimer(() => flush(key), wait) });
    },
    dispose() {
      for (const entry of pending.values()) clearTimer(entry.timer);
      pending.clear();
    },
  };
}

/**
 * DDL が走ったデータベースが、スキーマドリフトの記録対象 (プロファイルの既定データベース)
 * かを判定する (純粋)。タイムラインはプロファイルごとに既定データベースの世代を積むので、
 * 別のデータベースへの DDL を混ぜると前世代との比較が意味を失う。タブがデータベースを
 * 固定していない (null/空) ときは既定データベースへの実行なので対象。
 */
export function isDriftTrackedDatabase(
  ranOn: string | null | undefined,
  profileDatabase: string | null | undefined,
): boolean {
  if (!profileDatabase) return false;
  return !ranOn || ranOn === profileDatabase;
}

// --- 旧 localStorage 世代の移行 (#1260) ---

function isDriver(v: unknown): v is DriverKind {
  return v === "mysql" || v === "postgres" || v === "sqlite";
}

function isValidLegacyGeneration(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.capturedAt !== "string" ||
    !isDriver(o.driver) ||
    typeof o.database !== "string" ||
    typeof o.fingerprint !== "string" ||
    typeof o.tableCount !== "number"
  ) {
    return false;
  }
  // `payload` は省略世代なら null、そうでなければ最低限の形を持つオブジェクト。
  if (o.payload === null) return true;
  if (!o.payload || typeof o.payload !== "object") return false;
  const p = o.payload as Record<string, unknown>;
  return isDriver(p.driver) && typeof p.database === "string" && Array.isArray(p.tables);
}

/**
 * 旧 localStorage のパース済み JSON から、Rust ストアへ渡せる世代 (新しい順) だけを
 * 取り出す (純粋)。未知の形・不正な世代は捨て、世代数は旧上限でクランプする。
 */
export function normalizeLegacySchemaDrift(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== "object") return [];
  const gens = (parsed as Record<string, unknown>).generations;
  if (!Array.isArray(gens)) return [];
  return gens.filter(isValidLegacyGeneration).slice(0, MAX_LEGACY_GENERATIONS);
}

/** 移行元の localStorage キー。 */
export function legacySchemaDriftKey(profileId: string): string {
  return STORAGE_PREFIX + profileId;
}

/**
 * このプロファイルの旧 localStorage 世代を Rust ストアへ一度だけ取り込み、成功したら
 * キーを削除する。キーが無ければ何もしない。取り込みに失敗したとき (IPC エラー)
 * はキーを残し、次回の起動で再試行する。破損した JSON は移行しようがないので
 * キーごと破棄する。ストレージが使えない環境でも例外は投げない。
 */
export async function migrateLegacySchemaDrift(
  profileId: string,
  importLegacy: (profileId: string, generations: unknown[]) => Promise<number>,
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): Promise<void> {
  const key = legacySchemaDriftKey(profileId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return;
  }
  if (raw === null) return;
  let generations: unknown[] = [];
  try {
    generations = normalizeLegacySchemaDrift(JSON.parse(raw));
  } catch {
    generations = [];
  }
  try {
    if (generations.length > 0) await importLegacy(profileId, generations);
    storage.removeItem(key);
  } catch {
    // 取り込み失敗 (IPC エラー) / ストレージ不可: キーを残して次回再試行する。
  }
}
