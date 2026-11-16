/**
 * 結果グリッドの「位置マーカーの帯」(overview ruler, #2381) の純ロジック。
 *
 * 表示中の全行について「どの行にどの状態があるか」を 1 バイトのマスクに集約し、帯の高さ (px) へ
 * 圧縮してティック列にする。描画 (Canvas) とホバー/クリックの座標変換はここの結果を使うだけで、
 * 10 万行でも行ごとの DOM を作らずに済む。列ヘッダのミニ分布 (#2383) のような「全行の集計を
 * 小さな図で描く」部品もこのモジュールのバケット化 (`bucketOf`) を共有できる。
 *
 * 状態は 3 本のレーン (左から 検索ヒット / 未適用の変更 / 再実行差分) に分けて描く。
 * 別レーンの状態は並んで見え、同じレーン内で重なったときだけ優先度で 1 色に絞る
 * (削除 > 編集、追加 > 変更)。
 */

export type RulerKind = "find" | "delete" | "edit" | "added" | "changed";
export type RulerLane = 0 | 1 | 2;

export interface RulerKindDef {
  kind: RulerKind;
  /** マスクのビット。 */
  bit: number;
  lane: RulerLane;
  /** 同じレーン内での優先度 (大きいほど勝つ)。 */
  priority: number;
}

export const RULER_LANE_COUNT = 3;

export const RULER_KINDS: readonly RulerKindDef[] = [
  { kind: "find", bit: 1, lane: 0, priority: 1 },
  { kind: "edit", bit: 2, lane: 1, priority: 1 },
  { kind: "delete", bit: 4, lane: 1, priority: 2 },
  { kind: "changed", bit: 8, lane: 2, priority: 1 },
  { kind: "added", bit: 16, lane: 2, priority: 2 },
];

const DEF_BY_KIND = new Map<RulerKind, RulerKindDef>(RULER_KINDS.map((d) => [d.kind, d]));

/** 「変更」として F8 で辿る種別 (検索ヒットは検索バーの Enter で辿るので含めない)。 */
export const RULER_CHANGE_MASK = RULER_KINDS.filter((d) => d.kind !== "find").reduce((m, d) => m | d.bit, 0);

export function rulerKindBit(kind: RulerKind): number {
  return DEF_BY_KIND.get(kind)?.bit ?? 0;
}

/**
 * 表示位置 0..count-1 ごとのマスクを作る。`flags` には状態があるときだけ判定関数を渡す
 * (空の状態は走査しない)。戻り値は帯が不要 (全行が 0) のとき null。
 */
export function buildRowMasks(
  count: number,
  flags: Partial<Record<RulerKind, (visPos: number) => boolean>>,
): Uint8Array | null {
  const active = RULER_KINDS.filter((d) => flags[d.kind] !== undefined);
  if (count <= 0 || active.length === 0) return null;
  const masks = new Uint8Array(count);
  let any = false;
  for (const d of active) {
    const fn = flags[d.kind];
    if (!fn) continue;
    for (let i = 0; i < count; i++) {
      if (fn(i)) {
        masks[i] |= d.bit;
        any = true;
      }
    }
  }
  return any ? masks : null;
}

/** 行位置 → 帯の高さ `heightPx` 内のバケット (0 起点)。 */
export function bucketOf(row: number, count: number, heightPx: number): number {
  if (count <= 0 || heightPx <= 0) return 0;
  const b = Math.floor((row * heightPx) / count);
  return Math.min(Math.max(b, 0), Math.max(0, Math.floor(heightPx) - 1));
}

/** 帯の y 座標 → 表示位置 (範囲外は端へ丸める)。 */
export function yToRow(y: number, count: number, heightPx: number): number {
  if (count <= 0 || heightPx <= 0) return 0;
  const r = Math.floor((y / heightPx) * count);
  return Math.min(Math.max(r, 0), count - 1);
}

/** 表示位置の範囲 [first, last] が帯の上で占める y と高さ。 */
export function rowSpanToY(
  first: number,
  last: number,
  count: number,
  heightPx: number,
): { y: number; h: number } {
  if (count <= 0) return { y: 0, h: 0 };
  const y = (first / count) * heightPx;
  const end = ((last + 1) / count) * heightPx;
  return { y, h: end - y };
}

export interface RulerTick {
  kind: RulerKind;
  /** 帯の上端からの y (px) と高さ (最小高さ適用済み)。 */
  y: number;
  h: number;
  /** この連なりの中でその種別を持つ行数と、最初/最後の行 (表示位置)。 */
  count: number;
  firstRow: number;
  lastRow: number;
}

function laneKindOf(mask: number, lane: RulerLane): RulerKindDef | null {
  let best: RulerKindDef | null = null;
  for (const d of RULER_KINDS) {
    if (d.lane !== lane || (mask & d.bit) === 0) continue;
    if (!best || d.priority > best.priority) best = d;
  }
  return best;
}

/**
 * マスク列を帯の高さへ圧縮してレーンごとのティック列にする。1 ピクセルのバケットに複数行が
 * 入るときは、そのレーンで最優先の種別を採り、隣り合うバケットで同じ種別なら 1 本に連結する
 * (描画するパスの数を高さに比例させない)。計算量は O(行数)。
 */
export function computeRulerTicks(masks: Uint8Array, heightPx: number, minTickPx: number): RulerTick[][] {
  const lanes: RulerTick[][] = Array.from({ length: RULER_LANE_COUNT }, () => []);
  const count = masks.length;
  const buckets = Math.floor(heightPx);
  if (count === 0 || buckets <= 0) return lanes;

  // 行数が帯の高さ以下: 1 行が複数ピクセルを占める。連続する同じ種別の行を 1 本にまとめて正確な高さで描く。
  if (count <= buckets) {
    const rowH = heightPx / count;
    for (let lane = 0 as RulerLane; lane < RULER_LANE_COUNT; lane = (lane + 1) as RulerLane) {
      const out = lanes[lane];
      let cur: RulerTick | null = null;
      for (let i = 0; i < count; i++) {
        const def = laneKindOf(masks[i], lane);
        if (def && cur && cur.kind === def.kind && cur.lastRow === i - 1) {
          cur.lastRow = i;
          cur.count += 1;
          cur.h = Math.max((i + 1) * rowH - cur.y, minTickPx);
        } else if (def) {
          cur = {
            kind: def.kind,
            y: i * rowH,
            h: Math.max(rowH, minTickPx),
            count: 1,
            firstRow: i,
            lastRow: i,
          };
          out.push(cur);
        } else {
          cur = null;
        }
      }
    }
    return lanes;
  }

  for (let lane = 0 as RulerLane; lane < RULER_LANE_COUNT; lane = (lane + 1) as RulerLane) {
    const out = lanes[lane];
    // 現在のバケットの集計。
    let curBucket = -1;
    let curDef: RulerKindDef | null = null;
    let curCount = 0;
    let curFirst = 0;
    let curLast = 0;
    // 連結中のティック (バケット単位の連なり)。
    let run: {
      def: RulerKindDef;
      b0: number;
      b1: number;
      count: number;
      first: number;
      last: number;
    } | null = null;

    const flushBucket = () => {
      if (curDef === null) return;
      if (run && run.def.kind === curDef.kind && run.b1 + 1 >= curBucket) {
        run.b1 = curBucket;
        run.count += curCount;
        run.last = curLast;
      } else {
        if (run) pushRun(out, run, minTickPx);
        run = {
          def: curDef,
          b0: curBucket,
          b1: curBucket,
          count: curCount,
          first: curFirst,
          last: curLast,
        };
      }
    };

    for (let i = 0; i < count; i++) {
      const def = laneKindOf(masks[i], lane);
      const b = bucketOf(i, count, buckets);
      if (b !== curBucket) {
        flushBucket();
        curBucket = b;
        curDef = null;
        curCount = 0;
      }
      if (!def) continue;
      if (curDef === null) {
        curFirst = i;
        curDef = def;
      } else if (def.priority > curDef.priority) {
        curDef = def;
      }
      curCount += 1;
      curLast = i;
    }
    flushBucket();
    if (run) pushRun(out, run, minTickPx);
  }
  return lanes;
}

function pushRun(
  out: RulerTick[],
  run: { def: RulerKindDef; b0: number; b1: number; count: number; first: number; last: number },
  minTickPx: number,
) {
  const h = run.b1 - run.b0 + 1;
  out.push({
    kind: run.def.kind,
    y: run.b0,
    h: Math.max(h, minTickPx),
    count: run.count,
    firstRow: run.first,
    lastRow: run.last,
  });
}

/** y 付近 (±`tolerancePx`) にあるそのレーンのティック。重なれば中心が最も近いもの。 */
export function hitTestRuler(
  lanes: RulerTick[][],
  lane: number,
  y: number,
  tolerancePx: number,
): RulerTick | null {
  const ticks = lanes[lane];
  if (!ticks) return null;
  let best: RulerTick | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of ticks) {
    if (y < t.y - tolerancePx || y > t.y + t.h + tolerancePx) continue;
    const dist = Math.abs(y - (t.y + t.h / 2));
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best;
}

/** 帯の x → レーン番号。 */
export function laneAtX(x: number, widthPx: number): RulerLane {
  if (widthPx <= 0) return 0;
  const l = Math.floor((x / widthPx) * RULER_LANE_COUNT);
  return Math.min(Math.max(l, 0), RULER_LANE_COUNT - 1) as RulerLane;
}

/**
 * `from` から `dir` 方向へ、`kindMask` のいずれかを持つ次の行 (表示位置) を返す。端で折り返す。
 * 該当が無ければ null。`from` 自身は含めない (該当が `from` だけなら `from` を返す)。
 */
export function nextMarkedRow(masks: Uint8Array, from: number, dir: 1 | -1, kindMask: number): number | null {
  const n = masks.length;
  if (n === 0) return null;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if ((masks[i] & kindMask) !== 0) return i;
  }
  return null;
}
