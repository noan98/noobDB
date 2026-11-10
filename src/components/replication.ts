// レプリケーション監視タブ (#2180) の純ロジック。副作用なし。
//
// 閾値の判定・メーターの位置・並べ替えを描画から切り離し、Vitest で固定する。

import type { ReplicationLink, ReplicationSlot } from "../api/tauri";
import type { LiveField } from "./liveDiff";

/** 使われていないスロットが WAL をこれ以上溜めたら先頭で警告する (1 GiB)。 */
export const SLOT_WAL_WARN_BYTES = 1024 * 1024 * 1024;

/** 遅延メーターの警告マーカー (秒)。これ以上は警告色にする。 */
export const LAG_WARN_SECS = 30;

/** 遅延メーターの目盛りの上限 (秒)。これ以上は満タン表示。 */
export const LAG_METER_MAX_SECS = 60;

/** 非アクティブで WAL を `threshold` バイト以上保持しているスロット (保持量の多い順)。 */
export function slotsHoldingWal(
  slots: readonly ReplicationSlot[],
  threshold: number = SLOT_WAL_WARN_BYTES,
): ReplicationSlot[] {
  return slots
    .filter((s) => !s.active && s.retained_bytes != null && s.retained_bytes >= threshold)
    .sort((a, b) => (b.retained_bytes ?? 0) - (a.retained_bytes ?? 0) || a.name.localeCompare(b.name));
}

/** `wal_status = 'lost'` のスロット (必要な WAL が失われ、もう使えない)。 */
export function slotsLost(slots: readonly ReplicationSlot[]): ReplicationSlot[] {
  return slots.filter((s) => s.wal_status === "lost");
}

/** 遅延 (秒) をメーターの位置 (0〜100%) にする。`null` / 負値 / 非有限値は 0。 */
export function lagMeterPercent(secs: number | null | undefined): number {
  if (secs == null || !Number.isFinite(secs) || secs <= 0) return 0;
  return Math.min(100, (secs / LAG_METER_MAX_SECS) * 100);
}

/** 警告マーカーの位置 (0〜100%)。 */
export function lagWarnPercent(): number {
  return (LAG_WARN_SECS / LAG_METER_MAX_SECS) * 100;
}

/** 遅延が警告の閾値以上か。`null` は判定不能なので偽。 */
export function isLagWarning(secs: number | null | undefined): boolean {
  return secs != null && Number.isFinite(secs) && secs >= LAG_WARN_SECS;
}

/** 遅延 (秒) を表示用に整形する。1 分未満は小数 1 桁の秒、それ以上は分・秒。 */
export function formatLagSecs(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)} s`;
  const total = Math.round(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

/** 接続先に異常があるか (停止中のスレッド・エラー・遅延超過)。行の強調に使う。 */
export function linkNeedsAttention(link: ReplicationLink): boolean {
  return (
    link.io_running === false ||
    link.sql_running === false ||
    link.last_error != null ||
    isLagWarning(link.lag_secs)
  );
}

/** 一覧の並び: 異常のある行 → 名前順。 */
export function sortLinks<T extends ReplicationLink>(links: readonly T[]): T[] {
  return [...links].sort(
    (a, b) => Number(linkNeedsAttention(b)) - Number(linkNeedsAttention(a)) || a.name.localeCompare(b.name),
  );
}

/**
 * スロットを削除する SQL。スロット名は識別子ではなく**文字列リテラル**として渡る (`pg_drop_replication_slot(name)`)
 * ので、識別子の引用ではなく `'` を `''` に重ねて埋め込む (PostgreSQL は標準準拠の文字列で `\` を特別扱いしない)。
 */
export function buildDropSlotSql(name: string): string {
  return `SELECT pg_drop_replication_slot('${name.replace(/'/g, "''")}')`;
}

/** 削除ボタンを無効にする理由。削除できるなら `null`。 */
export function dropSlotBlockedReason(
  slot: ReplicationSlot,
  readOnly: boolean,
): "readOnly" | "active" | null {
  if (readOnly) return "readOnly";
  if (slot.active) return "active";
  return null;
}

/**
 * 接続先カードの安定 key (#2213)。`sortLinks` で並びが変わっても同じ接続先は同じ key を保ち、
 * カードの DOM (と StatTile の CountUp) が作り直されない。配列の index は入れない。
 */
export function linkKey(link: ReplicationLink): string {
  return `${link.direction}\u0000${link.name}\u0000${link.address ?? ""}`;
}

/**
 * 一覧全体の key 列 (#2213)。同じ向き・名前・アドレスの接続先は現実に複数ありうる (`pg_basebackup` の
 * walsender が 2 本、Unix ソケット接続でアドレスが null など) ので、重複したときだけ出現順の連番を足して
 * 一意にする。入力 (並べ替え前) の順で数えるので、`sortLinks` で並びが変わっても同じ接続先は同じ key を保つ。
 * 重複を取り除くのではなく連番で区別する (接続先を消さない)。
 */
export function linkKeys(links: readonly ReplicationLink[]): string[] {
  const seen = new Map<string, number>();
  return links.map((l) => {
    const base = linkKey(l);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

/** `linkKeys` の key を載せた接続先。描画と差分計算の両方がこの key を使う。 */
export type KeyedLink = ReplicationLink & { key: string };

export function keyLinks(links: readonly ReplicationLink[]): KeyedLink[] {
  const keys = linkKeys(links);
  return links.map((l, i) => ({ ...l, key: keys[i] }));
}

/** `KeyedLink` の行 ID。 */
export function keyedLinkKey(l: KeyedLink): string {
  return l.key;
}

export type ReplicationLinkLiveField = "lag" | "lagWrite" | "lagFlush" | "lagBytes";

/** 接続先の値変化フラッシュ対象 (遅延・WAL 差分)。 */
export const REPLICATION_LINK_LIVE_FIELDS: readonly LiveField<ReplicationLink, ReplicationLinkLiveField>[] = [
  { name: "lag", changed: (a, b) => a.lag_secs !== b.lag_secs },
  { name: "lagWrite", changed: (a, b) => a.write_lag_secs !== b.write_lag_secs },
  { name: "lagFlush", changed: (a, b) => a.flush_lag_secs !== b.flush_lag_secs },
  { name: "lagBytes", changed: (a, b) => a.lag_bytes !== b.lag_bytes },
];

/** スロットの安定 key (スロット名はクラスタ内で一意)。 */
export function slotKey(slot: ReplicationSlot): string {
  return slot.name;
}

export type ReplicationSlotLiveField = "retained";

/** スロットの値変化フラッシュ対象 (WAL 保持量)。 */
export const REPLICATION_SLOT_LIVE_FIELDS: readonly LiveField<ReplicationSlot, ReplicationSlotLiveField>[] = [
  { name: "retained", changed: (a, b) => a.retained_bytes !== b.retained_bytes },
];

// ---- 要約タイル (#2215) ----

/** 一覧全体の要約値。 */
export interface ReplicationSummary {
  /** 全接続先のうち最大の遅延 (秒)。遅延を報告している接続先が無ければ `null`。 */
  maxLagSecs: number | null;
  /** スロットが保持している WAL の合計 (バイト)。保持量を報告しているスロットが無ければ `null`。 */
  retainedBytesTotal: number | null;
  /** 非アクティブなスロットの数。 */
  inactiveSlots: number;
}

const finiteOrNull = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(v) ? v : null;

/** 最大遅延・WAL 保持量の合計・非アクティブなスロット数。値が無いものは `null` / 0。 */
export function summarizeReplication(
  links: readonly ReplicationLink[],
  slots: readonly ReplicationSlot[],
): ReplicationSummary {
  let maxLagSecs: number | null = null;
  for (const l of links) {
    const v = finiteOrNull(l.lag_secs);
    if (v !== null && (maxLagSecs === null || v > maxLagSecs)) maxLagSecs = v;
  }
  let retainedBytesTotal: number | null = null;
  let inactiveSlots = 0;
  for (const s of slots) {
    const v = finiteOrNull(s.retained_bytes);
    if (v !== null) retainedBytesTotal = (retainedBytesTotal ?? 0) + v;
    if (!s.active) inactiveSlots += 1;
  }
  return { maxLagSecs, retainedBytesTotal, inactiveSlots };
}

// ---- 推移 (#2215) ----

/** 推移として保持するポーリング値の点数 (直近 N 点)。 */
export const REPLICATION_HISTORY_MAX = 30;

/** 推移の 1 点 (古い順)。計測できなかった回は `null`。 */
export type ReplicationSample = number | null;

/** 表示中のポーリング値の推移 (メモリのみ。履歴 DB には残さない)。 */
export interface ReplicationHistory {
  maxLag: ReplicationSample[];
  retainedTotal: ReplicationSample[];
  /** 接続先 key (`linkKeys`) ごとの遅延 (秒) の推移。 */
  linkLag: Record<string, ReplicationSample[]>;
}

export const EMPTY_REPLICATION_HISTORY: ReplicationHistory = {
  maxLag: [],
  retainedTotal: [],
  linkLag: {},
};

/** 末尾に 1 点足し、`max` 点を超えた古い側を捨てる。 */
export function pushSample(
  samples: readonly ReplicationSample[],
  value: ReplicationSample,
  max: number = REPLICATION_HISTORY_MAX,
): ReplicationSample[] {
  const next = [...samples, finiteOrNull(value)];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * 今回のポーリング結果を推移へ足す。いなくなった接続先の推移は捨て、新しく現れた接続先は
 * 空から始める (別の接続先の推移を引き継がない)。
 */
export function appendReplicationHistory(
  prev: ReplicationHistory,
  links: readonly KeyedLink[],
  slots: readonly ReplicationSlot[],
  max: number = REPLICATION_HISTORY_MAX,
): ReplicationHistory {
  const summary = summarizeReplication(links, slots);
  const linkLag: Record<string, ReplicationSample[]> = {};
  for (const l of links) linkLag[l.key] = pushSample(prev.linkLag[l.key] ?? [], l.lag_secs, max);
  return {
    maxLag: pushSample(prev.maxLag, summary.maxLagSecs, max),
    retainedTotal: pushSample(prev.retainedTotal, summary.retainedBytesTotal, max),
    linkLag,
  };
}

/** 推移の末尾 2 点の差 (今回 − 前回)。どちらかが欠測、または 2 点未満なら `null`。 */
export function sampleDelta(samples: readonly ReplicationSample[] | undefined): number | null {
  if (!samples || samples.length < 2) return null;
  const a = samples[samples.length - 1];
  const b = samples[samples.length - 2];
  return a === null || b === null ? null : a - b;
}

// ---- トポロジー図 (#2215) ----

/** 図の 1 側に描く接続先の上限。これを超えた分は「ほか N 件」にまとめる。 */
export const TOPOLOGY_MAX_PER_SIDE = 5;

/** この秒数以上の遅延は「やや遅れ」。警告 (`LAG_WARN_SECS` = 30 秒) の手前の目安。 */
export const LAG_SLOW_SECS = 5;

/**
 * 矢印の段階。`unknown`: 遅延を報告していない。`ok`: 遅れなし。`slow`: やや遅れ。`warn`: 警告の閾値以上。
 * 色だけに頼らず、太さ (`edgeThickness`) でも伝える。
 */
export type TopologyLagLevel = "unknown" | "ok" | "slow" | "warn";

export function topologyLagLevel(secs: number | null | undefined): TopologyLagLevel {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return "unknown";
  if (secs >= LAG_WARN_SECS) return "warn";
  if (secs >= LAG_SLOW_SECS) return "slow";
  return "ok";
}

/** 段階 → 矢印の太さ (1〜3)。遅いほど太くして目に入れる。 */
export function edgeThickness(level: TopologyLagLevel): 1 | 2 | 3 {
  return level === "warn" ? 3 : level === "slow" ? 2 : 1;
}

export interface TopologyPeer {
  key: string;
  name: string;
  address: string | null;
  lagSecs: number | null;
  level: TopologyLagLevel;
  thickness: 1 | 2 | 3;
  /** 停止中のスレッド・エラー・遅延超過のいずれか (ノードを警告の意味色にする)。 */
  attention: boolean;
}

export interface TopologyLayout {
  /** 自ノードへ流れ込む側 (上流)。 */
  upstream: TopologyPeer[];
  /** 自ノードから流れ出す側 (下流)。 */
  downstream: TopologyPeer[];
  /** 上限を超えて図に出さなかった件数。 */
  upstreamMore: number;
  downstreamMore: number;
}

function toPeer(l: KeyedLink): TopologyPeer {
  const level = topologyLagLevel(l.lag_secs);
  return {
    key: l.key,
    name: l.name,
    address: l.address,
    // 負値は段階 (`unknown`) と揃えて報告なし扱いにする。
    lagSecs: level === "unknown" ? null : l.lag_secs,
    level,
    thickness: edgeThickness(level),
    attention: linkNeedsAttention(l),
  };
}

/**
 * 自ノードを中心にした図の配置。上流・下流とも異常のあるノード → 名前順 (`sortLinks`) で並べ、
 * 各側 `max` 件まで描く (超えた分は件数だけ返す)。接続先が無ければ両側とも空。
 */
export function layoutTopology(
  links: readonly KeyedLink[],
  max: number = TOPOLOGY_MAX_PER_SIDE,
): TopologyLayout {
  const side = (dir: ReplicationLink["direction"]) => {
    const peers = sortLinks(links.filter((l) => l.direction === dir)).map(toPeer);
    return { shown: peers.slice(0, max), more: Math.max(0, peers.length - max) };
  };
  const up = side("upstream");
  const down = side("downstream");
  return { upstream: up.shown, downstream: down.shown, upstreamMore: up.more, downstreamMore: down.more };
}
