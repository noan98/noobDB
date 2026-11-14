import { splitSqlStatementRanges } from "../sqlScript";
import type { EditorMarker } from "./editorMarkers";

/**
 * バッチ実行 (#495) の各文の状態をエディタのガターに積むための純ロジック (#2331)。
 * CodeMirror には触れず、文の範囲の求め方・状態の決め方・同じ行の合成だけを持つ (単体テストしやすいように分ける)。
 */

/** ガターに出す状態。`pending` は未着手、`running` は実行中、`skipped` はエラー停止などで走らなかった文。 */
export type BatchMarkerStatus = "pending" | "running" | "ok" | "error" | "skipped";

/** ガターのマーカーに載せるデータ。`index` はカード (結果) の 0 始まりの番号。 */
export interface BatchMarkerData {
  index: number;
  status: BatchMarkerStatus;
  elapsedMs?: number;
}

/** 状態を決めるのに必要な結果の最小形 (`BatchStatementResult` の部分集合)。 */
export interface BatchResultLike {
  status: "ok" | "error" | "skipped";
  elapsedMs?: number;
}

/**
 * 実行した `script` が本文 `doc` のどこから始まるかを返す (見つからなければ -1)。
 * 選択範囲だけを実行したときは、選択の中身が `script` と (前後の空白を除いて) 一致する位置を優先するので、
 * 同じ文が本文に複数あっても選択した側の位置になる。一致しなければ最初の出現位置。
 */
export function locateScript(doc: string, script: string, selection?: { from: number; to: number }): number {
  if (script.length === 0) return -1;
  if (selection && selection.to > selection.from) {
    const raw = doc.slice(selection.from, selection.to);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim() === script.trim())
      return selection.from + lead - (script.length - script.trimStart().length);
  }
  return doc.indexOf(script);
}

/** `script` を文ごとに分け、本文上の範囲 (`base` を足したオフセット) にする。 */
export function batchRanges(script: string, base: number, driver?: string): { from: number; to: number }[] {
  return splitSqlStatementRanges(script, driver).map((r) => ({ from: base + r.from, to: base + r.to }));
}

/**
 * 文 `count` 個ぶんの状態を決める。結果が届いた文はその状態、届いていない文は実行中なら
 * 「先頭の 1 件が実行中・残りは待機」、実行が終わっていれば (停止・取消など) 「スキップ」。
 */
export function batchStatuses(
  count: number,
  results: readonly BatchResultLike[],
  running: boolean,
): BatchMarkerData[] {
  const out: BatchMarkerData[] = [];
  for (let i = 0; i < count; i++) {
    const r = results[i];
    if (r) out.push({ index: i, status: r.status, elapsedMs: r.elapsedMs });
    else if (!running) out.push({ index: i, status: "skipped" });
    else out.push({ index: i, status: i === results.length ? "running" : "pending" });
  }
  return out;
}

/** 状態の重さ (大きいほど優先)。同じ行に複数の文があるとき、最も重い状態で代表させる。 */
const WEIGHT: Record<BatchMarkerStatus, number> = { error: 4, running: 3, pending: 2, ok: 1, skipped: 0 };

/** 同じ行の文をまとめ、ガターに描く代表 1 件を返す (最も重い状態、同点なら先頭)。 */
export function composeBatchGroup(
  group: readonly EditorMarker<BatchMarkerData>[],
): EditorMarker<BatchMarkerData> {
  let best = group[0] as EditorMarker<BatchMarkerData>;
  for (const m of group) {
    if ((m.data ? WEIGHT[m.data.status] : -1) > (best.data ? WEIGHT[best.data.status] : -1)) best = m;
  }
  return best;
}

/** 所要時間の短い表記 (`12ms` / `1.2s`)。 */
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
