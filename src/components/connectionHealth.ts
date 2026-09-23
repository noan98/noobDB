/**
 * 接続横断のヘルスダッシュボード (#1068) の純ロジック。副作用なし (DOM / タイマーは
 * 呼び出し側から注入する) なので Vitest で単体テストできる。
 *
 * ## 新しい IPC を増やさない
 *
 * 1 接続あたりのヘルスチェックは **既存の 3 コマンドの合成** で作る:
 *
 * | 項目 | 使う IPC | 備考 |
 * |---|---|---|
 * | up / down・往復レイテンシ | `ping_session` (`SELECT 1`) | 往復時間はフロントで計測 |
 * | サーババージョン | `server_info` | 読み取り専用 introspection。セッション単位でキャッシュ |
 * | 現在の接続数 | `server_metrics` | サーバを持たないドライバでは呼ばない (N/A) |
 *
 * いずれも読み取り専用のため read_only セッションでも動く。バックエンドに新しい
 * 重い経路を足さず、既存コマンドの並列・個別タイムアウト付き呼び出しだけで賄う。
 *
 * ## 勝手に接続しない
 *
 * 対象は **いま開いているセッションだけ**。保存済みで未接続のプロファイルは
 * 「未接続」行として並べるだけで、ここから接続を張ることはない (接続はユーザの
 * 明示操作 = 行の「接続」ボタンのみ)。SSH トンネルを大量に同時に張る事故を防ぐ。
 *
 * ## 1 接続の遅延が他をブロックしない
 *
 * 各呼び出しは `withTimeout` で個別に打ち切り、`checkAllConnections` は並列度を
 * 制限した `mapLimited` で回す。タイムアウトした問い合わせはバックエンド側では走り
 * 続けうるため、`createHealthProber` が **前回の問い合わせが返っていないセッション
 * には新しい問い合わせを積まない** (ポーリングでリクエストが積み重ならない)。
 */

import { mapLimited } from "./mapLimited";

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

/** 注入する IPC。`api.pingSession` / `api.serverInfo` / `api.serverMetrics` を渡す。 */
export interface HealthDeps {
  ping: (sessionId: string) => Promise<boolean>;
  version: (sessionId: string) => Promise<string>;
  connections: (sessionId: string) => Promise<number | null>;
  /** 単調増加の時計 (ms)。既定は `performance.now`。 */
  now?: () => number;
}

/** 同時に問い合わせる接続数の上限。SSH トンネル越しの接続を一斉に叩かない。 */
export const HEALTH_CHECK_CONCURRENCY = 4;
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
  return driver === "sqlite" || driver === "duckdb";
}

/** `withTimeout` の結果。 */
export type TimedResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "error" }
  | { kind: "timeout" };

/**
 * promise を `ms` で打ち切る。失敗は例外にせず `{kind:"error"}` に畳む — エラー文面
 * (接続先情報を含みうる) を画面・ログに流さないため、ここで捨てる。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<TimedResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "ok", value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "error" });
      },
    );
  });
}

/** ヘルスチェック 1 回ぶんの設定。 */
export interface ProbeOptions {
  timeoutMs?: number;
  /** キャッシュ済みのバージョン。あれば `server_info` を呼ばない。 */
  cachedVersion?: string | null;
}

/**
 * 1 接続のヘルスチェック。ping が通ったときだけバージョン / 接続数を取りにいく
 * (死んだ接続へ追い打ちしない)。バージョンと接続数は互いに独立に並列で取り、
 * 片方の失敗・タイムアウトはもう片方と up 判定に影響させない。
 */
export async function probeConnectionHealth(
  target: HealthTarget,
  deps: HealthDeps,
  opts: ProbeOptions = {},
): Promise<HealthProbeResult> {
  const timeoutMs = opts.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const now = deps.now ?? (() => performance.now());
  const serverless = isServerlessDriver(target.driver);

  const started = now();
  const ping = await withTimeout(deps.ping(target.sessionId), timeoutMs);
  const elapsed = Math.max(0, Math.round(now() - started));
  const cachedVersion = opts.cachedVersion ?? null;

  if (ping.kind === "timeout") return timedOutResult(target, cachedVersion);
  if (ping.kind === "error" || !ping.value) {
    return {
      status: "down",
      latencyMs: null,
      version: cachedVersion,
      connections: serverless ? "na" : null,
    };
  }

  const [version, connections] = await Promise.all([
    cachedVersion !== null
      ? Promise.resolve<TimedResult<string>>({ kind: "ok", value: cachedVersion })
      : withTimeout(deps.version(target.sessionId), timeoutMs),
    serverless
      ? Promise.resolve<TimedResult<number | null>>({ kind: "ok", value: null })
      : withTimeout(deps.connections(target.sessionId), timeoutMs),
  ]);

  return {
    status: "up",
    latencyMs: elapsed,
    version: version.kind === "ok" && version.value.trim() !== "" ? version.value.trim() : null,
    connections: serverless ? "na" : connections.kind === "ok" ? connections.value : null,
  };
}

/** 問い合わせを打てなかった / 打ち切ったときの結果 (キャッシュ済みの値は保つ)。 */
function timedOutResult(target: HealthTarget, cachedVersion: string | null | undefined): HealthProbeResult {
  return {
    status: "timeout",
    latencyMs: null,
    version: cachedVersion ?? null,
    connections: isServerlessDriver(target.driver) ? "na" : null,
  };
}

/**
 * 前回の問い合わせが返っていないセッションへ次の問い合わせを積まないプローバ。
 * `withTimeout` はフロント側で待つのをやめるだけで、Rust 側の `SELECT 1` は応答の
 * 無い接続で走り続ける。そのままポーリングすると未完了のリクエストが溜まり続ける
 * ため、IPC ごと (ping / version / connections × セッション) に in-flight を追跡し、
 * 返っていないものは呼ばずにタイムアウト扱い (ping) / 取得不可扱い (その他) にする。
 */
export function createHealthProber(deps: HealthDeps) {
  const pending = new Set<string>();
  function guard<T>(kind: string, fn: (sessionId: string) => Promise<T>) {
    return (sessionId: string): Promise<T> => {
      const key = `${kind}:${sessionId}`;
      if (pending.has(key)) return Promise.reject(new Error("in flight"));
      pending.add(key);
      return fn(sessionId).finally(() => pending.delete(key));
    };
  }
  const guarded: HealthDeps = {
    ping: guard("ping", deps.ping),
    version: guard("version", deps.version),
    connections: guard("connections", deps.connections),
    now: deps.now,
  };
  return {
    /** 前回の ping がまだ返っていないセッションか。 */
    isInFlight: (sessionId: string) => pending.has(`ping:${sessionId}`),
    probe(target: HealthTarget, opts: ProbeOptions = {}): Promise<HealthProbeResult> {
      if (pending.has(`ping:${target.sessionId}`)) {
        return Promise.resolve(timedOutResult(target, opts.cachedVersion));
      }
      return probeConnectionHealth(target, guarded, opts);
    },
  };
}

/**
 * 開いている全接続を並列度を制限してチェックする。結果は `targets` と同じ順。
 * 1 接続の遅延は `probe` 側の個別タイムアウトで打ち切られるため、他の接続の
 * 結果を待たせない (ワーカーは空いた順に次の対象へ進む)。
 */
export function checkAllConnections(
  targets: readonly HealthTarget[],
  probe: (target: HealthTarget) => Promise<HealthProbeResult>,
  concurrency: number = HEALTH_CHECK_CONCURRENCY,
): Promise<HealthProbeResult[]> {
  return mapLimited([...targets], concurrency, probe);
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
