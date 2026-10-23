/**
 * 接続経路図 (#1754) の純ロジック。「ローカル → (踏み台 / 多段 jump) → 目標 DB」の
 * ノード列・ホップ間の線種・接続フェーズに応じた点灯位置を決める。DOM / i18n に依存せず、
 * `__tests__/connectionPath.test.ts` で境界ケースを固定する。
 *
 * - 図に出してよいのは入力中の**非秘密フィールド** (ホスト・ポート・SSM ターゲット)
 *   だけ。パスワード / パスフレーズ / 鍵のパスは入力型にそもそも含めない。
 * - 表示文言 (ローカル / 未入力のプレースホルダ) はコンポーネント側で i18n する。ここは
 *   `label: null` で「未入力」を表す。
 */

import type { ConnectionProfile } from "../api/tauri";

/** 接続経路の種別 (`ConnectionForm` のラジオ 3 択と同じ)。 */
export type PathRoute = "direct" | "ssh" | "ssm";

/** ノードの種別。 */
export type PathNodeKind = "local" | "jump" | "bastion" | "ssm" | "target";

export interface PathNode {
  kind: PathNodeKind;
  /** 表示名 (`host:port` など、長ければ中略済み)。ローカル / 未入力は null (呼び出し側で i18n)。 */
  label: string | null;
  /** 中略前の全文 (title / aria 用)。未入力は null。 */
  fullLabel: string | null;
}

/** ホップ間の線種。`tunnel` はブランドのティール (横線 = トンネル)、`plain` は直結。 */
export type PathEdgeKind = "tunnel" | "plain";

export interface ConnectionPath {
  nodes: PathNode[];
  /** `nodes.length - 1` 本。`edges[i]` は `nodes[i]` と `nodes[i + 1]` を結ぶ。 */
  edges: PathEdgeKind[];
}

/** 経路図の入力 (すべて非秘密)。ポートは入力途中の文字列も受ける。 */
export interface ConnectionPathInput {
  route: PathRoute;
  /** 目標 DB のホスト / ポート。 */
  host: string;
  port: number | string;
  ssh?: {
    host: string;
    port: number | string;
    jump?: { host: string; port: number | string } | null;
  } | null;
  ssm?: { target: string } | null;
}

/** 接続確立後を表す擬似フェーズ (バックエンドのフェーズではなくフロントが与える)。 */
export const CONNECTED_PHASE = "connected";

/** ラベルの最大文字数。これを超えたら中略する。 */
export const PATH_LABEL_MAX = 24;

/** 長いラベルを中略する (先頭と末尾を残す。コードポイント単位でサロゲートを壊さない)。 */
export function truncateMiddle(text: string, max: number = PATH_LABEL_MAX): string {
  const chars = Array.from(text);
  if (chars.length <= max || max < 3) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** `host:port` ラベル。ホストが空なら null、ポートが空 / 非数値ならホストのみ。 */
export function hostPortLabel(host: string, port: number | string): string | null {
  const h = host.trim();
  if (!h) return null;
  const p = String(port).trim();
  return /^\d+$/.test(p) && Number(p) > 0 ? `${h}:${p}` : h;
}

/** 全文ラベルから `PathNode` を作る (表示用は中略、全文は `fullLabel` に残す)。 */
function makeNode(kind: PathNodeKind, full: string | null): PathNode {
  return { kind, label: full === null ? null : truncateMiddle(full), fullLabel: full };
}

/**
 * 入力から経路 (ノード列 + 線種) を組み立てる。
 *
 * - 直接: ローカル → 目標 (線は `plain`)
 * - SSH: ローカル → [jump] → 踏み台 → 目標 (すべて `tunnel`)
 * - SSM: ローカル → SSM 踏み台 → 目標 (すべて `tunnel`)
 * - route が ssh / ssm でも該当設定が無ければ直接として描く。
 */
export function buildConnectionPath(input: ConnectionPathInput): ConnectionPath {
  const nodes: PathNode[] = [makeNode("local", null)];
  let edge: PathEdgeKind = "plain";
  if (input.route === "ssh" && input.ssh) {
    edge = "tunnel";
    if (input.ssh.jump) {
      nodes.push(makeNode("jump", hostPortLabel(input.ssh.jump.host, input.ssh.jump.port)));
    }
    nodes.push(makeNode("bastion", hostPortLabel(input.ssh.host, input.ssh.port)));
  } else if (input.route === "ssm" && input.ssm) {
    edge = "tunnel";
    const target = input.ssm.target.trim();
    nodes.push(makeNode("ssm", target || null));
  }
  nodes.push(makeNode("target", hostPortLabel(input.host, input.port)));
  return { nodes, edges: nodes.slice(1).map(() => edge) };
}

/** 点灯状態: 済 (done) / 進行中 (active) / 未到達 (pending)。 */
export type PathNodeState = "done" | "active" | "pending";

/**
 * 接続フェーズ (#684: `preparing` / `tunnel_connecting` / `tunnel_authenticating` /
 * `db_connecting`) から「いま進行中のノード」の添字を返す。
 *
 * - `preparing` / 未知のフェーズ: ローカル (0)
 * - `tunnel_connecting`: 最初のリモートホップ (1)
 * - `tunnel_authenticating`: トンネルの最終ホップ (目標の手前。単一ホップなら 1)
 * - `db_connecting`: 目標 (末尾)
 * - `connected` (確立済み): null = 全点灯・静止 (`nodeStateAt` / `edgeLitAt` が done 扱い)
 *
 * バックエンドはホップ単位のフェーズを流さないため、多段 jump の途中経過は
 * `tunnel_connecting` → `tunnel_authenticating` の 2 段階で近似する。
 */
export function activeIndexForPhase(nodeCount: number, phase: string): number | null {
  if (phase === CONNECTED_PHASE) return null;
  const last = Math.max(0, nodeCount - 1);
  switch (phase) {
    case "tunnel_connecting":
      return Math.min(1, last);
    case "tunnel_authenticating":
      return Math.min(Math.max(1, last - 1), last);
    case "db_connecting":
      return last;
    default:
      return 0;
  }
}

/** `active` が null なら確立済み / 静的表示 (全ノード done)。 */
export function nodeStateAt(index: number, active: number | null): PathNodeState {
  if (active === null) return "done";
  if (index < active) return "done";
  return index === active ? "active" : "pending";
}

/** ホップ `index` (= `nodes[index]` → `nodes[index + 1]`) が点灯済みか。進行中ノードへ向かう線まで点く。 */
export function edgeLitAt(index: number, active: number | null): boolean {
  return active === null || index < active;
}

/** スクリーンリーダー向けの要約 (「ローカル → host:port → …」)。 */
export function describePath(path: ConnectionPath, labels: (node: PathNode) => string): string {
  return path.nodes.map(labels).join(" → ");
}

/**
 * 保存済みプロファイルから経路図の入力を導出する (接続確立中の表示用)。SSH があれば SSH、
 * 無く SSM があれば SSM、どちらも無ければ直接。SQLite (ファイル) はネットワーク経路を
 * 持たないので null (図を出さない)。
 */
export function pathInputFromProfile(profile: ConnectionProfile): ConnectionPathInput | null {
  if (profile.file_path || profile.driver === "sqlite") return null;
  const route: PathRoute = profile.ssh ? "ssh" : profile.ssm ? "ssm" : "direct";
  return {
    route,
    host: profile.host,
    port: profile.port,
    ssh: profile.ssh
      ? {
          host: profile.ssh.host,
          port: profile.ssh.port,
          jump: profile.ssh.jump ? { host: profile.ssh.jump.host, port: profile.ssh.jump.port } : null,
        }
      : null,
    ssm: profile.ssm ? { target: profile.ssm.target } : null,
  };
}
