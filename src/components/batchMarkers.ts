import { splitSqlStatementRanges } from "../sqlScript";
import type { EditorMarker } from "./editorMarkers";

/**
 * バッチ実行 (#495) の各文の状態をエディタのガターに積むための純ロジック (#2331)。
 * CodeMirror には触れず、文の範囲の求め方・状態の決め方・同じ行の合成だけを持つ (単体テストしやすいように分ける)。
 */

/**
 * ガターに出す状態。`pending` は未着手、`running` は実行中、`skipped` はエラー停止などで走らなかった文、
 * `interrupted` は結果が届かないまま実行が終わった文のうち先頭の 1 件 (取消・切断。実行中だった文なので、
 * 自動コミットで確定している可能性があり結果は不明)。`none` はガターに出さない文 (全体を 1 トランザクションで
 * 包んだ実行でバックエンドが読み飛ばす BEGIN / COMMIT などの制御文)。
 */
export type BatchMarkerStatus = "pending" | "running" | "ok" | "error" | "skipped" | "interrupted" | "none";

/** ガターのマーカーに載せるデータ。`index` はカード (結果) の 0 始まりの番号 (`none` は -1)。 */
export interface BatchMarkerData {
  index: number;
  status: BatchMarkerStatus;
  elapsedMs?: number;
  /** 実行時点の文の本文 (結果の `sql` との突き合わせ用。編集しても変わらない)。 */
  text: string;
}

/** 状態を決めるのに必要な結果の最小形 (`BatchStatementResult` の部分集合)。 */
export interface BatchResultLike {
  sql: string;
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

/** 文頭のコメント・空白を読み飛ばした位置 (`text` 内のオフセット)。ガターは最初のコード行に出す。 */
export function codeStart(text: string): number {
  const m = /^(?:\s+|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(text);
  const n = m ? m[0].length : 0;
  return n < text.length ? n : 0;
}

/**
 * `script` を文ごとに分け、本文上の範囲 (`base` を足したオフセット) にする。`from` は文頭のコメントを
 * 飛ばした位置 (ガターの行・編集の判定に使う)、`text` は結果の `sql` と突き合わせる全文。
 */
export function batchRanges(
  script: string,
  base: number,
  driver?: string,
): { from: number; to: number; text: string }[] {
  return splitSqlStatementRanges(script, driver).map((r) => ({
    from: base + r.from + codeStart(r.text),
    to: base + r.to,
    text: r.text,
  }));
}

/** 突き合わせ用に正規化する (前後の空白と末尾の `;` を除く)。 */
function norm(sql: string): string {
  return sql
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

/** トランザクション制御文か (バックエンドの `classify_tx_statement` を大まかに写す)。コメントは除いて判定する。 */
export function isTxControlStatement(text: string): boolean {
  const body = text.slice(codeStart(text));
  return /^(?:begin(?!\s+(?:try|catch)\b)|start\s+transaction|commit|end|rollback(?!\s+to\b))\b/i.test(body);
}

/**
 * 各文の状態を決める。結果 (`results`) は前から順に文と突き合わせる (文の数と結果の数が同じなら番号で対応)。
 * 全体を 1 トランザクションで包む実行 (`wrapped`) では、バックエンドが BEGIN / COMMIT などを読み飛ばして結果を
 * 送らないので、本文が一致しない制御文は `none` (ガターに出さない) にする。包まない実行では制御文にも結果が届くので、
 * 通常の文として扱う。
 *
 * 結果が無い文のうち先頭の 1 件は、実行中ならば `running`、実行が終わっていれば `interrupted` (取消・切断で
 * 結果不明)。2 件目以降は、実行中なら `pending`、終わっていれば `skipped`。エラー停止の残りは、バックエンドが
 * 明示的に skipped の結果を送るので、結果として突き合わされる。
 */
export function batchStatuses(
  texts: readonly string[],
  results: readonly BatchResultLike[],
  running: boolean,
  wrapped = false,
): BatchMarkerData[] {
  const byIndex = texts.length === results.length;
  const out: BatchMarkerData[] = [];
  let j = 0;
  let waiting = 0;
  texts.forEach((text, i) => {
    const r = results[byIndex ? i : j];
    if (r && (byIndex || norm(r.sql) === norm(text))) {
      out.push({ index: byIndex ? i : j, status: r.status, elapsedMs: r.elapsedMs, text });
      if (!byIndex) j++;
      return;
    }
    if (wrapped && isTxControlStatement(text)) {
      out.push({ index: -1, status: "none", text });
      return;
    }
    const first = waiting++ === 0;
    const status: BatchMarkerStatus = running
      ? first
        ? "running"
        : "pending"
      : first
        ? "interrupted"
        : "skipped";
    out.push({ index: results.length + waiting - 1, status, text });
  });
  return out;
}

/** 状態の重さ (大きいほど優先)。同じ行に複数の文があるとき、最も重い状態で代表させる。 */
const WEIGHT: Record<BatchMarkerStatus, number> = {
  error: 6,
  running: 5,
  interrupted: 4,
  pending: 3,
  ok: 2,
  skipped: 1,
  none: 0,
};

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
