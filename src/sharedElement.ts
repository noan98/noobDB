import { useSyncExternalStore } from "react";
import { durations } from "./motion";

/**
 * サーフェス横断の shared-element 連続性 (#1415)。
 *
 * サイドバーのテーブル行をダブルクリックして**新しいタブ**が開くとき、行のアイコン
 * (起点) から生成タブのアイコン (終点) へ Motion の `layoutId` で morph させる。
 * 頻度の低い遷移 (タブ生成) に限定し、高頻度の操作 (タブ切替・行選択) には足さない。
 *
 * ## なぜ「飛行中だけ」layoutId を付けるのか
 *
 * 起点 (サイドバー行) は終点 (タブ) が現れたあとも DOM に残る。同じ `layoutId` を
 * 常時持たせると、Motion の共有レイアウトでは先に居た要素が「follower」として
 * フェードアウトを受け続ける。そこで `open_table` の IPC を始める時点で
 * `beginTabOpenFlight` を呼んで起点だけに ID を与え、タブが現れて morph が
 * 終わる頃に `endTabOpenFlight` で外す。終点は同じ ID を持つ新規タブだけが付ける。
 *
 * - ID は `db.table` から決まる (接続は同時に 1 つのツリーしか描画しない)。
 * - 飛行中は常に高々 1 つ。複数ウィンドウは別 JS コンテキストなので衝突しない。
 * - 既存の `layoutId` (TabBar / Segmented 等) は `useId` 由来の接頭辞付きで別名前空間。
 * - reduced-motion はルートの `MotionConfig` が layout アニメを即時化するので、
 *   個別の分岐は持たない (`motion.ts` の方針)。
 */

/** 起点と終点が共有する layoutId。`db` / `table` の組で一意。 */
export function tabOpenFlightId(database: string, table: string): string {
  return `tab-open-flight:${JSON.stringify([database, table])}`;
}

/**
 * morph が終わったと見なして ID を外すまでの待ち (ms)。タブの出現
 * (`transitions.enter`) と layout の移動 (`transitions.emphasized` = `durations.med`)
 * を余裕を持って覆う長さ。新しい duration は足さず既存トークンから導く。
 */
export const TAB_OPEN_FLIGHT_MS = Math.round((durations.med + durations.fast) * 1000);

/**
 * タブが現れないまま (IPC のハング・既存タブの再選択など) ID が残り続けないための保険。
 * `begin` が張り、`end` が張り直す。
 */
export const TAB_OPEN_FLIGHT_MAX_MS = Math.round(durations.slow * 1000 * 10);

let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(next: string | null) {
  if (current === next) return;
  current = next;
  for (const l of listeners) l();
}

/** 新規テーブルタブを開く直前に呼ぶ。起点行のアイコンに layoutId が付く。 */
export function beginTabOpenFlight(database: string, table: string): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    emit(null);
  }, TAB_OPEN_FLIGHT_MAX_MS);
  emit(tabOpenFlightId(database, table));
}

/**
 * タブが追加されたあと (または開かないと分かったとき) に呼ぶ。`id` が現在の飛行と
 * 一致するときだけ作用し、連続して開いた別テーブルの飛行を巻き込まない。
 * 通常は morph の尺だけ待ってから外し、`force` なら即時に外す。
 * (IPC がハングした場合は `begin` が張った保険のタイマーで外れる。)
 */
export function endTabOpenFlight(id: string, force = false): void {
  if (current !== id) return;
  if (timer) clearTimeout(timer);
  if (force) {
    timer = null;
    emit(null);
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    emit(null);
  }, TAB_OPEN_FLIGHT_MS);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 飛行中の layoutId (無ければ null)。 */
export function useTabOpenFlight(): string | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/**
 * 指定テーブルが飛行中なら layoutId、そうでなければ null。行ごとに購読しても
 * 自分の値が変わらない限り再描画されない (数百行のツリーを巻き込まない)。
 */
export function useTabOpenFlightFor(database: string, table: string): string | null {
  const id = tabOpenFlightId(database, table);
  return useSyncExternalStore(subscribe, () => (current === id ? id : null), () => null);
}

/** テスト用: 状態を初期化する。 */
export function resetTabOpenFlightForTest(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  emit(null);
}
