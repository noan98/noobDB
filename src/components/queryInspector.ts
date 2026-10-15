import type { LiveQuery } from "../api/tauri";

/**
 * ライブクエリ・インスペクタ (#746) の純ロジック。N+1 判定・テールのマージ/
 * フィルタを、レンダリングから切り離した副作用なしの純関数として実装する
 * (`processList.ts` / `gridStats.ts` と同じ方針)。判定はすべて決定的ルールで AI は使わない。
 *
 * フィンガープリント正規化 (ライブテールの同型クエリキー) と digest スナップショットの
 * 差分集計・N+1 レート目安は #1259 で Rust 側 (`db/inspector.rs`) へ移した。
 * フィンガープリントは `sample_live_queries` が `LiveQuery.fingerprint` として返す。
 */

/**
 * PostgreSQL が権限不足のとき `pg_stat_activity.query` に入れる置換テキスト。
 * 見えている範囲を UI に明示するための判定 (#746: 黙って落とさない)。
 */
export function isPrivilegeMasked(query: string): boolean {
  return query.trim() === "<insufficient privilege>";
}

// ── N+1 判定 ────────────────────────────────────────────────────────────

/** N+1 判定の閾値。回数と時間窓の両方を設定画面から調整できる (#746)。 */
export interface NPlusOneOptions {
  /** 時間窓内でこの回数以上同型クエリが観測されたらフラグする。 */
  minCount: number;
  /** 「1 リクエスト相当」とみなす時間窓 ms。 */
  windowMs: number;
}

export const DEFAULT_N_PLUS_ONE_MIN_COUNT = 10;
export const DEFAULT_N_PLUS_ONE_WINDOW_MS = 2000;

/** 閾値を安全な範囲に丸める (UI の自由入力からの防御)。 */
export function sanitizeNPlusOneOptions(opts: Partial<NPlusOneOptions>): NPlusOneOptions {
  const minCount = Number.isFinite(opts.minCount)
    ? Math.max(2, Math.floor(opts.minCount as number))
    : DEFAULT_N_PLUS_ONE_MIN_COUNT;
  const windowMs = Number.isFinite(opts.windowMs)
    ? Math.max(100, Math.floor(opts.windowMs as number))
    : DEFAULT_N_PLUS_ONE_WINDOW_MS;
  return { minCount, windowMs };
}

/** N+1 と判定された同型クエリ 1 件。 */
export interface NPlusOneFinding {
  fingerprint: string;
  /** 時間窓内で観測された最大回数。 */
  count: number;
  windowMs: number;
}

/**
 * 「同一フィンガープリントのクエリが短時間に大量発行される」パターンの決定的
 * 検出 (#746)。イベント列 (フィンガープリント + 観測時刻) をフィンガープリント
 * ごとにまとめ、スライディングウィンドウ (幅 `windowMs`) 内の最大観測数が
 * `minCount` 以上のものを返す。入力の時刻順は問わない。
 */
export function detectNPlusOne(
  events: readonly { fingerprint: string; observedAtMs: number }[],
  options: Partial<NPlusOneOptions> = {},
): NPlusOneFinding[] {
  const { minCount, windowMs } = sanitizeNPlusOneOptions(options);
  const byFp = new Map<string, number[]>();
  for (const e of events) {
    const arr = byFp.get(e.fingerprint);
    if (arr) arr.push(e.observedAtMs);
    else byFp.set(e.fingerprint, [e.observedAtMs]);
  }
  const findings: NPlusOneFinding[] = [];
  for (const [fingerprint, times] of byFp) {
    if (times.length < minCount) continue;
    times.sort((a, b) => a - b);
    let best = 0;
    let lo = 0;
    for (let hi = 0; hi < times.length; hi++) {
      while (times[hi] - times[lo] > windowMs) lo++;
      best = Math.max(best, hi - lo + 1);
    }
    if (best >= minCount) findings.push({ fingerprint, count: best, windowMs });
  }
  findings.sort((a, b) => b.count - a.count);
  return findings;
}

// ── ライブテールのマージ/フィルタ ────────────────────────────────────────

/** テールに積まれた 1 イベント: バックエンドの LiveQuery + クライアント側付加情報。 */
export interface LiveTailEntry extends LiveQuery {
  /** このイベントを最初に観測したクライアント時刻 (エポック ms)。 */
  observedAtMs: number;
  /** Rust の `normalize_sql_fingerprint` による同型クエリキー (N+1 判定と行グルーピング用)。 */
  fingerprint: string;
}

/** テールに保持する最大イベント数 (メモリ上限。超過分は古い方から捨てる)。 */
export const LIVE_TAIL_MAX_ENTRIES = 1000;

/**
 * ポーリング 1 回分のサンプルを既存テールへマージする。`key` で重複排除し、
 * 新規イベントは `observedAtMs` (このポーリングの観測時刻) を刻んで先頭に積む。
 * 既出イベントは実行中→完了の遷移 (running / duration) だけを更新し、観測
 * 時刻は初回のまま保つ (N+1 の時間窓判定がポーリングのたびにズレないように)。
 * 戻り値は新しい配列 (入力は変更しない)。上限を超えた分は末尾 (最古) から落とす。
 */
export function mergeLiveTail(
  existing: readonly LiveTailEntry[],
  incoming: readonly LiveQuery[],
  observedAtMs: number,
  maxEntries: number = LIVE_TAIL_MAX_ENTRIES,
): LiveTailEntry[] {
  const known = new Map<string, LiveTailEntry>();
  for (const e of existing) known.set(e.key, e);
  const fresh: LiveTailEntry[] = [];
  const updated = new Map<string, LiveTailEntry>();
  for (const q of incoming) {
    const prev = known.get(q.key);
    if (prev) {
      // 実行中だった文の完了 (または経過時間の更新) を反映する。
      if (prev.running !== q.running || prev.duration_ms !== q.duration_ms) {
        updated.set(q.key, { ...prev, running: q.running, duration_ms: q.duration_ms });
      }
      continue;
    }
    fresh.push({
      ...q,
      // PG は開始時刻を報告するのでそれを観測時刻として優先する (テールの
      // 並びが実際の発行順に近づく)。MySQL はポーリング観測時刻で代替。
      observedAtMs: q.started_at_ms ?? observedAtMs,
    });
  }
  // 新規はサンプル内順 (サーバが新しい順に返す) を保って先頭へ。
  const rest = existing.map((e) => updated.get(e.key) ?? e);
  return [...fresh, ...rest].slice(0, Math.max(1, maxEntries));
}

/** ライブテールの表示フィルタ (#746: 接続元/対象/所要時間で絞る)。 */
export interface LiveTailFilter {
  /** user / host / database / application / クエリ本文への大小無視部分一致。 */
  text: string;
  /** これ未満の所要時間 (ms) のイベントを隠す。null は無効。 */
  minDurationMs: number | null;
}

export function filterLiveTail(entries: readonly LiveTailEntry[], filter: LiveTailFilter): LiveTailEntry[] {
  const needle = filter.text.trim().toLowerCase();
  return entries.filter((e) => {
    if (filter.minDurationMs != null && (e.duration_ms == null || e.duration_ms < filter.minDurationMs)) {
      return false;
    }
    if (needle === "") return true;
    return [e.user, e.host, e.database, e.application, e.query].some(
      (v) => v != null && v.toLowerCase().includes(needle),
    );
  });
}

// ── 縮退理由コード → i18n キー ──────────────────────────────────────────

/**
 * バックエンドの縮退理由コードを i18n キー (ヘルプ文言) に対応付ける。
 * コードは `db/types.rs` の `QueryStatsSupport` ドキュメントと対で維持する。
 * 未知のコードは汎用メッセージへフォールバックする (前方互換)。
 */
export function supportReasonI18nKey(
  code: string,
):
  | "inspectorReasonUnsupportedDriver"
  | "inspectorReasonPerformanceSchemaOff"
  | "inspectorReasonConsumerOff"
  | "inspectorReasonDigestOff"
  | "inspectorReasonPgssMissing"
  | "inspectorReasonPgssNotPreloaded"
  | "inspectorReasonUnreadable"
  | "inspectorReasonUnknown" {
  switch (code) {
    case "unsupported_driver":
      return "inspectorReasonUnsupportedDriver";
    case "performance_schema_off":
      return "inspectorReasonPerformanceSchemaOff";
    case "statements_consumer_off":
      return "inspectorReasonConsumerOff";
    case "statements_digest_off":
      return "inspectorReasonDigestOff";
    case "pg_stat_statements_missing":
      return "inspectorReasonPgssMissing";
    case "pg_stat_statements_not_preloaded":
      return "inspectorReasonPgssNotPreloaded";
    case "stats_unreadable":
      return "inspectorReasonUnreadable";
    default:
      return "inspectorReasonUnknown";
  }
}

// ── 表示ユーティリティ ──────────────────────────────────────────────────

/** レイテンシ ms の人間向け表示: 1ms 未満は小数 2 桁、10s 以上は秒表記。 */
export function formatMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── フィンガープリント集計の並べ替えと書き出し (#1539) ─────────────────

/** 統計タブで並べ替えられる列。 */
export type StatSortKey = "calls" | "total" | "mean" | "max" | "rows" | "db" | "fingerprint";
export type StatSortDir = "asc" | "desc";
export interface StatSort {
  key: StatSortKey;
  dir: StatSortDir;
}

/** 文字列列は昇順、数値列は降順 (多い・遅いものが上) から始める。 */
export function defaultStatSortDir(key: StatSortKey): StatSortDir {
  return key === "db" || key === "fingerprint" ? "asc" : "desc";
}

/**
 * ヘッダクリックの遷移: 別の列なら既定の向きで開始 → 同じ列なら反転 → さらにクリックで
 * 並べ替え解除 (バックエンドが返す総時間降順に戻る)。
 */
export function nextStatSort(current: StatSort | null, key: StatSortKey): StatSort | null {
  if (current === null || current.key !== key) return { key, dir: defaultStatSortDir(key) };
  if (current.dir === defaultStatSortDir(key)) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return null;
}

type StatRowLike = {
  digest: string;
  database: string | null;
  calls: number;
  total_time_ms: number;
  mean_time_ms: number;
  max_time_ms: number;
  rows: number | null;
  n_plus_one: boolean;
};

/**
 * 差分行を並べ替えた新しい配列を返す (入力は変更しない)。`sort` が null なら入力順。
 * 値が無い (null) 行は向きに関わらず末尾、同値は元の順序を保つ (安定ソート)。
 * フィンガープリント列は `fingerprintOf(row)` の文字列で比較する。
 */
export function sortStatRows<T extends StatRowLike>(
  rows: readonly T[],
  sort: StatSort | null,
  fingerprintOf: (row: T) => string,
): T[] {
  if (sort === null) return [...rows];
  const factor = sort.dir === "asc" ? 1 : -1;
  const value = (r: T): number | string | null => {
    switch (sort.key) {
      case "calls":
        return r.calls;
      case "total":
        return r.total_time_ms;
      case "mean":
        return r.mean_time_ms;
      case "max":
        return r.max_time_ms;
      case "rows":
        return r.rows;
      case "db":
        return r.database;
      case "fingerprint":
        return fingerprintOf(r);
    }
  };
  return rows
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.index - b.index;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      let cmp: number;
      if (typeof a.v === "number" && typeof b.v === "number") cmp = a.v - b.v;
      else cmp = String(a.v).localeCompare(String(b.v));
      return cmp !== 0 ? cmp * factor : a.index - b.index;
    })
    .map((x) => x.row);
}

/** 書き出し用の列見出し (i18n 済みの文言を呼び出し側が渡す)。 */
export interface StatExportLabels {
  calls: string;
  total: string;
  mean: string;
  max: string;
  rows: string;
  db: string;
  fingerprint: string;
  nPlusOne: string;
}

/**
 * 表示中の統計行を書き出し用の表 (見出し + 行) にする。時間は ms の数値のまま
 * (表計算で集計しやすいよう単位付き文字列にしない)。N+1 目安は `Y` / 空。
 */
export function statRowsToTable<T extends StatRowLike>(
  rows: readonly T[],
  fingerprintOf: (row: T) => string,
  labels: StatExportLabels,
): { header: string[]; rows: (string | number | null)[][] } {
  return {
    header: [
      labels.calls,
      labels.total,
      labels.mean,
      labels.max,
      labels.rows,
      labels.db,
      labels.nPlusOne,
      labels.fingerprint,
    ],
    rows: rows.map((r) => [
      r.calls,
      r.total_time_ms,
      r.mean_time_ms,
      r.max_time_ms,
      r.rows,
      r.database,
      r.n_plus_one ? "Y" : "",
      fingerprintOf(r),
    ]),
  };
}

// ── テールの行から EXPLAIN (#1622) ─────────────────────────────────────

// 先頭の行コメントとブロックコメントと空白を取り除く。
function stripLeadingSqlComments(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1).trimStart();
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2).trimStart();
    } else {
      return s;
    }
  }
}

/**
 * ライブテールで観測した SQL 原文を EXPLAIN に渡せるかを判定する純関数 (#1622)。EXPLAIN のみ (ANALYZE は
 * 使わない) で、SELECT / INSERT / UPDATE / DELETE / REPLACE / WITH だけが対象。次のものは実行計画を
 * 取れないので `null` ではなく理由コードを返す:
 * - `masked`: 権限不足で本文が見えない
 * - `unsupported`: 計画の対象外の文 (DDL・SET など)
 * - `parameterized`: PostgreSQL の `$1` 形式のパラメータを含み、値が無いと計画を立てられない
 * 使えるなら `null`。
 */
export function tailExplainBlockReason(query: string): "masked" | "unsupported" | "parameterized" | null {
  if (isPrivilegeMasked(query)) return "masked";
  const body = stripLeadingSqlComments(query);
  if (!/^(select|insert|update|delete|replace|with)\b/i.test(body)) return "unsupported";
  if (/\$\d+/.test(body)) return "parameterized";
  return null;
}
