/**
 * 接続横断のヘルスダッシュボード (#1068) の純ロジック。副作用なし (DOM / タイマーは
 * 呼び出し側から注入する) なので Vitest で単体テストできる。
 *
 * ## 取得はバックエンド 1 コマンド (#1259)
 *
 * 全セッションぶんの観測 (up / down・往復レイテンシ・バージョン・接続数) は
 * `health_probe_all` 1 回で Rust 側がまとめて取る。Rust は AppState からセッションを
 * 引いて並列に問い合わせ、各問い合わせを `tokio::time::timeout` で包む (タイムアウトで
 * future を drop して問い合わせ自体を止める)。接続数は専用の軽量クエリ、バージョンは
 * セッション単位でキャッシュ。ここは **返ってきた生の観測値を表示用の状態に畳む**
 * 判定 (`toHealthProbeResult`) と、行の組み立て・集計だけを持つ。
 *
 * いずれも読み取り専用のため read_only セッションでも動く。
 *
 * ## 勝手に接続しない
 *
 * 対象は **いま開いているセッションだけ**。保存済みで未接続のプロファイルは
 * 「未接続」行として並べるだけで、ここから接続を張ることはない (接続はユーザの
 * 明示操作 = 行の「接続」ボタンのみ)。SSH トンネルを大量に同時に張る事故を防ぐ。
 */


/** 1 接続のヘルス状態。 */
export type HealthStatus =
  /** `SELECT 1` が返った。 */
  | "up"
  /** `SELECT 1` が失敗した (接続断・トンネル断など)。 */
  | "down"
  /** 個別タイムアウト内に返らなかった (前回分がまだ返っていない場合も含む)。 */
  | "timeout"
  /** まだ一度も確認していない。 */
  | "unknown"
  /** 保存済みだが開いていない (確認しない)。 */
  | "notConnected";

/** 1 接続ぶんのヘルスチェック結果。 */
export interface HealthProbeResult {
  status: Exclude<HealthStatus, "unknown" | "notConnected">;
  /** `ping_session` の往復時間 (ms)。down / timeout では null。 */
  latencyMs: number | null;
  /** サーババージョン。取得できなければ null。 */
  version: string | null;
  /**
   * 現在の接続数。サーバを持たないドライバは `"na"`、取得に失敗したら null。
   */
  connections: number | "na" | null;
}

/** ヘルスチェック対象 (開いているセッション)。 */
export interface HealthTarget {
  sessionId: string;
  driver: string;
}

/** `health_probe_all` が返す 1 セッション分の生の観測値 (`api.healthProbeAll`)。 */
export interface HealthProbeItemLike {
  session_id: string;
  status: "up" | "down" | "timeout";
  latency_ms: number | null;
  version: string | null;
  connections: number | null;
}

/** 1 回の問い合わせの個別タイムアウト (ms)。 */
export const HEALTH_PROBE_TIMEOUT_MS = 5_000;
/** レイテンシの段階判定のしきい値 (ms)。この値「以上」で次の段階。 */
export const LATENCY_SLOW_MS = 200;
export const LATENCY_CRITICAL_MS = 1_000;

/**
 * サーバを持たない (ファイル / インプロセス) ドライバ。接続数などサーバ統計は
 * 概念が無いので N/A に縮退する (`server_metrics` もハードエラーを返す)。
 */
export function isServerlessDriver(driver: string): boolean {
  return driver === "sqlite";
}

/**
 * `health_probe_all` の 1 項目 → 表示用の結果。サーバを持たないドライバの接続数は
 * 概念が無いので常に `"na"`、取得に失敗した (null) サーバ型は null のまま。
 * 空白だけのバージョンは null に正規化する。
 */
export function toHealthProbeResult(
  target: HealthTarget,
  item: HealthProbeItemLike | undefined,
): HealthProbeResult {
  const serverless = isServerlessDriver(target.driver);
  // バックエンドが項目を返さなかった (想定外) ときは down 扱い。
  const status = item?.status ?? "down";
  const version = item?.version?.trim() ? item.version.trim() : null;
  return {
    status,
    latencyMs: status === "up" ? (item?.latency_ms ?? null) : null,
    version,
    connections: serverless ? "na" : status === "up" ? (item?.connections ?? null) : null,
  };
}

/** ダッシュボードの 1 行 (ソース: 開いている接続 + 任意で保存済みプロファイル)。 */
export interface HealthRow {
  profileId: string;
  name: string;
  driver: string;
  /** `user@host:port` / ファイルパスなど、秘密を含まない接続先の表示。 */
  target: string;
  /** 開いているセッション id。未接続なら null。 */
  sessionId: string | null;
  isActive: boolean;
  isProduction: boolean;
  readOnly: boolean;
  status: HealthStatus;
  latencyMs: number | null;
  version: string | null;
  connections: number | "na" | null;
}

/** 行の組み立てに要るプロファイルの最小形 (秘密を含むフィールドは受け取らない)。 */
export interface HealthProfileLike {
  id: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  user: string;
  database: string | null;
  file_path?: string | null;
  is_production: boolean;
  read_only: boolean;
}

/**
 * 接続先の表示文字列。パスワード・パスフレーズは受け取らない型なので混入しない。
 * SSH 経由でも DB 側の宛先だけを出す (踏み台の情報は ConnectionList 側の責務)。
 */
export function formatHealthTarget(p: HealthProfileLike): string {
  if (isServerlessDriver(p.driver)) return p.file_path ?? "";
  const host = p.host ? `${p.host}${p.port ? `:${p.port}` : ""}` : "";
  const who = p.user && host ? `${p.user}@${host}` : host;
  return p.database ? `${who}${who ? " · " : ""}${p.database}` : who;
}

/**
 * ダッシュボードの行を組み立てる。開いている接続を先 (アクティブを先頭) に、
 * `includeSaved` なら未接続の保存済みプロファイルを後ろに名前順で並べる。
 * 未接続行は `notConnected` で、ヘルスチェックの対象にしない。
 */
export function buildHealthRows(
  open: readonly { sessionId: string; profile: HealthProfileLike }[],
  saved: readonly HealthProfileLike[],
  results: ReadonlyMap<string, HealthProbeResult>,
  opts: { activeSessionId: string | null; includeSaved: boolean },
): HealthRow[] {
  const openRows: HealthRow[] = open.map(({ sessionId, profile }) => {
    const r = results.get(sessionId);
    return {
      profileId: profile.id,
      name: profile.name,
      driver: profile.driver,
      target: formatHealthTarget(profile),
      sessionId,
      isActive: sessionId === opts.activeSessionId,
      isProduction: profile.is_production,
      readOnly: profile.read_only,
      status: r?.status ?? "unknown",
      latencyMs: r?.latencyMs ?? null,
      version: r?.version ?? null,
      connections: r?.connections ?? (isServerlessDriver(profile.driver) ? "na" : null),
    };
  });
  openRows.sort((a, b) => Number(b.isActive) - Number(a.isActive));
  if (!opts.includeSaved) return openRows;
  const openIds = new Set(open.map((o) => o.profile.id));
  const savedRows: HealthRow[] = saved
    .filter((p) => !openIds.has(p.id))
    .map((p) => ({
      profileId: p.id,
      name: p.name,
      driver: p.driver,
      target: formatHealthTarget(p),
      sessionId: null,
      isActive: false,
      isProduction: p.is_production,
      readOnly: p.read_only,
      status: "notConnected" as const,
      latencyMs: null,
      version: null,
      connections: isServerlessDriver(p.driver) ? ("na" as const) : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...openRows, ...savedRows];
}

/** レイテンシの段階。 */
export type LatencyLevel = "good" | "slow" | "critical";

export function latencyLevel(ms: number): LatencyLevel {
  if (ms >= LATENCY_CRITICAL_MS) return "critical";
  if (ms >= LATENCY_SLOW_MS) return "slow";
  return "good";
}

/** 状態 → 意味色の役割 (`semanticColorToken` に渡す)。null は中立 (muted)。 */
export function healthStatusRole(
  status: HealthStatus,
): "success" | "warning" | "danger" | null {
  switch (status) {
    case "up":
      return "success";
    case "timeout":
      return "warning";
    case "down":
      return "danger";
    default:
      return null;
  }
}

/** 集計サマリ。 */
export interface HealthSummary {
  open: number;
  up: number;
  down: number;
  timeout: number;
  unknown: number;
  notConnected: number;
  /** up の接続のうち最大レイテンシ (ms)。1 件も無ければ null。 */
  maxLatencyMs: number | null;
  /** up の接続のレイテンシ中央値 (ms)。1 件も無ければ null。 */
  medianLatencyMs: number | null;
}

export function summarizeHealth(rows: readonly HealthRow[]): HealthSummary {
  const s: HealthSummary = {
    open: 0,
    up: 0,
    down: 0,
    timeout: 0,
    unknown: 0,
    notConnected: 0,
    maxLatencyMs: null,
    medianLatencyMs: null,
  };
  const latencies: number[] = [];
  for (const r of rows) {
    s[r.status] += 1;
    if (r.status !== "notConnected") s.open += 1;
    if (r.status === "up" && r.latencyMs !== null) latencies.push(r.latencyMs);
  }
  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    s.maxLatencyMs = latencies[latencies.length - 1];
    const mid = Math.floor(latencies.length / 2);
    s.medianLatencyMs =
      latencies.length % 2 === 1
        ? latencies[mid]
        : Math.round((latencies[mid - 1] + latencies[mid]) / 2);
  }
  return s;
}

/**
 * 前回から「目に見えて変わった」接続 (セッション id) を返す。行のフラッシュ表示用。
 * レイテンシは毎回揺れるので、数値ではなく段階 (`latencyLevel`) の変化だけを数える。
 * 初回 (前回結果が無い) はフラッシュしない。
 */
export function changedHealthSessions(
  prev: ReadonlyMap<string, HealthProbeResult>,
  next: ReadonlyMap<string, HealthProbeResult>,
): Set<string> {
  const out = new Set<string>();
  for (const [sid, n] of next) {
    const p = prev.get(sid);
    if (!p) continue;
    const level = (r: HealthProbeResult) => (r.latencyMs === null ? null : latencyLevel(r.latencyMs));
    if (
      p.status !== n.status ||
      p.version !== n.version ||
      p.connections !== n.connections ||
      level(p) !== level(n)
    ) {
      out.add(sid);
    }
  }
  return out;
}

/** 閉じたセッションの結果を捨てる (id 再利用で古い状態が出ないように)。 */
export function pruneHealthResults(
  results: ReadonlyMap<string, HealthProbeResult>,
  liveSessionIds: Iterable<string>,
): Map<string, HealthProbeResult> {
  const live = new Set(liveSessionIds);
  const out = new Map<string, HealthProbeResult>();
  for (const [sid, r] of results) if (live.has(sid)) out.set(sid, r);
  return out;
}
